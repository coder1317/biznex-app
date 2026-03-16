module.exports = {
  apps: [{
    name: 'biznex-server',
    // server-rpi.js enables static file serving so the POS UI is
    // accessible at http://localhost:3000 in Chromium on the Pi.
    script: 'server/server-rpi.js',
    instances: 1,
    autorestart: true,
    watch: false,
    max_memory_restart: '256M',
    env: {
      NODE_ENV: 'production',
      PORT: 3000,
      SERVE_STATIC: 'true',
    }
  }]
};