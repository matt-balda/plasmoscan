"""Nomes de classe e contrato fixo (usado por inference.py e db.py) —
mantido em um único lugar para as duas camadas nunca divergirem."""

# Ordem fixa exigida pelo contrato (independe da ordem que vier de model.names).
CLASS_NAMES = [
    "red blood cell",
    "trophozoite",
    "schizont",
    "difficult",
    "ring",
    "leukocyte",
    "gametocyte",
]

INFECTED_CLASSES = {"trophozoite", "ring", "schizont", "gametocyte"}
RBC_CLASS = "red blood cell"
