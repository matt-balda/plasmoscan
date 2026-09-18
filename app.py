import base64
import json
import os
import threading

import cv2
import numpy as np
from flask import Flask, jsonify, render_template, request
from werkzeug.utils import secure_filename

import class_contract
import db
import inference

BASE_DIR = os.path.dirname(os.path.abspath(__file__))
SAMPLES_DIR = os.path.join(BASE_DIR, "static", "samples")
MANIFEST_PATH = os.path.join(SAMPLES_DIR, "manifest.json")
UPLOADS_DIR = os.path.join(BASE_DIR, "static", "uploads")
MAX_BATCH_FILES = 300

app = Flask(__name__)
# 300MB: um lote (pasta) pode conter dezenas de fotos de microscopia.
app.config["MAX_CONTENT_LENGTH"] = 300 * 1024 * 1024

os.makedirs(UPLOADS_DIR, exist_ok=True)
db.init_db()

# Serializa acesso ao modelo: o stand pode ter o modo câmera ao vivo enviando
# frames continuamente enquanto outra pessoa também está usando a demo, e um
# modelo ultralytics/torch não é garantido thread-safe sob chamadas concorrentes.
_inference_lock = threading.Lock()

print(f"[malaria-detection] carregando modelo em device={inference.get_device()} ...")
inference.warmup()
print("[malaria-detection] warm-up concluído, servidor pronto.")


def _decode_image_from_bytes(raw_bytes):
    arr = np.frombuffer(raw_bytes, dtype=np.uint8)
    img = cv2.imdecode(arr, cv2.IMREAD_COLOR)
    return img


def _extract_image_from_request():
    """Retorna (image_bgr, error_message). Exatamente um dos dois é None."""
    if "image" in request.files:
        file = request.files["image"]
        if file.filename == "":
            return None, "Arquivo de imagem vazio."
        raw = file.read()
        if not raw:
            return None, "Arquivo de imagem vazio."
        img = _decode_image_from_bytes(raw)
        if img is None:
            return None, "Não foi possível decodificar a imagem enviada."
        return img, None

    payload = request.get_json(silent=True)
    if payload and "image_base64" in payload:
        data_uri = payload["image_base64"]
        if not data_uri:
            return None, "Campo image_base64 está vazio."
        b64_part = data_uri
        if "," in data_uri and data_uri.strip().startswith("data:"):
            b64_part = data_uri.split(",", 1)[1]
        try:
            raw = base64.b64decode(b64_part, validate=False)
        except (ValueError, TypeError):
            return None, "Base64 inválido em image_base64."
        if not raw:
            return None, "Base64 decodificado resultou em conteúdo vazio."
        img = _decode_image_from_bytes(raw)
        if img is None:
            return None, "Não foi possível decodificar a imagem enviada (base64)."
        return img, None

    return None, "Nenhuma imagem enviada (use o campo 'image' multipart ou 'image_base64' no JSON)."


def _extract_conf():
    raw_conf = request.form.get("conf") or request.args.get("conf")
    if raw_conf is None:
        payload = request.get_json(silent=True)
        if payload and "conf" in payload:
            raw_conf = payload["conf"]
    if raw_conf is None:
        return inference.DEFAULT_CONF, None
    try:
        conf = float(raw_conf)
    except (TypeError, ValueError):
        return None, "Parâmetro 'conf' inválido, deve ser numérico."
    if not (0.0 <= conf <= 1.0):
        return None, "Parâmetro 'conf' deve estar entre 0 e 1."
    return conf, None


@app.route("/")
def index():
    return render_template("index.html")


@app.route("/samples")
def samples():
    if not os.path.isfile(MANIFEST_PATH):
        return jsonify({"samples": []})

    try:
        with open(MANIFEST_PATH, "r", encoding="utf-8") as f:
            manifest = json.load(f)
    except (OSError, json.JSONDecodeError):
        return jsonify({"samples": []})

    if not isinstance(manifest, list):
        return jsonify({"samples": []})

    out = []
    for entry in manifest:
        if not isinstance(entry, dict) or "file" not in entry:
            continue
        file_name = entry["file"]
        sample_id = os.path.splitext(file_name)[0]
        out.append(
            {
                "id": sample_id,
                "url": f"/static/samples/{file_name}",
                "caption": entry.get("caption_pt", ""),
            }
        )

    return jsonify({"samples": out})


@app.route("/predict", methods=["POST"])
def predict():
    image_bgr, err = _extract_image_from_request()
    if err is not None:
        return jsonify({"ok": False, "error": err}), 400

    conf, err = _extract_conf()
    if err is not None:
        return jsonify({"ok": False, "error": err}), 400

    try:
        with _inference_lock:
            result = inference.run_inference(image_bgr, conf=conf)
    except Exception as exc:  # falha de inferência não deve derrubar o servidor
        return jsonify({"ok": False, "error": f"Falha na inferência: {exc}"}), 400

    result["ok"] = True
    return jsonify(result)


# ---------------------------------------------------------------------------
# Fluxo de LOTE: upload de uma pasta com várias lâminas, anotação do
# especialista (opcional), detecção do modelo e relatório agregado.
# ---------------------------------------------------------------------------


@app.route("/api/batches", methods=["POST"])
def create_batch():
    batch_id = db.create_batch()
    return jsonify({"ok": True, "batch_id": batch_id})


@app.route("/api/batches/<int:batch_id>/slides", methods=["POST"])
def upload_batch_slides(batch_id):
    if not db.batch_exists(batch_id):
        return jsonify({"ok": False, "error": "Lote não encontrado."}), 404

    files = request.files.getlist("images")
    if not files:
        return jsonify({"ok": False, "error": "Nenhum arquivo de imagem enviado."}), 400
    if len(files) > MAX_BATCH_FILES:
        return jsonify({"ok": False, "error": f"Muitos arquivos no lote (máximo {MAX_BATCH_FILES})."}), 400

    batch_dir = os.path.join(UPLOADS_DIR, str(batch_id))
    os.makedirs(batch_dir, exist_ok=True)

    slides_out = []
    skipped = 0
    order_index = 0

    for file in files:
        raw = file.read() if file.filename else b""
        img = _decode_image_from_bytes(raw) if raw else None
        if img is None:
            skipped += 1
            continue

        height, width = img.shape[:2]
        # Navegadores enviam webkitRelativePath (ex.: "pasta/lamina.jpg") como
        # filename para uploads via seletor de pasta — mantém só o nome do
        # arquivo em si, tanto no disco quanto no que é exibido ao usuário.
        display_name = os.path.basename(file.filename)
        safe_name = secure_filename(display_name) or "lamina.jpg"
        stored_name = f"{order_index:04d}_{safe_name}"
        with open(os.path.join(batch_dir, stored_name), "wb") as f:
            f.write(raw)

        rel_path = f"uploads/{batch_id}/{stored_name}"
        slide_id = db.add_slide(batch_id, order_index, display_name, rel_path, width, height)
        slides_out.append({
            "id": slide_id,
            "order_index": order_index,
            "filename": display_name,
            "url": f"/static/{rel_path}",
        })
        order_index += 1

    if not slides_out:
        return jsonify({"ok": False, "error": "Nenhuma imagem válida encontrada nos arquivos enviados."}), 400

    return jsonify({"ok": True, "batch_id": batch_id, "slides": slides_out, "skipped": skipped})


@app.route("/api/slides/<int:slide_id>/annotations", methods=["GET"])
def get_slide_annotations(slide_id):
    slide = db.get_slide(slide_id)
    if slide is None:
        return jsonify({"ok": False, "error": "Lâmina não encontrada."}), 404
    return jsonify({"ok": True, "boxes": db.get_annotations(slide_id)})


@app.route("/api/slides/<int:slide_id>/annotations", methods=["POST"])
def save_slide_annotations(slide_id):
    slide = db.get_slide(slide_id)
    if slide is None:
        return jsonify({"ok": False, "error": "Lâmina não encontrada."}), 404

    payload = request.get_json(silent=True) or {}
    boxes = payload.get("boxes")
    if not isinstance(boxes, list):
        return jsonify({"ok": False, "error": "Campo 'boxes' deve ser uma lista."}), 400

    cleaned = []
    for b in boxes:
        if not isinstance(b, dict):
            continue
        class_name = b.get("class_name")
        box = b.get("box")
        if class_name not in class_contract.CLASS_NAMES:
            continue
        if not (isinstance(box, list) and len(box) == 4 and all(isinstance(v, (int, float)) for v in box)):
            continue
        cleaned.append({"class_name": class_name, "box": [float(v) for v in box]})

    db.save_annotations(slide_id, cleaned)

    counts = {name: 0 for name in class_contract.CLASS_NAMES}
    for b in cleaned:
        counts[b["class_name"]] += 1
    rbc = counts[class_contract.RBC_CLASS]
    infected = sum(counts[c] for c in class_contract.INFECTED_CLASSES)
    rate = round(infected / rbc * 100, 2) if rbc > 0 else None

    return jsonify({"ok": True, "counts": counts, "infected_count": infected, "infection_rate_pct": rate})


@app.route("/api/slides/<int:slide_id>/predict", methods=["POST"])
def predict_slide(slide_id):
    slide = db.get_slide(slide_id)
    if slide is None:
        return jsonify({"ok": False, "error": "Lâmina não encontrada."}), 404

    conf, err = _extract_conf()
    if err is not None:
        return jsonify({"ok": False, "error": err}), 400

    disk_path = os.path.join(BASE_DIR, "static", slide["rel_path"])
    image_bgr = cv2.imread(disk_path)
    if image_bgr is None:
        return jsonify({"ok": False, "error": "Não foi possível ler a imagem da lâmina no servidor."}), 500

    try:
        with _inference_lock:
            result = inference.run_inference(image_bgr, conf=conf)
    except Exception as exc:  # falha de inferência não deve derrubar o servidor
        return jsonify({"ok": False, "error": f"Falha na inferência: {exc}"}), 400

    db.save_detections(slide_id, result["detections"], conf)

    result["ok"] = True
    return jsonify(result)


@app.route("/api/batches/<int:batch_id>/report")
def batch_report(batch_id):
    return jsonify({"ok": True, **db.compute_report(batch_id)})


@app.route("/health")
def health():
    return jsonify({"ok": True, "device": inference.get_device()})


if __name__ == "__main__":
    # 0.0.0.0 + $PORT: em nuvem (ex.: Hugging Face Spaces) o tráfego externo
    # chega numa porta escolhida pela plataforma, não em localhost:5000.
    port = int(os.environ.get("PORT", 5000))
    app.run(host="0.0.0.0", port=port, debug=False, use_reloader=False)
