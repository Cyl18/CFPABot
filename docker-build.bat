@echo off
docker build -t cfpabot .
if %ERRORLEVEL% equ 0 (
    echo [OK] Build complete: cfpabot:latest
) else (
    echo [ERROR] Build failed
    exit /b 1
)
