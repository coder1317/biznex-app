#!/usr/bin/env bash
# ═══════════════════════════════════════════════════════════════════════════════
#  rpi/update.sh  —  Pull latest code and restart Biznex BOS
#
#  Usage:
#    ./rpi/update.sh
# ═══════════════════════════════════════════════════════════════════════════════
set -e

PROJECT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
cd "$PROJECT_DIR"

echo "════════════════════════════════════════"
echo "  Biznex BOS — Updater"
echo "════════════════════════════════════════"

# 1. Pull latest code (if using git)
if [ -d ".git" ]; then
  echo "[1/3] Pulling latest code..."
  git pull --ff-only
else
  echo "[1/3] Not a git repo — skipping pull. Copy updated files manually."
fi

# 2. Install / update dependencies
echo "[2/3] Updating dependencies..."
export NVM_DIR="$HOME/.nvm"
[ -s "$NVM_DIR/nvm.sh" ] && source "$NVM_DIR/nvm.sh"
npm install --omit=dev --silent >/dev/null 2>&1
echo "  Dependencies up to date"

# 3. Restart PM2
echo "[3/3] Restarting server..."
pm2 restart rpi/ecosystem.config.js --update-env
pm2 save --force

echo ""
echo "✅ Biznex BOS updated and restarted"
pm2 list
