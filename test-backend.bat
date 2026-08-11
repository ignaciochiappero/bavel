@echo off
rem Bavel - run the backend test suite (pytest) inside the app container.
rem Requires the image to exist: docker compose build (or run.bat once).

docker run --rm -v "%~dp0backend:/app/backend" --entrypoint sh bavel -c "pip install -q pytest 2>nul; cd /app && python -m pytest backend/tests %*"

if errorlevel 1 (
    echo Backend tests FAILED
    exit /b 1
)
echo Backend tests passed
