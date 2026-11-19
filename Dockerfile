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

# Application files
COPY univerter_server.py univerter_fidelity.py ./
COPY Univerter.html Univerter-config.js Univerter-core.js Univerter-convert.js ./

EXPOSE 8765

# Bind to 0.0.0.0 so the host can reach the container
ENV UNIVERTER_HOST=0.0.0.0
CMD ["python", "univerter_server.py", "--host", "0.0.0.0", "--port", "8765"]
