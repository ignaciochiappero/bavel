# Bavel — one-command Windows launcher
# Requires Docker Desktop (https://www.docker.com/products/docker-desktop/)
# Docker Desktop must have at least 8GB of memory assigned (Settings -> Resources).

@echo off
setlocal

docker info >nul 2>&1
if errorlevel 1 (
    echo Starting Docker Desktop...
    start "" "C:\Program Files\Docker\Docker\Docker Desktop.exe"
    echo Waiting for the Docker engine...
    :waitloop
    timeout /t 3 /nobreak >nul
    docker info >nul 2>&1
    if errorlevel 1 goto waitloop
)

echo Building and starting the translator container (first build takes a few minutes)...
docker compose up -d --build

echo Opening http://localhost:3000 ...
timeout /t 3 /nobreak >nul
start http://localhost:3000

endlocal
