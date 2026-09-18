"""Persistência em SQLite dos lotes de lâminas: upload, detecção da IA
(proposta), correção do especialista sobre essa proposta (vira o gabarito) e
o relatório agregado do lote, medindo o desempenho da IA contra o gabarito."""

import os
import sqlite3
import threading
from datetime import datetime, timezone

from class_contract import CLASS_NAMES, INFECTED_CLASSES, RBC_CLASS

BASE_DIR = os.path.dirname(os.path.abspath(__file__))
DB_PATH = os.path.join(BASE_DIR, "malaria_batches.db")

# sqlite3 permite um writer por vez; serializa para evitar "database is locked"
# quando duas requisições (ex.: upload de lote + predict de outra lâmina) colidem.
_write_lock = threading.Lock()


def _connect():
    conn = sqlite3.connect(DB_PATH)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA foreign_keys = ON")
    return conn


def _now_iso():
    return datetime.now(timezone.utc).isoformat()


def init_db():
    with _connect() as conn:
        conn.executescript(
            """
            CREATE TABLE IF NOT EXISTS batches (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                created_at TEXT NOT NULL
            );

            CREATE TABLE IF NOT EXISTS slides (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                batch_id INTEGER NOT NULL REFERENCES batches(id),
                order_index INTEGER NOT NULL,
                filename TEXT NOT NULL,
                rel_path TEXT NOT NULL,
                width INTEGER NOT NULL,
                height INTEGER NOT NULL,
                annotation_done INTEGER NOT NULL DEFAULT 0,
                detection_done INTEGER NOT NULL DEFAULT 0,
                created_at TEXT NOT NULL
            );

            CREATE TABLE IF NOT EXISTS annotations (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                slide_id INTEGER NOT NULL REFERENCES slides(id),
                class_name TEXT NOT NULL,
                x1 REAL NOT NULL, y1 REAL NOT NULL, x2 REAL NOT NULL, y2 REAL NOT NULL
            );

            CREATE TABLE IF NOT EXISTS detections (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                slide_id INTEGER NOT NULL REFERENCES slides(id),
                class_name TEXT NOT NULL,
                confidence REAL NOT NULL,
                x1 REAL NOT NULL, y1 REAL NOT NULL, x2 REAL NOT NULL, y2 REAL NOT NULL,
                conf_threshold REAL NOT NULL
            );

            CREATE INDEX IF NOT EXISTS idx_slides_batch ON slides(batch_id);
            CREATE INDEX IF NOT EXISTS idx_annotations_slide ON annotations(slide_id);
            CREATE INDEX IF NOT EXISTS idx_detections_slide ON detections(slide_id);
            """
        )


def create_batch():
    with _write_lock, _connect() as conn:
        cur = conn.execute("INSERT INTO batches (created_at) VALUES (?)", (_now_iso(),))
        return cur.lastrowid


def add_slide(batch_id, order_index, filename, rel_path, width, height):
    with _write_lock, _connect() as conn:
        cur = conn.execute(
            "INSERT INTO slides (batch_id, order_index, filename, rel_path, width, height, created_at) "
            "VALUES (?, ?, ?, ?, ?, ?, ?)",
            (batch_id, order_index, filename, rel_path, width, height, _now_iso()),
        )
        return cur.lastrowid


def batch_exists(batch_id):
    with _connect() as conn:
        row = conn.execute("SELECT 1 FROM batches WHERE id = ?", (batch_id,)).fetchone()
    return row is not None


def get_slide(slide_id):
    with _connect() as conn:
        row = conn.execute("SELECT * FROM slides WHERE id = ?", (slide_id,)).fetchone()
    return dict(row) if row else None


def save_annotations(slide_id, boxes):
    """boxes: lista de {"class_name": str, "box": [x1, y1, x2, y2]}.
    Substitui integralmente as anotações anteriores da lâmina."""
    with _write_lock, _connect() as conn:
        conn.execute("DELETE FROM annotations WHERE slide_id = ?", (slide_id,))
        conn.executemany(
            "INSERT INTO annotations (slide_id, class_name, x1, y1, x2, y2) VALUES (?, ?, ?, ?, ?, ?)",
            [
                (slide_id, b["class_name"], b["box"][0], b["box"][1], b["box"][2], b["box"][3])
                for b in boxes
            ],
        )
        conn.execute("UPDATE slides SET annotation_done = 1 WHERE id = ?", (slide_id,))


def get_annotations(slide_id):
    with _connect() as conn:
        rows = conn.execute(
            "SELECT class_name, x1, y1, x2, y2 FROM annotations WHERE slide_id = ?", (slide_id,)
        ).fetchall()
    return [{"class_name": r["class_name"], "box": [r["x1"], r["y1"], r["x2"], r["y2"]]} for r in rows]


def save_detections(slide_id, detections, conf_threshold):
    """detections: lista no formato retornado por inference.run_inference()["detections"].
    Substitui integralmente a última rodada de detecção da lâmina."""
    with _write_lock, _connect() as conn:
        conn.execute("DELETE FROM detections WHERE slide_id = ?", (slide_id,))
        conn.executemany(
            "INSERT INTO detections (slide_id, class_name, confidence, x1, y1, x2, y2, conf_threshold) "
            "VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
            [
                (
                    slide_id,
                    d["class_name"],
                    d["confidence"],
                    d["box"][0], d["box"][1], d["box"][2], d["box"][3],
                    conf_threshold,
                )
                for d in detections
            ],
        )
        conn.execute("UPDATE slides SET detection_done = 1 WHERE id = ?", (slide_id,))


def _summary_from_counts(counts):
    rbc = counts[RBC_CLASS]
    infected = sum(counts[c] for c in INFECTED_CLASSES)
    rate = round(infected / rbc * 100, 2) if rbc > 0 else None
    return {"counts": counts, "rbc_count": rbc, "infected_count": infected, "infection_rate_pct": rate}


def _summary_from_boxes(boxes):
    counts = {name: 0 for name in CLASS_NAMES}
    for b in boxes:
        if b["class_name"] in counts:
            counts[b["class_name"]] += 1
    return _summary_from_counts(counts)


# A IA não compete com o especialista: ela propõe, o especialista corrige, e o
# resultado corrigido vira o gabarito da lâmina. Esta é a métrica que sobra —
# quão perto a proposta original da IA chegou do gabarito final — casando cada
# detecção da IA com a anotação do especialista de mesma classe mais próxima
# (IoU) em vez de comparar duas taxas de infecção independentes.
IOU_MATCH_THRESHOLD = 0.3


def _iou(box_a, box_b):
    ax1, ay1, ax2, ay2 = box_a
    bx1, by1, bx2, by2 = box_b
    ix1, iy1 = max(ax1, bx1), max(ay1, by1)
    ix2, iy2 = min(ax2, bx2), min(ay2, by2)
    iw, ih = max(0.0, ix2 - ix1), max(0.0, iy2 - iy1)
    inter = iw * ih
    if inter <= 0:
        return 0.0
    area_a = max(0.0, ax2 - ax1) * max(0.0, ay2 - ay1)
    area_b = max(0.0, bx2 - bx1) * max(0.0, by2 - by1)
    union = area_a + area_b - inter
    return inter / union if union > 0 else 0.0


def _match_ai_to_ground_truth(detections, ground_truth):
    """Casa gulosamente cada detecção da IA com a melhor anotação do
    especialista ainda livre, da mesma classe e com IoU >= limiar.
    Retorna (tp, fp, fn) para a lâmina."""
    unmatched_gt = list(range(len(ground_truth)))
    tp = 0
    for det in detections:
        best_idx, best_iou = None, IOU_MATCH_THRESHOLD
        for idx in unmatched_gt:
            gt = ground_truth[idx]
            if gt["class_name"] != det["class_name"]:
                continue
            score = _iou(det["box"], gt["box"])
            if score >= best_iou:
                best_iou, best_idx = score, idx
        if best_idx is not None:
            tp += 1
            unmatched_gt.remove(best_idx)
    fp = len(detections) - tp
    fn = len(unmatched_gt)
    return tp, fp, fn


def _precision_recall_f1(tp, fp, fn):
    precision = round(tp / (tp + fp) * 100, 2) if (tp + fp) > 0 else None
    recall = round(tp / (tp + fn) * 100, 2) if (tp + fn) > 0 else None
    f1 = round(2 * precision * recall / (precision + recall), 2) if precision and recall else None
    return precision, recall, f1


def compute_report(batch_id):
    with _connect() as conn:
        slides = conn.execute(
            "SELECT * FROM slides WHERE batch_id = ? ORDER BY order_index", (batch_id,)
        ).fetchall()

        per_slide = []
        gt_rbc_total = gt_infected_total = gt_n = 0
        tp_total = fp_total = fn_total = ai_eval_n = 0

        for slide in slides:
            entry = {"slide_id": slide["id"], "filename": slide["filename"], "ground_truth": None, "ai": None}

            gt_boxes = None
            if slide["annotation_done"]:
                rows = conn.execute(
                    "SELECT class_name, x1, y1, x2, y2 FROM annotations WHERE slide_id = ?", (slide["id"],)
                ).fetchall()
                gt_boxes = [{"class_name": r["class_name"], "box": [r["x1"], r["y1"], r["x2"], r["y2"]]} for r in rows]
                summary = _summary_from_boxes(gt_boxes)
                entry["ground_truth"] = summary
                gt_rbc_total += summary["rbc_count"]
                gt_infected_total += summary["infected_count"]
                gt_n += 1

            if slide["detection_done"] and gt_boxes is not None:
                rows = conn.execute(
                    "SELECT class_name, x1, y1, x2, y2 FROM detections WHERE slide_id = ?", (slide["id"],)
                ).fetchall()
                ai_boxes = [{"class_name": r["class_name"], "box": [r["x1"], r["y1"], r["x2"], r["y2"]]} for r in rows]

                tp, fp, fn = _match_ai_to_ground_truth(ai_boxes, gt_boxes)
                precision, recall, f1 = _precision_recall_f1(tp, fp, fn)
                entry["ai"] = {
                    "tp": tp, "fp": fp, "fn": fn,
                    "precision_pct": precision, "recall_pct": recall, "f1_pct": f1,
                }
                tp_total += tp
                fp_total += fp
                fn_total += fn
                ai_eval_n += 1

            per_slide.append(entry)

    gt_rate = round(gt_infected_total / gt_rbc_total * 100, 2) if gt_rbc_total > 0 else None
    overall_precision, overall_recall, overall_f1 = _precision_recall_f1(tp_total, fp_total, fn_total)

    return {
        "batch_id": batch_id,
        "slides_count": len(slides),
        "ground_truth": {
            "slides_reviewed": gt_n,
            "rbc_count": gt_rbc_total,
            "infected_count": gt_infected_total,
            "infection_rate_pct": gt_rate,
        },
        "ai_performance": {
            "slides_evaluated": ai_eval_n,
            "tp": tp_total,
            "fp": fp_total,
            "fn": fn_total,
            "precision_pct": overall_precision,
            "recall_pct": overall_recall,
            "f1_pct": overall_f1,
        },
        "per_slide": per_slide,
    }
