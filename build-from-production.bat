@echo off
chcp 65001 >nul
setlocal enabledelayedexpansion

echo ===============================================
echo 检查本地更改...
echo ===============================================

REM 检查是否有未stage的更改
git diff --quiet
if errorlevel 1 (
    echo [错误] 本地有未提交的更改
    echo 请先提交所有更改后再试
    pause
    exit /b 1
)

REM 检查是否有未track的文件
git ls-files --others --exclude-standard | findstr . >nul
if not errorlevel 1 (
    echo [错误] 本地有未track的文件
    echo 请先提交所有文件后再试
    pause
    exit /b 1
)

REM 检查是否有未push的commit
for /f %%i in ('git rev-list @{u}..HEAD ^2^>nul') do (
    echo [错误] 本地有未推送的提交
    echo 请先推送所有更改后再试
    pause
    exit /b 1
)

echo [✓] 本地更改已全部commit和push

echo.
echo ===============================================
echo 连接到生产服务器...
echo ===============================================

ssh hk << 'EOFCOMMAND'
cd ~/production/cfpa-bot

echo [*] 更新代码...
cd CFPABot
git pull

echo [*] 编译镜像...
docker build -f "CFPABot/Dockerfile" -t docker.cyan.cafe/cfpabot .

echo [*] Push 镜像...
#docker image push docker.cyan.cafe/cfpabot:latest
cd ..

echo [*] 重启容器...
docker-compose pull
docker-compose down
docker-compose up -d

echo [✓] 生产环境更新完成！
EOFCOMMAND

if errorlevel 1 (
    echo [错误] 远程命令执行失败
    pause
    exit /b 1
)

echo.
echo ===============================================
echo [✓] 全流程完成！
echo ===============================================
pause
