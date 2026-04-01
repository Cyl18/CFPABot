@echo off
setlocal enabledelayedexpansion

echo ===============================================
echo Checking local changes...
echo ===============================================

REM Check for unstaged changes
git diff --quiet
if errorlevel 1 (
    echo [ERROR] There are uncommitted local changes
    echo Please commit all changes before retrying
    pause
    exit /b 1
)

REM Check for untracked files
git ls-files --others --exclude-standard | findstr . >nul
if not errorlevel 1 (
    echo [ERROR] There are untracked local files
    echo Please commit all files before retrying
    pause
    exit /b 1
)

REM Check for unpushed commits
for /f %%i in ('git rev-list @{u}..HEAD ^2^>nul') do (
    echo [ERROR] There are unpushed local commits
    echo Please push all changes before retrying
    pause
    exit /b 1
)

echo [OK] All local changes have been committed and pushed

echo.
echo ===============================================
echo Connecting to production server...
echo ===============================================

ssh hk "cd ~/production/cfpa-bot && echo [*] Pulling code... && cd CFPABot && git pull && echo [*] Building image... && docker build -f CFPABot/Dockerfile -t docker.cyan.cafe/cfpabot . && echo [*] Pushing image... && cd .. && echo [*] Restarting containers... && docker-compose pull && docker-compose down && docker-compose up -d && echo [OK] Production update complete!"

if errorlevel 1 (
    echo [ERROR] Remote command failed
    pause
    exit /b 1
)

echo.
echo ===============================================
echo [OK] All done!
echo ===============================================
pause
