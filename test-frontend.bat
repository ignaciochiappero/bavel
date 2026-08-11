@echo off
rem Bavel - run the frontend test suite (Vitest) in a node container.

docker run --rm -v "%~dp0frontend:/app" -w /app --entrypoint sh node:20-slim -c "npm ci --silent && npm test"

if errorlevel 1 (
    echo Frontend tests FAILED
    exit /b 1
)
echo Frontend tests passed
