#!/usr/bin/env bash
# ═══════════════════════════════════════════════════════════════════════════════
#  rpi/kiosk.sh  —  Launch Biznex BOS in full-screen kiosk mode
#
#  Usage:
#    ./rpi/kiosk.sh          # opens at http://localhost:3000
#    ./rpi/kiosk.sh 3001     # custom port
# ═══════════════════════════════════════════════════════════════════════════════
PORT="${1:-3000}"
URL="http://localhost:${PORT}"

# Detect correct chromium binary (Pi OS Bookworm = 'chromium', older = 'chromium-browser')
CHROMIUM_BIN=$(command -v chromium 2>/dev/null || command -v chromium-browser 2>/dev/null)
if [ -z "$CHROMIUM_BIN" ]; then
  echo "ERROR: chromium not found. Run rpi/install.sh first."
  exit 1
fi

# Ensure the server is up before opening browser
echo "Waiting for Biznex BOS to be ready at ${URL}..."
for i in $(seq 1 20); do
  if curl -s "$URL" >/dev/null 2>&1; then
    echo "Server ready."
    break
  fi
  sleep 1
done

# Hide mouse cursor after 2 s of inactivity
command -v unclutter >/dev/null 2>&1 && unclutter -idle 2 -root &

# Disable screen blanking / DPMS
xset s off 2>/dev/null || true
xset s noblank 2>/dev/null || true
xset -dpms 2>/dev/null || true

# Launch Chromium in kiosk mode (full-screen, no browser UI)
exec "$CHROMIUM_BIN" \
  --kiosk \
  --no-first-run \
  --disable-infobars \
  --disable-session-crashed-bubble \
  --disable-restore-session-state \
  --disable-translate \
  --disable-features=TranslateUI \
  --disable-pinch \
  --overscroll-history-navigation=0 \
  --check-for-update-interval=3153600000 \
  --noerrdialogs \
  --app="$URL"
