:: <#
@echo off
powershell -NoProfile -ExecutionPolicy Bypass -Command "Invoke-Expression ((Get-Content '%~f0' -Raw) -replace '(?s)^.*?#>\r?\n','')"
pause
exit /b
#>

$answer = Read-Host "Deploy to production? [Y/n]"
if ($answer -eq 'n' -or $answer -eq 'N') {
    Write-Host "Aborted."
    exit 0
}

Write-Host "==============================================="
Write-Host "Checking local changes..."
Write-Host "==============================================="

# Check for unstaged changes
git diff --quiet 2>&1 | Out-Null
if ($LASTEXITCODE -ne 0) {
    Write-Host "[ERROR] There are uncommitted local changes"
    Write-Host "Please commit all changes before retrying"
    exit 1
}

# Check for untracked files
$untracked = git ls-files --others --exclude-standard
if ($untracked) {
    Write-Host "[ERROR] There are untracked local files"
    Write-Host "Please commit all files before retrying"
    exit 1
}

# Check for unpushed commits
$unpushed = git rev-list "@{u}..HEAD" 2>$null
if ($unpushed) {
    git push
    if ($LASTEXITCODE -ne 0) {
        Write-Host "[ERROR] error while pushing"
        exit 1
    }
}

Write-Host "[OK] All local changes have been committed and pushed"

$currentBranch = git branch --show-current

Write-Host ""
Write-Host "==============================================="
Write-Host "Connecting to production server (Branch: $currentBranch)..."
Write-Host "==============================================="

$remoteCmd = "cd ~/production/cfpa-bot && " +
             "echo '[*] Pulling code...' && cd CFPABot && git fetch && git checkout $currentBranch && git pull && " +
             "echo '[*] Building image...' && docker build -f CFPABot/Dockerfile -t docker.cyan.cafe/cfpabot . && " +
             "echo '[*] Pushing image...' && cd .. && " +
             "echo '[*] Restarting containers...' && docker-compose down && docker-compose up -d && " +
             "echo '[OK] Production update complete!'"

ssh hk $remoteCmd

if ($LASTEXITCODE -ne 0) {
    Write-Host "[ERROR] Remote command failed"
    exit 1
}

Write-Host ""
Write-Host "==============================================="
Write-Host "[OK] All done!"
Write-Host "==============================================="

