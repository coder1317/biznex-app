#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────────────────────
# scripts/rpi-install.sh  —  Raspberry Pi setup script for Biznex BOS
#
# Run once on a fresh Raspberry Pi OS (Bookworm / Bullseye, 32-bit or 64-bit):
#   chmod +x scripts/rpi-install.sh
#   ./scripts/rpi-install.sh
#
# After install, the server starts automatically on boot via PM2.
# Open the POS in a browser at: http://localhost:3000
# Other devices on the same network: http://<PI_IP>:3000
# ─────────────────────────────────────────────────────────────────────────────
set -e

PI_IP=$(hostname -I | awk '{print $1}')
PROJECT_DIR="$(cd "$(dirname "$0")/.." && pwd)"

echo "════════════════════════════════════════════"
echo " Biznex BOS — Raspberry Pi Installer"
echo " Project: $PROJECT_DIR"
echo " Pi IP:   $PI_IP"
echo "════════════════════════════════════════════"

# ── 1. System packages ───────────────────────────────────────────────────────
echo "[1/6] Updating packages..."
sudo apt-get update -qq
sudo apt-get install -y curl git build-essential python3

# ── 2. Node.js via NVM ──────────────────────────────────────────────────────
echo "[2/6] Installing Node.js 20 LTS..."
if ! command -v node &>/dev/null; then
    curl -fsSL https://raw.githubusercontent.com/nvm-sh/nvm/v0.40.0/install.sh | bash
    export NVM_DIR="$HOME/.nvm"
    [ -s "$NVM_DIR/nvm.sh" ] && source "$NVM_DIR/nvm.sh"
    nvm install 20
    nvm use 20
    nvm alias default 20
fi
echo "  Node: $(node -v), npm: $(npm -v)"

# ── 3. PM2 ──────────────────────────────────────────────────────────────────
echo "[3/6] Installing PM2..."
npm install -g pm2 2>/dev/null || true
pm2 --version

# ── 4. Project dependencies ──────────────────────────────────────────────────
echo "[4/6] Installing project dependencies..."
cd "$PROJECT_DIR"
# --omit=dev avoids installing Electron (not needed on RPi)
npm install --omit=dev

# ── 5. .env setup ────────────────────────────────────────────────────────────
echo "[5/6] Configuring .env..."
if [ ! -f "$PROJECT_DIR/.env" ]; then
    cp "$PROJECT_DIR/.env.example" "$PROJECT_DIR/.env"
    # Auto-fill the Pi's local IP so other network devices can connect
    sed -i "s|API_BASE_URL=http://localhost:3000|API_BASE_URL=http://$PI_IP:3000|g" "$PROJECT_DIR/.env"
    echo "  .env created — API accessible at http://$PI_IP:3000"
    echo ""
    echo "  ⚠️  ACTION REQUIRED: Edit .env and change JWT_SECRET + SESSION_SECRET!"
    echo "  nano $PROJECT_DIR/.env"
else
    echo "  .env already exists, skipping."
fi

# ── 6. PM2 startup ───────────────────────────────────────────────────────────
echo "[6/6] Starting server with PM2..."
cd "$PROJECT_DIR"
pm2 delete biznex-server 2>/dev/null || true
pm2 start ecosystem.config.js
pm2 save

# Register PM2 to start on boot
pm2 startup | tail -1 | bash || echo "  (Run 'pm2 startup' manually to enable boot autostart)"

echo ""
echo "════════════════════════════════════════════"
echo " ✅ Biznex BOS is running!"
echo ""
echo "  POS (this Pi):       http://localhost:3000"
echo "  POS (network):       http://$PI_IP:3000"
echo "  Logs:                pm2 logs biznex-server"
echo "  Stop:                pm2 stop biznex-server"
echo "  Restart:             pm2 restart biznex-server"
echo ""
echo "  To open in Chromium kiosk mode (fullscreen POS):"
echo "  chromium-browser --kiosk http://localhost:3000"
echo "════════════════════════════════════════════"
