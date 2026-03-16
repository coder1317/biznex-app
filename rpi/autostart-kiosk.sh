#!/usr/bin/env bash
# ═══════════════════════════════════════════════════════════════════════════════
#  rpi/autostart-kiosk.sh  —  Configure the Pi to boot straight into kiosk mode
#
#  This script makes the Pi:
#    • Auto-login to the desktop (LXDE/labwc)
#    • Launch Biznex BOS POS in Chromium kiosk on every boot
#    • No keyboard/mouse needed after setup
#
#  Run ONCE after install.sh:
#    chmod +x rpi/autostart-kiosk.sh
#    ./rpi/autostart-kiosk.sh
# ═══════════════════════════════════════════════════════════════════════════════
set -e

PROJECT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
AUTOSTART_DIR="$HOME/.config/autostart"
LXDE_AUTOSTART="$HOME/.config/lxsession/LXDE-pi/autostart"

mkdir -p "$AUTOSTART_DIR"

# ── Method 1: XDG autostart (.desktop file) ──────────────────────────────────
cat > "$AUTOSTART_DIR/biznex-kiosk.desktop" <<EOF
[Desktop Entry]
Type=Application
Name=Biznex BOS Kiosk
Comment=Start Biznex POS in fullscreen
Exec=${PROJECT_DIR}/rpi/kiosk.sh
X-GNOME-Autostart-enabled=true
Hidden=false
NoDisplay=false
EOF
echo "✔ XDG autostart entry created"

# ── Method 2: LXDE autostart ─────────────────────────────────────────────────
if [ -f "$LXDE_AUTOSTART" ]; then
  if ! grep -q "biznex" "$LXDE_AUTOSTART"; then
    echo "@${PROJECT_DIR}/rpi/kiosk.sh" >> "$LXDE_AUTOSTART"
    echo "✔ LXDE autostart entry added"
  else
    echo "✔ LXDE autostart already configured"
  fi
else
  mkdir -p "$(dirname "$LXDE_AUTOSTART")"
  cat > "$LXDE_AUTOSTART" <<EOF
@lxpanel --profile LXDE-pi
@pcmanfm --desktop --profile LXDE-pi
@${PROJECT_DIR}/rpi/kiosk.sh
EOF
  echo "✔ LXDE autostart file created"
fi

# ── Auto-login without password (raspi-config) ───────────────────────────────
echo ""
echo "To enable desktop auto-login (optional):"
echo "  sudo raspi-config nonint do_boot_behaviour B4"
echo ""
echo "Or run: sudo raspi-config → System Options → Boot / Auto Login → Desktop Autologin"
echo ""
echo "✅ Kiosk autostart configured. Reboot to test:"
echo "   sudo reboot"
