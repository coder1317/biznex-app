════════════════════════════════════════════════════════════════
  BIZNEX BOS — Raspberry Pi Edition
  Setup & Usage Guide
════════════════════════════════════════════════════════════════

WHAT THIS FOLDER CONTAINS
──────────────────────────
  install.sh          One-shot installer (run this first)
  kiosk.sh            Open the POS in fullscreen Chromium
  autostart-kiosk.sh  Make the Pi boot directly into the POS
  update.sh           Pull updates & restart the server
  uninstall.sh        Stop everything (data is preserved)
  ecosystem.config.js PM2 process config (POS + license server)
  activate.html       Browser-based license activation page
  README.txt          This file


REQUIREMENTS
────────────
  • Raspberry Pi 3B / 3B+ / 4 / 5 / Zero 2W
  • Raspberry Pi OS Bookworm or Bullseye (32-bit or 64-bit)
  • Internet connection (for first-time install only)
  • 2 GB RAM minimum (4 GB recommended)
  • 8 GB SD card minimum (16 GB+ recommended)


QUICK START — FIRST TIME SETUP
───────────────────────────────
1. Copy the project to your Raspberry Pi:
     Option A (USB):   Copy the entire project folder to a USB drive,
                       plug into Pi, copy to /home/pi/biznex-bos
     Option B (SSH):   scp -r /path/to/biznex-bos pi@<PI_IP>:/home/pi/
     Option C (Git):   git clone <repo-url> /home/pi/biznex-bos

2. Open a terminal on the Pi and run:
     cd /home/pi/biznex-bos
     chmod +x rpi/*.sh
     ./rpi/install.sh

3. Open the POS in Chromium:
     http://localhost:3000
     or http://<PI_IP>:3000  (from any device on the same Wi-Fi)

4. The first time you open the URL, you will see the License Activation
   screen. Enter your license key or start the 14-day free trial.

5. To set up kiosk mode (POS launches fullscreen on boot):
     ./rpi/autostart-kiosk.sh
     sudo reboot


LICENSE KEY FORMATS
───────────────────
  BZNX-STR-XXXXXXXX-XXXXXXXX  →  Starter     (1 store / 1 device)
  BZNX-BIZ-XXXXXXXX-XXXXXXXX  →  Business    (up to 10 stores/devices)
  BZNX-ENT-XXXXXXXX-XXXXXXXX  →  Enterprise  (unlimited)

  The plan is read from the key prefix (STR / BIZ / ENT).

  To generate keys (from the machine where the license server is running):
    POST http://localhost:4000/api/admin/generate-key
    Body: { "plan": "starter", "customerName": "...", 
            "customerEmail": "...", "adminSecret": "biznex-admin-2026" }


LICENSE FILES
─────────────
  After activation, a file is saved:
    rpi-license.json  — stored in the project root

  After starting trial:
    rpi-trial.json    — stored in the project root

  To reset / re-activate: delete rpi-license.json and restart the server.


KIOSK MODE
──────────
  Run manually any time:
    ./rpi/kiosk.sh

  Set up to run on every boot:
    ./rpi/autostart-kiosk.sh


USEFUL COMMANDS
───────────────
  View live logs:         pm2 logs biznex-pos
  Restart server:         pm2 restart biznex-pos
  Stop server:            pm2 stop biznex-pos
  Start server:           pm2 start rpi/ecosystem.config.js
  All process status:     pm2 list
  Update to latest:       ./rpi/update.sh
  Uninstall:              ./rpi/uninstall.sh


ACCESSING FROM OTHER DEVICES
─────────────────────────────
  Any device on the same Wi-Fi network can use the POS by opening:
    http://<PI_IP>:3000

  To find your Pi's IP:
    hostname -I

  IMPORTANT: The license is tied to this Raspberry Pi. Each Pi needs
  its own license key (Starter = 1 device, Business = up to 10, etc.)


TROUBLESHOOTING
───────────────
  Problem: Page doesn't load
  Fix:     pm2 start rpi/ecosystem.config.js
           pm2 logs biznex-pos   (check for errors)

  Problem: License server not reachable on activation page
  Fix:     pm2 start rpi/ecosystem.config.js
           (both biznex-pos AND biznex-license must be running)

  Problem: Screen goes blank after a few minutes
  Fix:     ./rpi/kiosk.sh already disables DPMS.
           For permanent fix: sudo raspi-config → Display → Screen Blanking → Off

  Problem: App crashes on 256 MB Pi Zero
  Fix:     Edit rpi/ecosystem.config.js, set max_memory_restart to '128M'


SUPPORT
───────
  Website:  https://biznex.io
  Email:    support@biznex.io

════════════════════════════════════════════════════════════════
