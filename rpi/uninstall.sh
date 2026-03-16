#!/usr/bin/env bash
# ═══════════════════════════════════════════════════════════════════════════════
#  rpi/uninstall.sh  —  Remove Biznex BOS autostart and PM2 processes
#
#  This does NOT delete your database or .env (your data stays safe).
#  To also delete the project folder, remove it manually after running this.
# ═══════════════════════════════════════════════════════════════════════════════

PROJECT_DIR="$(cd "$(dirname "$0")/.." && pwd)"

echo "════════════════════════════════════════"
echo "  Biznex BOS — Uninstaller"
echo "════════════════════════════════════════"

# Stop and remove PM2 processes
export NVM_DIR="$HOME/.nvm"
[ -s "$NVM_DIR/nvm.sh" ] && source "$NVM_DIR/nvm.sh"

pm2 delete biznex-pos     2>/dev/null && echo "✔ biznex-pos stopped" || true
pm2 delete biznex-license 2>/dev/null && echo "✔ biznex-license stopped" || true
pm2 save --force 2>/dev/null || true

# Remove XDG autostart entry
AUTOSTART_FILE="$HOME/.config/autostart/biznex-kiosk.desktop"
if [ -f "$AUTOSTART_FILE" ]; then
  rm "$AUTOSTART_FILE"
  echo "✔ XDG autostart entry removed"
fi

# Remove LXDE autostart entry
LXDE_AUTOSTART="$HOME/.config/lxsession/LXDE-pi/autostart"
if [ -f "$LXDE_AUTOSTART" ]; then
  sed -i '/biznex/d' "$LXDE_AUTOSTART"
  echo "✔ LXDE autostart entry removed"
fi

# Remove desktop shortcut
DESKTOP_FILE="$HOME/Desktop/BiznexBOS.desktop"
if [ -f "$DESKTOP_FILE" ]; then
  rm "$DESKTOP_FILE"
  echo "✔ Desktop shortcut removed"
fi

echo ""
echo "✅ Biznex BOS uninstalled."
echo ""
echo "Your data is preserved in:"
echo "  Database : ${PROJECT_DIR}/server/data/"
echo "  Config   : ${PROJECT_DIR}/.env"
echo ""
echo "To fully delete everything: rm -rf ${PROJECT_DIR}"
