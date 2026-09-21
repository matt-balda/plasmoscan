# plasmoscan

## Como rodar

Dependências e ambiente virtual são gerenciados com [uv](https://docs.astral.sh/uv/).

```bash
uv sync
uv run python app.py
```

O servidor sobe em `http://localhost:5000` (ou na porta definida em `$PORT`).

## App mobile

Veja [app-mobile/](app-mobile/README.md) — app em React Native (Expo) com
câmera ao vivo, que consome esse mesmo backend Flask.
