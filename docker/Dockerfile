# Bavel — Docker image
# Multi-stage: builds the React frontend, then runs litert-lm + backend server.

# Stage 1: build the production frontend
FROM node:20-slim AS frontend-build
WORKDIR /app/frontend
COPY frontend/package.json frontend/package-lock.json ./
RUN npm ci
COPY frontend/ ./
RUN npm run build

# Stage 2: runtime (litert-lm + Moonshine STT/TTS + backend server)
# Python 3.12+ required: numpy==2.5.1 has no wheels for older Pythons.
FROM python:3.12-slim
WORKDIR /app
ENV PYTHONUNBUFFERED=1

# libasound2: PortAudio (sounddevice) — needed by moonshine-voice
# ffmpeg: audio codecs used by some moonshine-voice backends
RUN apt-get update && apt-get install -y --no-install-recommends \
    libasound2 \
    ffmpeg \
    && rm -rf /var/lib/apt/lists/*

COPY backend/requirements.txt backend/requirements.txt
RUN pip install --no-cache-dir -r backend/requirements.txt

COPY backend/ backend/
COPY --from=frontend-build /app/frontend/dist/ frontend/dist/

COPY docker/entrypoint.sh /entrypoint.sh
# Strip CR before making it executable: a Windows checkout with
# core.autocrlf=true turns the shebang into "#!/bin/sh\r", and the container
# then dies with the misleading "exec /entrypoint.sh: no such file or
# directory". .gitattributes prevents it at checkout; this makes the image
# build correctly even from a tree that slipped through.
RUN sed -i 's/\r$//' /entrypoint.sh && chmod +x /entrypoint.sh

EXPOSE 3000

ENTRYPOINT ["/entrypoint.sh"]
