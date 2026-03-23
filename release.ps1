# release.ps1
param([string]$Version = "")

$ErrorActionPreference = "Stop"

function log  { Write-Host "`n$args" -ForegroundColor White }
function ok   { Write-Host "  v $args" -ForegroundColor Green }
function warn { Write-Host "  ! $args" -ForegroundColor Yellow }
function die  { Write-Host "  x $args" -ForegroundColor Red; exit 1 }

# Read current version
$pkg = Get-Content "package.json" | ConvertFrom-Json
$current = $pkg.version

# Compute default next patch version
$parts = $current -split '\.'
$next_default = "$($parts[0]).$($parts[1]).$([int]$parts[2] + 1)"

# Determine target version
if ($Version -eq "") {
    log "Current version: $current"
    $input_ver = Read-Host "New version [Enter for $next_default]"
    $Version = if ($input_ver -eq "") { $next_default } else { $input_ver }
}

# Validate format
if ($Version -notmatch '^\d+\.\d+\.\d+$') {
    die "Invalid version. Use x.y.z (e.g. 1.2.3)"
}
if ($Version -eq $current) {
    die "New version is the same as current: $current"
}

log "Version: $current -> $Version"

# Check working tree
$dirty = git status --porcelain
if ($dirty) {
    warn "Uncommitted changes:"
    git status --short
    $confirm = Read-Host "Continue? (y/N)"
    if ($confirm -notmatch '^[Yy]$') {
        die "Cancelled"
    }
}

# Update version numbers
log "Updating version..."
$utf8 = New-Object System.Text.UTF8Encoding $false

$pkg.version = $Version
[System.IO.File]::WriteAllText("$PWD/package.json", ($pkg | ConvertTo-Json -Depth 10), $utf8)
ok "package.json"

$tauri = Get-Content "src-tauri/tauri.conf.json" | ConvertFrom-Json
$tauri.version = $Version
[System.IO.File]::WriteAllText("$PWD/src-tauri/tauri.conf.json", ($tauri | ConvertTo-Json -Depth 10), $utf8)
ok "src-tauri/tauri.conf.json"

# Commit + tag
log "Committing..."
git add package.json src-tauri/tauri.conf.json
git commit -m "chore: bump version to $Version"
ok "git commit"

git tag "v$Version"
ok "git tag v$Version"

# Push
log "Pushing to GitHub..."
git push origin main
git push origin "v$Version"
ok "Pushed. GitHub Actions is now building."

$remote = git remote get-url origin
$repo = $remote -replace '.*github\.com[:/](.+?)(\.git)?$', '$1'
Write-Host "`nDone!" -ForegroundColor Green
Write-Host "Actions: https://github.com/$repo/actions"
