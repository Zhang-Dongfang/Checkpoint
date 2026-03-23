#!/usr/bin/env bash
set -e

# ── 颜色 ────────────────────────────────────────────────────────────────────
BOLD='\033[1m'
GREEN='\033[0;32m'
YELLOW='\033[0;33m'
RED='\033[0;31m'
RESET='\033[0m'

log()  { echo -e "${BOLD}$1${RESET}"; }
ok()   { echo -e "${GREEN}✓ $1${RESET}"; }
warn() { echo -e "${YELLOW}⚠ $1${RESET}"; }
die()  { echo -e "${RED}✗ $1${RESET}"; exit 1; }

# ── 读取当前版本 ─────────────────────────────────────────────────────────────
CURRENT=$(node -p "require('./package.json').version")

# ── 解析参数 ─────────────────────────────────────────────────────────────────
if [[ -n "$1" ]]; then
  NEXT="$1"
else
  # 自动递增 patch（0.1.0 → 0.1.1）
  IFS='.' read -r MAJOR MINOR PATCH <<< "$CURRENT"
  NEXT="$MAJOR.$MINOR.$((PATCH + 1))"
  log "当前版本: $CURRENT"
  read -rp "新版本 [回车默认 $NEXT]: " INPUT
  [[ -n "$INPUT" ]] && NEXT="$INPUT"
fi

# ── 校验格式 ─────────────────────────────────────────────────────────────────
[[ "$NEXT" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]] || die "版本号格式错误，应为 x.y.z（如 1.2.3）"
[[ "$NEXT" == "$CURRENT" ]] && die "新版本与当前版本相同：$CURRENT"

log "\n版本: $CURRENT → $NEXT"

# ── 检查工作区是否干净 ────────────────────────────────────────────────────────
if [[ -n "$(git status --porcelain)" ]]; then
  warn "工作区有未提交的改动："
  git status --short
  read -rp "继续？(y/N) " CONFIRM
  [[ "$CONFIRM" =~ ^[Yy]$ ]] || die "已取消"
fi

# ── 更新版本号 ────────────────────────────────────────────────────────────────
log "\n更新版本号…"

# package.json
node -e "
  const fs = require('fs');
  const p = JSON.parse(fs.readFileSync('package.json', 'utf8'));
  p.version = '$NEXT';
  fs.writeFileSync('package.json', JSON.stringify(p, null, 2) + '\n');
"
ok "package.json"

# tauri.conf.json
node -e "
  const fs = require('fs');
  const p = JSON.parse(fs.readFileSync('src-tauri/tauri.conf.json', 'utf8'));
  p.version = '$NEXT';
  fs.writeFileSync('src-tauri/tauri.conf.json', JSON.stringify(p, null, 2) + '\n');
"
ok "src-tauri/tauri.conf.json"

# ── 提交 + 打 tag ─────────────────────────────────────────────────────────────
log "\n提交版本号变更…"
git add package.json src-tauri/tauri.conf.json
git commit -m "chore: bump version to $NEXT"
ok "git commit"

git tag "v$NEXT"
ok "git tag v$NEXT"

# ── 推送 ─────────────────────────────────────────────────────────────────────
log "\n推送到 GitHub…"
git push origin main
git push origin "v$NEXT"
ok "已推送，GitHub Actions 开始构建"

echo -e "\n${BOLD}${GREEN}完成！${RESET}"
echo -e "Release 进度：${BOLD}https://github.com/$(git remote get-url origin | sed 's/.*github.com[:/]\(.*\)\.git/\1/' | sed 's/.*github.com[:/]\(.*\)/\1/')/actions${RESET}"
