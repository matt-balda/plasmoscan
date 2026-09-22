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

### macOS Intel (x86_64)

Funciona normalmente (CPU-only, sem GPU). O PyTorch descontinuou builds para
essa arquitetura a partir da versão 2.3, então o projeto trava torch/torchvision
em 2.2.2/0.17.2 especificamente nela — outras plataformas (Linux, Windows, Mac
Apple Silicon) não têm esse teto. Nada a configurar manualmente: `uv sync`
resolve a versão certa sozinho a partir da arquitetura da máquina.