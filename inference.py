"""Encapsula carregamento do modelo YOLOv8 e conversão dos resultados para o
formato JSON do contrato de API consumido pelo frontend."""

import os
import time

import numpy as np
import torch
from ultralytics import YOLO

from class_contract import CLASS_NAMES, INFECTED_CLASSES

BASE_DIR = os.path.dirname(os.path.abspath(__file__))
MODEL_PATH = os.path.join(BASE_DIR, "YOLOv8_best.pt")
IMGSZ = 640
IOU = 0.45
DEFAULT_CONF = 0.25

DEVICE = "cuda" if torch.cuda.is_available() else "cpu"

_model = YOLO(MODEL_PATH)
_model.to(DEVICE)


def warmup():
    """Roda uma inferência dummy para tirar o custo de inicialização da GPU
    (compilação de kernels cuDNN etc.) do primeiro clique real do usuário."""
    dummy = np.zeros((IMGSZ, IMGSZ, 3), dtype=np.uint8)
    _model.predict(dummy, imgsz=IMGSZ, conf=DEFAULT_CONF, iou=IOU, device=DEVICE, verbose=False)


def run_inference(image_bgr, conf=DEFAULT_CONF):
    """image_bgr: array numpy HxWx3 (BGR, como retornado pelo cv2.imdecode).

    Retorna dict já no formato exato de resposta de /predict, exceto pelas
    chaves "ok" (adicionada pela rota).
    """
    height, width = image_bgr.shape[:2]

    t0 = time.perf_counter()
    results = _model.predict(
        image_bgr,
        imgsz=IMGSZ,
        conf=conf,
        iou=IOU,
        device=DEVICE,
        verbose=False,
    )
    inference_ms = (time.perf_counter() - t0) * 1000.0

    counts = {name: 0 for name in CLASS_NAMES}
    detections = []

    result = results[0]
    boxes = result.boxes
    if boxes is not None and len(boxes) > 0:
        xyxy = boxes.xyxy.cpu().numpy()
        confs = boxes.conf.cpu().numpy()
        clss = boxes.cls.cpu().numpy().astype(int)

        for box, score, cls_id in zip(xyxy, confs, clss):
            class_name = CLASS_NAMES[cls_id]
            counts[class_name] += 1
            x1, y1, x2, y2 = box.tolist()
            detections.append(
                {
                    "class_id": int(cls_id),
                    "class_name": class_name,
                    "confidence": round(float(score), 4),
                    "box": [round(x1, 1), round(y1, 1), round(x2, 1), round(y2, 1)],
                }
            )

    infected_count = sum(counts[name] for name in INFECTED_CLASSES)
    rbc_count = counts["red blood cell"]
    infection_rate_pct = (
        round(infected_count / rbc_count * 100, 2) if rbc_count > 0 else None
    )

    return {
        "width": int(width),
        "height": int(height),
        "inference_ms": round(inference_ms, 2),
        "detections": detections,
        "counts": counts,
        "infected_count": int(infected_count),
        "infection_rate_pct": infection_rate_pct,
    }


def get_device():
    return DEVICE
