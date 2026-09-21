#!/usr/bin/env bash
# Instala as dependências com `uv`, escolhendo automaticamente a variante de
# torch/torchvision certa para a máquina: GPU (CUDA) se houver uma GPU NVIDIA
# disponível, ou CPU-only caso contrário.
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/.."

if command -v nvidia-smi >/dev/null 2>&1 && nvidia-smi -L >/dev/null 2>&1; then
  echo "[install] GPU NVIDIA detectada, instalando com suporte a CUDA..."
  uv sync --extra gpu
else
  echo "[install] Nenhuma GPU NVIDIA detectada, instalando build CPU-only..."
  uv sync --extra cpu
fi
