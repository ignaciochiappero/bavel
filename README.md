<img width="960" height="540" src="https://storage.googleapis.com/experiments-uploads/gemma-translator/gemma-translator.gif" />

# Bavel

A fully local, offline voice translator: **Moonshine** STT + **Gemma 4** translation (via **LiteRT-LM**) + moonshine-voice TTS, running entirely on your machine — no cloud, no API keys, no internet after setup.

Built on [google-gemma/gemma-translator](https://github.com/google-gemma/gemma-translator), this fork adds:

- **Live tab listening** — capture a browser tab's audio (e.g. a Google Meet call) and translate or transcribe it in real time
- **Streaming transcription mode** — subtitle-style text that appears while the speaker talks (incremental Moonshine streams, ~1s cadence)
- **Persistent conversation sessions** — every utterance stays on screen, saved to SQLite and reloadable later
- **Docker packaging** — one command on Windows/macOS/Linux

## Quick start (Docker — recommended)

| Step | What |
| :--- | :--- |
| 1 | Install [Docker Desktop](https://www.docker.com/products/docker-desktop/) (WSL2 backend on Windows). Assign **≥ 8 GB of RAM** in Settings → Resources. |
| 2 | `docker compose up -d --build` — on Windows you can double-click `run.bat` instead. |
| 3 | Open **http://localhost:3000** |

The first run downloads the model (~5 GB, once). It is stored in a Docker volume (`translator-data`) and survives rebuilds and restarts.

**Verify it works:** the page shows the `BAVEL` header with `Traducción | Transcripción` mode buttons.

### Useful commands

```bash
docker compose logs -f    # watch logs
docker compose stop       # stop (model stays on disk)
docker compose down       # remove container (volume intact)
docker compose up -d      # start again (instant, model cached)
docker compose down -v    # DANGER: also deletes the model + saved sessions
```

## How to use it

### Two processing modes

| Mode | What it does | Best for |
| :--- | :--- | :--- |
| **Traducción** | Transcribes speech and translates it into the other lane's language, with optional voice output | Conversations between two languages |
| **Transcripción** | Streaming live transcription — text appears while the person talks, subtitle-style (only STT, no translation, no voice) | Following a single speaker (e.g. a meeting) |

Switch modes anytime with the segmented control in the bottom bar.

### Listening to a tab (e.g. a Meet call)

1. Press **T** (or click **▶ Escuchar pestaña**)
2. Pick the tab you want to hear in Chrome's picker
3. **Space** selects which lane is the source language, **← →** rotate languages
4. In **Transcripción** mode each utterance streams into a live bubble (blinking caret) and commits on silence; in **Traducción** mode chunks are translated continuously

Tab audio comes from whatever the tab plays — you hear the other side of the call, not your own microphone. Use headphones to avoid echo.

### Keyboard shortcuts

**Landscape mode (default)** — one active person (corner brackets):

| Key | Action |
| :--- | :--- |
| **Space** | Switch active person |
| **Z** (hold) | Push-to-talk — release to transcribe & translate |
| **T** | Start / stop tab listening |
| **← / →** | Rotate the active person's language |

**Vertical mode** (two-hand, via Settings ⚙ → Keyboard Mode):

| Key | Action |
| :--- | :--- |
| **Z / X** (hold) | Push-to-talk — Person 1 / Person 2 |
| **← / →** | Rotate Person 1's language |
| **− / +** | Rotate Person 2's language |
| **T** | Start / stop tab listening |

Shortcuts are ignored while typing in a settings field; language rotation is locked while recording.

### Conversation sessions

- The transcript panel keeps **everything** on screen during the call
- **Guardar** — saves the whole conversation as a session (SQLite)
- **Historial** — lists saved sessions; click one to reload it
- **Nueva charla** — clears the panel and starts fresh
- Sessions live in `~/.gemma-translator/sessions.db` (inside the Docker volume when using containers)

## Manual setup (Linux / macOS)

Requires Python 3.12+ (numpy 2.5 has no older wheels), Node.js 18+.

```bash
chmod +x setup.sh download_model.sh start.sh deploy-pi.sh
./setup.sh           # venv + Python dependencies
./download_model.sh  # ~5 GB LiteRT model from Hugging Face
./start.sh           # dev mode: UI on http://localhost:5173
./start.sh --prod    # production: everything on http://localhost:3000
```

## Raspberry Pi appliance

Target hardware: **Raspberry Pi 5 (8 GB)** + microphone + speaker + small display.

```bash
./deploy-pi.sh
```

Installs OS packages, sets up the environment, downloads the model, registers a systemd service, and configures a Chromium kiosk pointing at `http://localhost:3000`. 3D-printable case files are in `stl/`.

## API

| Endpoint | Purpose |
| :--- | :--- |
| `POST /api/stt` | One-shot transcription (base64 float32 16 kHz PCM) |
| `POST /api/stt/stream/start` | Open a streaming transcription session |
| `POST /api/stt/stream/append` | Feed audio, get back the partial transcript |
| `POST /api/stt/stream/stop` | Close the stream, get the final transcript |
| `GET /api/tts?text=…&lang=…` | Text-to-speech (WAV) |
| `GET/POST /api/sessions` | List / create saved sessions |
| `GET /api/sessions/<id>/messages` | Load a session's messages |
| `POST /proxy?url=…` | LLM proxy (restricted to `localhost:9379`) |

## Troubleshooting

| Symptom | Fix |
| :--- | :--- |
| Page is blank after an update | Hard refresh (Ctrl+Shift+R) |
| Slow translations / STT in Docker | Docker Desktop → Settings → Resources → **8 GB RAM minimum** |
| Port 3000 already in use | Stop the other service or change the mapping in `docker-compose.yml` |
| Microphone doesn't work in WSL2 | Mic pass-through needs [usbipd-win](https://github.com/dorssel/usbipd-win); tab listening doesn't need a mic |
| Model re-downloads every rebuild | Volume `translator-data` was removed (don't use `down -v`) |
| Hugging Face download is slow | Set a `HF_TOKEN` env var to lift anonymous rate limits |

## Project structure

```
├── backend/          # Python API server: Moonshine STT/TTS, sessions (SQLite), LLM proxy
├── frontend/         # React (Vite) web UI
├── docker/           # Dockerfile + container entrypoint
├── deploy/           # systemd service template (Raspberry Pi)
├── stl/              # 3D-printable case files
├── docker-compose.yml   # One-command container setup (recommended)
├── run.bat              # Windows launcher (starts Docker Desktop if needed)
├── setup.sh / download_model.sh / start.sh   # native Linux/macOS flow
└── deploy-pi.sh         # Raspberry Pi appliance bootstrap
```

## Credits

Fork of [google-gemma/gemma-translator](https://github.com/google-gemma/gemma-translator), made by a small team at [Google Creative Lab](https://github.com/googlecreativelab): [Alan Yam](https://github.com/alanvww), [Shashwath Santosh](https://x.com/shashwth), [Dan Motzenbecker](https://github.com/dmotz). The streaming transcription, tab listening, session persistence, and Docker packaging were added on top as **Bavel**.

## Disclaimer

This is not an officially supported Google product. This project is not eligible for the [Google Open Source Software Vulnerability Rewards Program](https://bughunters.google.com/open-source-security).
