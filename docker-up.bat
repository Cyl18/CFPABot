@echo off
docker-compose up -d --build
if %ERRORLEVEL% equ 0 (
    echo [OK] Container started: http://localhost:19003
) else (
    echo [ERROR] Failed to start container
    exit /b 1
)
