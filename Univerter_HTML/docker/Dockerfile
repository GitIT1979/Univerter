# Univerter local engine — isolated in Docker
# Includes LibreOffice + pdf2docx + Indra OCR
FROM python:3.11-slim-bookworm

# System deps: LibreOffice + fonts + build tools for some Python packages
RUN apt-get update && apt-get install -y --no-install-recommends \
        libreoffice \
        libreoffice-writer \
        fonts-liberation \
        fonts-dejavu \
        fonts-carlito \
        fonts-caladea \
        ca-certificates \
        curl \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Python dependencies
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt \
    && pip install --no-cache-dir indra-ocr

# Раскладка как в репозитории: сервер ищет статику в ../web относительно себя
COPY server/ ./server/
COPY web/ ./web/

EXPOSE 8765

# Слушаем 0.0.0.0, чтобы контейнер был доступен с хоста
CMD ["python", "server/univerter_server.py", "--host", "0.0.0.0", "--port", "8765"]
