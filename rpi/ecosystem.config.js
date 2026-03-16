/**
 * rpi/ecosystem.config.js — PM2 process config for Raspberry Pi
 *
 * Starts two processes:
 *  1. biznex-pos     — Express POS server on port 3000 (serves the UI too)
 *  2. biznex-license — License validation server on port 4000
 *
 * Usage:
 *   pm2 start  rpi/ecosystem.config.js
 *   pm2 reload rpi/ecosystem.config.js --update-env
 */
module.exports = {
  apps: [
    {
      name: 'biznex-pos',
      script: 'server/server-rpi.js',
      cwd: require('path').join(__dirname, '..'),
      instances: 1,
      autorestart: true,
      watch: false,
      max_memory_restart: '256M',
      env: {
        NODE_ENV: 'production',
        PORT: 3000,
        SERVE_STATIC: 'true',
        RPI_MODE: 'true',
      },
    },
    {
      name: 'biznex-license',
      script: 'proto-license-server.js',
      cwd: require('path').join(__dirname, '..'),
      instances: 1,
      autorestart: true,
      watch: false,
      max_memory_restart: '128M',
      env: {
        NODE_ENV: 'production',
        LICENSE_PORT: 4000,
      },
    },
  ],
};
