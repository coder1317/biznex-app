/**
 * server/server-rpi.js — Raspberry Pi / headless server entry point
 *
 * On the Raspberry Pi there is no Electron window. This file starts the
 * Express + Socket.io server and serves the client folder as static files
 * so you can open the POS in Chromium:  chromium-browser http://localhost:3000
 *
 * LICENSE GATE:
 *   Setting RPI_MODE=true activates a browser-based license gate in server.js.
 *   On first visit, Chromium is redirected to /license-activate until a valid
 *   key or 14-day trial is confirmed. The license is stored in rpi-license.json.
 *
 * Start with:  node server/server-rpi.js
 * Or via PM2:  pm2 start rpi/ecosystem.config.js
 */
require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });

// Tell server.js to serve the client folder statically (Pi has no Electron)
process.env.SERVE_STATIC = 'true';
// Tell server.js to activate the browser-based RPi license gate
process.env.RPI_MODE     = 'true';

require('./server');
