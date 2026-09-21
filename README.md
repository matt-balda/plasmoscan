# PlasmoScan

## Como rodar

Dependências e ambiente virtual são gerenciados com [uv](https://docs.astral.sh/uv/).
O torch é instalado na variante CPU ou GPU (CUDA) automaticamente, dependendo
de a máquina ter uma GPU NVIDIA disponível:

```bash
./scripts/install.sh
uv run python app.py
```

O servidor sobe em `http://localhost:5000` (ou na porta definida em `$PORT`).