#!/usr/bin/env bash
# ═══════════════════════════════════════════════════════════════════════════════
#  rpi/install.sh  —  Biznex BOS Raspberry Pi One-Shot Installer
#
#  Tested on: Raspberry Pi OS Bookworm / Bullseye (32-bit & 64-bit)
#  Hardware:  Raspberry Pi 3B / 3B+ / 4 / 5 / Zero 2W
#
#  Usage:
#    1. Copy the entire Biznex BOS project folder to your Pi (USB / SCP / git)
#    2. From inside the project root:
#         chmod +x rpi/install.sh
#         ./rpi/install.sh
#
#  After install:
#    POS (this Pi):      http://localhost:3000
#    POS (your network): http://<PI_IP>:3000
#    Admin panel:        http://localhost:3000  (login with your credentials)
#    License server:     http://localhost:4000
# ═══════════════════════════════════════════════════════════════════════════════
set -e

# ── Colours ──────────────────────────────────────────────────────────────────
RED='\033[0;31m'; GREEN='\033[0;32m'; YELLOW='\033[1;33m'
CYAN='\033[0;36m'; BOLD='\033[1m'; NC='\033[0m'

PI_IP=$(hostname -I | awk '{print $1}')
# Project root = parent of this script's directory
PROJECT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
RPI_DIR="$PROJECT_DIR/rpi"

banner() {
  echo ""
  echo -e "${CYAN}${BOLD}════════════════════════════════════════════════${NC}"
  echo -e "${CYAN}${BOLD}  Biznex BOS — Raspberry Pi Installer  ${NC}"
  echo -e "${CYAN}  Project : ${PROJECT_DIR}${NC}"
  echo -e "${CYAN}  Pi IP   : ${PI_IP}${NC}"
  echo -e "${CYAN}${BOLD}════════════════════════════════════════════════${NC}"
  echo ""
}

step() { echo -e "\n${BOLD}[${1}]${NC} ${2}..."; }
ok()   { echo -e "  ${GREEN}✔ ${1}${NC}"; }
warn() { echo -e "  ${YELLOW}⚠ ${1}${NC}"; }
fail() { echo -e "  ${RED}✖ ${1}${NC}"; exit 1; }

banner

# ── 1. System packages ───────────────────────────────────────────────────────
step "1/7" "Updating system & installing dependencies"
sudo apt-get update -qq

# Pi OS Bookworm (Debian 12) ships 'chromium'; older releases use 'chromium-browser'
CHROMIUM_PKG="chromium-browser"
apt-cache show chromium 2>/dev/null | grep -q '^Package:' && CHROMIUM_PKG="chromium"

sudo apt-get install -y --no-install-recommends \
  curl git build-essential python3 python3-pip \
  libudev-dev libusb-1.0-0-dev               \
  "${CHROMIUM_PKG}" xdotool unclutter         \
  jq >/dev/null 2>&1

# Record the actual chromium binary name for later use
CHROMIUM_BIN=$(command -v chromium 2>/dev/null || command -v chromium-browser 2>/dev/null || echo "chromium-browser")
ok "System packages installed  (chromium: $(basename $CHROMIUM_BIN))"

# ── 2. Node.js via NVM ──────────────────────────────────────────────────────
step "2/7" "Setting up Node.js 20 LTS"
export NVM_DIR="$HOME/.nvm"
if [ ! -s "$NVM_DIR/nvm.sh" ]; then
  curl -fsSL https://raw.githubusercontent.com/nvm-sh/nvm/v0.40.0/install.sh | bash
fi
[ -s "$NVM_DIR/nvm.sh" ] && source "$NVM_DIR/nvm.sh"
nvm install 20 --lts >/dev/null 2>&1
nvm use 20 >/dev/null 2>&1
nvm alias default 20 >/dev/null 2>&1

# Make node/npm available system-wide for PM2 service
NODE_BIN=$(which node)
NPM_BIN=$(which npm)
ok "Node $(node -v) | npm $(npm -v)"

# ── 3. PM2 ──────────────────────────────────────────────────────────────────
step "3/7" "Installing PM2 process manager"
npm install -g pm2 --silent >/dev/null 2>&1 || true
ok "PM2 $(pm2 -v)"

# ── 4. Project dependencies ──────────────────────────────────────────────────
step "4/7" "Installing project dependencies (no Electron)"
cd "$PROJECT_DIR"
# --omit=dev skips Electron and build-only tools (~250 MB saved)
# --no-fund / --no-audit speed things up on slow Pi SD cards
npm install --omit=dev --no-fund --no-audit 2>&1 | tail -5
ok "Dependencies installed"

# ── 5. .env setup ────────────────────────────────────────────────────────────
step "5/7" "Configuring environment"
ENV_FILE="$PROJECT_DIR/.env"
if [ ! -f "$ENV_FILE" ]; then
  if [ -f "$PROJECT_DIR/.env.example" ]; then
    cp "$PROJECT_DIR/.env.example" "$ENV_FILE"
  else
    touch "$ENV_FILE"
  fi

  # Generate random secrets
  JWT_SECRET=$(node -e "console.log(require('crypto').randomBytes(64).toString('hex'))")
  SESSION_SECRET=$(node -e "console.log(require('crypto').randomBytes(32).toString('hex'))")

  # Append / update key values
  {
    echo ""
    echo "NODE_ENV=production"
    echo "PORT=3000"
    echo "LICENSE_PORT=4000"
    echo "SERVE_STATIC=true"
    echo "JWT_SECRET=${JWT_SECRET}"
    echo "SESSION_SECRET=${SESSION_SECRET}"
    echo "API_BASE_URL=http://${PI_IP}:3000"
  } >> "$ENV_FILE"

  ok ".env created with auto-generated secrets"
  warn "Secrets are saved in: ${ENV_FILE}"
else
  ok ".env already exists — skipping"
fi

# ── 6. Database first-time init ──────────────────────────────────────────────
step "6/7" "Initialising database"
cd "$PROJECT_DIR"
node -e "
  require('dotenv').config({ path: '.env' });
  const db = require('./server/db.js');
  setTimeout(() => process.exit(0), 2000);
" 2>/dev/null && ok "Database ready" || warn "DB init skipped (will init on first start)"

# ── 7. PM2 ──────────────────────────────────────────────────────────────────
step "7/7" "Starting Biznex BOS with PM2"
cd "$PROJECT_DIR"
pm2 delete biznex-pos    2>/dev/null || true
pm2 delete biznex-license 2>/dev/null || true

pm2 start rpi/ecosystem.config.js
pm2 save --force

# Enable PM2 on boot
# pm2 startup prints a command like: 'sudo env PATH=... pm2 startup ...'
# Capture it, strip the leading hint text, and run it.
STARTUP_OUT=$(pm2 startup 2>&1 || true)
STARTUP_CMD=$(echo "$STARTUP_OUT" | grep -E '^sudo env ' | head -1 || true)
if [ -n "$STARTUP_CMD" ]; then
  eval "$STARTUP_CMD" >/dev/null 2>&1 && ok "PM2 boot autostart enabled" \
    || warn "PM2 startup command failed — run manually: $STARTUP_CMD"
else
  warn "Could not extract PM2 startup command. Run 'pm2 startup' manually."
fi

# ── Verify server started ────────────────────────────────────────────────────
echo ""
echo -e "  Waiting for server to be ready..."
for i in $(seq 1 15); do
  if curl -sf http://localhost:3000/health >/dev/null 2>&1; then
    ok "Server is up at http://localhost:3000"
    break
  fi
  sleep 1
done
curl -sf http://localhost:3000/health >/dev/null 2>&1 || warn "Server did not respond yet — check: pm2 logs biznex-pos"

# ── Kiosk desktop shortcut ───────────────────────────────────────────────────
DESKTOP_FILE="$HOME/Desktop/BiznexBOS.desktop"
if [ -d "$HOME/Desktop" ]; then
  cat > "$DESKTOP_FILE" <<DEOF
[Desktop Entry]
Version=1.0
Type=Application
Name=Biznex BOS
Comment=Open Biznex POS
Exec=${CHROMIUM_BIN} --kiosk --disable-infobars --disable-session-crashed-bubble --app=http://localhost:3000
Icon=${PROJECT_DIR}/build-assets/icon.png
Terminal=false
Categories=Office;Finance;
DEOF
  chmod +x "$DESKTOP_FILE"
  ok "Desktop shortcut created"
fi

# ── Done ─────────────────────────────────────────────────────────────────────
echo ""
echo -e "${GREEN}${BOLD}════════════════════════════════════════════════${NC}"
echo -e "${GREEN}${BOLD}  ✅  Biznex BOS is RUNNING!  ${NC}"
echo ""
echo -e "  ${BOLD}POS (this Pi):${NC}    http://localhost:3000"
echo -e "  ${BOLD}POS (network):${NC}    http://${PI_IP}:3000"
echo -e "  ${BOLD}License server:${NC}   http://localhost:4000"
echo ""
echo -e "  ${BOLD}Open kiosk mode:${NC}"
echo -e "    ./rpi/kiosk.sh"
echo ""
echo -e "  ${BOLD}Useful PM2 commands:${NC}"
echo -e "    pm2 logs biznex-pos       # live logs"
echo -e "    pm2 restart biznex-pos    # restart server"
echo -e "    pm2 stop    biznex-pos    # stop server"
echo ""
echo -e "  ${BOLD}Update app:${NC}"
echo -e "    ./rpi/update.sh"
echo -e "${GREEN}${BOLD}════════════════════════════════════════════════${NC}"
echo ""
