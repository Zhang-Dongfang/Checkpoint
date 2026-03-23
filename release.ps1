# release.ps1
param([string]$Version = "")

$ErrorActionPreference = "Stop"

function log  { Write-Host "`n$args" -ForegroundColor White }
function ok   { Write-Host "  v $args" -ForegroundColor Green }
function warn { Write-Host "  ! $args" -ForegroundColor Yellow }
function die  { Write-Host "  x $args" -ForegroundColor Red; exit 1 }

# 读取当前版本
$pkg = Get-Content "package.json" | ConvertFrom-Json
$current = $pkg.version

# 计算默认下一版本
$parts = $current -split '\.'
$next_default = "$($parts[0]).$($parts[1]).$([int]$parts[2] + 1)"

# 确定目标版本
if ($Version -eq "") {
    log "当前版本: $current"
    $input_ver = Read-Host "新版本 [回车默认 $next_default]"
    $Version = if ($input_ver -eq "") { $next_default } else { $input_ver }
}

# 校验格式
if ($Version -notmatch '^\d+\.\d+\.\d+$') {
    die "版本号格式错误，应为 x.y.z"
}
if ($Version -eq $current) {
    die "新版本与当前版本相同：$current"
}

log "版本: $current -> $Version"

# 检查工作区
$dirty = git status --porcelain
if ($dirty) {
    warn "工作区有未提交的改动："
    git status --short
    $confirm = Read-Host "继续？(y/N)"
    if ($confirm -notmatch '^[Yy]$') { die "已取消" }
}

# 更新版本号
log "更新版本号…"

$pkg.version = $Version
$pkg | ConvertTo-Json -Depth 10 | Set-Content "package.json" -Encoding UTF8
ok "package.json"

$tauri = Get-Content "src-tauri/tauri.conf.json" | ConvertFrom-Json
$tauri.version = $Version
$tauri | ConvertTo-Json -Depth 10 | Set-Content "src-tauri/tauri.conf.json" -Encoding UTF8
ok "src-tauri/tauri.conf.json"

# 提交 + 打 tag
log "提交版本号变更…"
git add package.json src-tauri/tauri.conf.json
git commit -m "chore: bump version to $Version"
ok "git commit"

git tag "v$Version"
ok "git tag v$Version"

# 推送
log "推送到 GitHub…"
git push origin main
git push origin "v$Version"
ok "已推送，GitHub Actions 开始构建"

$remote = git remote get-url origin
$repo = $remote -replace '.*github\.com[:/](.+?)(\.git)?$', '$1'
Write-Host "`n完成！" -ForegroundColor Green
Write-Host "Release 进度: https://github.com/$repo/actions"