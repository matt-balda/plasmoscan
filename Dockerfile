FROM python:3.12-slim

# libglib2.0-0/libgomp1: dependências nativas usadas por opencv-python-headless
# e torch mesmo sem interface gráfica.
RUN apt-get update && apt-get install -y --no-install-recommends \
    libglib2.0-0 \
    libgomp1 \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Torch CPU-only primeiro: o índice padrão do PyPI traz build com CUDA (vários
# GB) mesmo quando não há GPU disponível, o que deixa a imagem enorme e o
# build lento à toa num Space sem GPU.
RUN pip install --no-cache-dir torch --index-url https://download.pytorch.org/whl/cpu

COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

COPY . .

# Hugging Face Spaces (SDK docker) direciona o tráfego externo para esta porta.
ENV PORT=7860
EXPOSE 7860

CMD ["python", "app.py"]
