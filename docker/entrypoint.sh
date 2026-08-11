#!/bin/sh
# Gemma Translator container entrypoint.
# Downloads the LiteRT model on first run, then starts litert-lm + backend.

set -e

MODEL_NAME="gemma4-e2b"
HF_REPO="litert-community/gemma-4-E2B-it-litert-lm"
MODEL_FILE="gemma-4-E2B-it.litertlm"

if ! litert-lm list 2>/dev/null | awk -v m="$MODEL_NAME" '$1 == m { found = 1 } END { exit !found }'; then
    echo "[entrypoint] Model '$MODEL_NAME' not found — downloading from Hugging Face (first run, ~5GB)..."
    litert-lm import --from-huggingface-repo "$HF_REPO" "$MODEL_FILE" "$MODEL_NAME"
fi

echo "[entrypoint] Starting litert-lm..."
litert-lm serve &
LITERT_PID=$!

echo "[entrypoint] Waiting for litert-lm on port 9379..."
READY=0
for i in $(seq 1 180); do
    if python3 -c "import socket; s=socket.socket(); s.settimeout(1); s.connect(('127.0.0.1', 9379)); s.close()" 2>/dev/null; then
        READY=1
        break
    fi
    if ! kill -0 "$LITERT_PID" 2>/dev/null; then
        echo "[entrypoint] litert-lm process died. Exiting."
        exit 1
    fi
    sleep 1
done

if [ "$READY" -ne 1 ]; then
    echo "[entrypoint] litert-lm did not become ready within 180s. Exiting."
    exit 1
fi
echo "[entrypoint] litert-lm ready."

echo "[entrypoint] Starting backend server on port 3000..."
python3 backend/server.py &
API_PID=$!

trap 'echo "[entrypoint] Shutting down..."; kill $LITERT_PID $API_PID 2>/dev/null' INT TERM
wait
