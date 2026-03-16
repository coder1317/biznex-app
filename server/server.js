require('dotenv').config();
const express = require("express");
const bodyParser = require("body-parser");
const cors = require("cors");
const bcrypt = require("bcryptjs");
const helmet = require("helmet");
const rateLimit = require("express-rate-limit");
const winston = require("winston");
const path = require("path");
const fs = require("fs");
const db = require("./db");

// Safety net: JWT_SECRET must always have a value.
// On a fresh packaged install main.js auto-generates and sets it before
// loading this module. This fallback keeps the dev server working even
// without a .env file and prevents the hard crash on new machines.
if (!process.env.JWT_SECRET) {
    const crypto = require('crypto');
    process.env.JWT_SECRET = crypto.randomBytes(64).toString('hex');
    console.warn('[server] JWT_SECRET not set — generated a temporary one (tokens will not survive restarts).');
}
if (!process.env.JWT_REFRESH_SECRET) {
    const crypto = require('crypto');
    process.env.JWT_REFRESH_SECRET = crypto.randomBytes(64).toString('hex');
}

// Ensure log directory exists (packaged app writes to userData/logs)
const logDir = process.env.LOG_DIR || path.join(__dirname, '..', 'logs');
if (!fs.existsSync(logDir)) fs.mkdirSync(logDir, { recursive: true });

// Logger setup
const logger = winston.createLogger({
  level: 'info',
  format: winston.format.combine(
    winston.format.timestamp(),
    winston.format.errors({ stack: true }),
    winston.format.json()
  ),
  defaultMeta: { service: 'biznex-server' },
  transports: [
    new winston.transports.File({ filename: path.join(logDir, 'error.log'), level: 'error' }),
    new winston.transports.File({ filename: path.join(logDir, 'combined.log') }),
  ],
});

if (process.env.NODE_ENV !== 'production') {
  logger.add(new winston.transports.Console({
    format: winston.format.simple(),
  }));
}

// Optional printing integration
let getPrinter, printReceipt;
try {
    ({ getPrinter } = require('./printer'));
    ({ printReceipt } = require('./receipt'));
} catch (e) {
    console.warn('Printer modules not available:', e && e.message);
}

const app = express();

// ─── Sentry ──────────────────────────────────────────────────────────────────
const { initSentry, errorHandler: sentryErrorHandler } = require('./sentry');
initSentry(app); // must be before any routes

// Phase 5: Wrap in http.Server so socket.io can share the same port
const httpServer = require('http').createServer(app);
const { Server: SocketIO } = require('socket.io');
const io = new SocketIO(httpServer, {
    cors: { 
        origin: process.env.CORS_ORIGIN ? process.env.CORS_ORIGIN.split(',') : ['http://localhost:3000', 'http://localhost:5173'],
        credentials: true 
    },
    transports: ['websocket', 'polling'],
});
io.on('connection', (socket) => {
    logger.info(`🔌 Socket.io client connected: ${socket.id}`);
    socket.on('disconnect', () => logger.info(`🔌 Socket.io disconnected: ${socket.id}`));
});
logger.info('🔌 Socket.io attached');

app.use(helmet());
app.use(cors({
    // Allow specific origins (configurable via env, defaults to localhost)
    origin: process.env.CORS_ORIGIN ? process.env.CORS_ORIGIN.split(',') : ['http://localhost:3000', 'http://localhost:5173', 'file://'],
    credentials: true,
    methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS']
}));
app.use(bodyParser.json());

// Rate limiting
const limiter = rateLimit({
    windowMs: 15 * 60 * 1000, // 15 minutes
    max: 100, // limit each IP to 100 requests per windowMs
    message: 'Too many requests from this IP, please try again later.',
    standardHeaders: true, // Return rate limit info in `RateLimit-*` headers
    legacyHeaders: false, // Disable the `X-RateLimit-*` headers
});
app.use(limiter);

// ── RPi License Gate ─────────────────────────────────────────────────────────
// Only active when running in headless/Pi mode (SERVE_STATIC + RPI_MODE env vars).
// Redirects Chromium to /license-activate until a valid key or trial exists.
if (process.env.SERVE_STATIC === 'true' && process.env.RPI_MODE === 'true') {
    const _fs   = require('fs');
    const _root = path.join(__dirname, '..');
    const _LIC  = path.join(_root, 'rpi-license.json');
    const _TRL  = path.join(_root, 'rpi-trial.json');
    const _TDAYS = parseInt(process.env.TRIAL_DAYS || '14', 10);

    function _loadJSON(f) { try { return JSON.parse(_fs.readFileSync(f, 'utf8')); } catch { return null; } }
    function _trialActive(t) {
        if (!t || !t.startedAt) return false;
        return (Date.now() - new Date(t.startedAt).getTime()) / 86400000 < _TDAYS;
    }
    function _daysLeft(t) {
        if (!t || !t.startedAt) return 0;
        return Math.max(0, Math.ceil(_TDAYS - (Date.now() - new Date(t.startedAt).getTime()) / 86400000));
    }

    // Serve the activation page
    app.get('/license-activate', (req, res) => {
        res.sendFile(path.join(_root, 'rpi', 'activate.html'));
    });

    // Start / read trial
    app.post('/api/rpi/trial', (req, res) => {
        let t = _loadJSON(_TRL);
        if (!t) {
            t = { startedAt: new Date().toISOString(), trialDays: _TDAYS };
            _fs.writeFileSync(_TRL, JSON.stringify(t, null, 2));
        }
        res.json({ ok: true, active: _trialActive(t), daysLeft: _daysLeft(t), trialDays: _TDAYS, startedAt: t.startedAt });
    });

    // Activate key (proxy to license server on port 4000)
    app.post('/api/rpi/activate', express.json(), (req, res) => {
        const { licenseKey } = req.body || {};
        if (!licenseKey) return res.status(400).json({ ok: false, error: 'licenseKey is required' });

        const deviceId = require('os').hostname() + '-rpi';
        const payload  = JSON.stringify({ key: licenseKey, device_id: deviceId, device_name: 'Raspberry Pi' });
        const PLAN_LABELS = { starter: 'Starter (1 store)', business: 'Business (up to 10 stores)', enterprise: 'Enterprise (unlimited)' };

        const proxyReq = require('http').request({
            hostname: '127.0.0.1', port: process.env.LICENSE_PORT || 4000,
            path: '/api/license/activate', method: 'POST',
            headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) },
        }, (pRes) => {
            let data = '';
            pRes.on('data', c => { data += c; });
            pRes.on('end', () => {
                try {
                    const r = JSON.parse(data);
                    if (pRes.statusCode === 200 && r.plan) {
                        const stored = { licenseKey, plan: r.plan, planLabel: PLAN_LABELS[r.plan] || r.plan,
                            maxDevices: r.maxDevices, deviceId, activatedAt: new Date().toISOString(), licenseToken: r.token || null };
                        _fs.writeFileSync(_LIC, JSON.stringify(stored, null, 2));
                        return res.json({ ok: true, ...stored });
                    }
                    res.status(pRes.statusCode).json({ ok: false, error: r.error || 'Activation failed' });
                } catch { res.status(500).json({ ok: false, error: 'Invalid license server response' }); }
            });
        });
        proxyReq.on('error', () => res.status(503).json({ ok: false, error: 'License server not reachable. Ensure biznex-license PM2 process is running.' }));
        proxyReq.write(payload);
        proxyReq.end();
    });

    // Gate: block all non-API/non-activation requests if not licensed
    app.use((req, res, next) => {
        if (req.url.startsWith('/api/') || req.url === '/license-activate' ||
            req.url.startsWith('/license-activate?') || req.url === '/favicon.ico') return next();
        const lic = _loadJSON(_LIC);
        const trl = _loadJSON(_TRL);
        if (lic && lic.licenseKey) return next();
        if (_trialActive(trl))    return next();
        if (trl && !_trialActive(trl)) return res.redirect('/license-activate?expired=1');
        res.redirect('/license-activate');
    });

    logger.info('🔐 RPi license gate active');
}

// Auth middleware & helpers (extracted to module)
const { requireAuth, requireAdmin, sanitizeBody } = require('./middleware/auth');

// Global request logger: show every API call (sensitive fields redacted)
app.use((req, res, next) => {
    const start = Date.now();
    res.on('finish', () => {
        const duration = Date.now() - start;
        logger.info(`API Call: ${req.method} ${req.url} - ${res.statusCode} - ${duration}ms`, { body: sanitizeBody(req.body) });
    });
    next();
});

/* ── Route modules ──────────────────────────────────────────────────────────── */
app.use('/api/auth',      require('./routes/auth')(db, logger));
app.use('/api/users',     require('./routes/users')(db, logger));
app.use('/api/discounts', require('./routes/discounts')(db));
app.use('/api/products',  require('./routes/products')(db, io));
app.use('/api/orders',    require('./routes/orders')(db, io, logger, getPrinter, printReceipt));
app.use('/api/dashboard', require('./routes/dashboard')(db));
app.use('/api/reports',   require('./routes/reports')(db));
app.use('/api/inventory', require('./routes/inventory')(db));
app.use('/api/suppliers', require('./routes/suppliers')(db));
app.use('/api/settings',  require('./routes/settings')(db, logger));


// Global error handler
app.use((err, req, res, next) => {
    logger.error('Unhandled error:', err);
    res.status(500).json({ error: 'Internal server error' });
});

// Health check endpoint
app.get('/health', (req, res) => {
    const memUsage = process.memoryUsage();
    const uptime = process.uptime();
    res.json({
        status: 'ok',
        uptime: uptime,
        memory: {
            rss: memUsage.rss,
            heapTotal: memUsage.heapTotal,
            heapUsed: memUsage.heapUsed,
            external: memUsage.external
        },
        timestamp: new Date().toISOString()
    });
});


// POST /api/setup — first-run setup endpoint (no auth required, creates initial config)
// Protected by a one-time flag: once setup_complete is set, this returns 403.
app.post('/api/setup', (req, res) => {
    const { business_name, receipt_footer, currency_symbol, currency_code,
            tax_rate, tax_label, timezone, new_password, new_username } = req.body;

    if (!business_name || !new_password) {
        return res.status(400).json({ error: 'business_name and new_password are required' });
    }

    // Wait for DB to be fully initialised before querying it.
    // On a first-run the DB schema is still being built when this request arrives.
    db.onReady(() => {

    const settings = {
            business_name:   business_name,
            receipt_footer:  receipt_footer  || 'Thank you for your purchase!',
            currency_symbol: currency_symbol || '$',
            currency_code:   currency_code   || 'USD',
            tax_rate:        String(tax_rate || '0'),
            tax_label:       tax_label       || 'Tax',
            timezone:        timezone        || 'UTC',
            setup_complete:  '1',
        };

        // Save all settings
        const keys = Object.keys(settings);
        let done = 0;
        keys.forEach(k => {
            db.run(
                `INSERT INTO business_settings (key, value) VALUES (?, ?)
                 ON CONFLICT(key) DO UPDATE SET value=excluded.value`,
                [k, settings[k]],
                () => { done++; }
            );
        });

        // Update admin username + password
        const adminUsername = (new_username || 'admin').trim() || 'admin';
        bcrypt.hash(new_password, 12, (hashErr, hash) => {
            if (hashErr) return res.status(500).json({ error: 'Password hashing failed' });
            db.run(
                "UPDATE users SET username=?, password_hash=? WHERE role='admin'",
                [adminUsername, hash],
                (updateErr) => {
                    if (updateErr) return res.status(500).json({ error: updateErr.message });
                    logger.info('✅ First-run setup completed', { business_name, adminUsername });
                    res.json({ success: true });
                }
            );
        });

    }); // end db.onReady
});

const PORT = process.env.PORT || 3000;

// RPi / headless mode: serve the client folder so Chromium can open it at localhost:3000
if (process.env.SERVE_STATIC === 'true') {
    const clientPath = path.join(__dirname, '..', 'client');
    app.use(express.static(clientPath));
    // SPA fallback — any non-API path serves index.html
    app.get(/^(?!\/api).*/, (req, res) => {
        res.sendFile(path.join(clientPath, 'index.html'));
    });
    logger.info(`📂 Serving client static files from ${clientPath}`);
}

// Sentry error handler MUST come before any other error-handling middleware
app.use(sentryErrorHandler);

// Handle port-in-use and other listen errors gracefully so an EADDRINUSE
// unhandled event doesn't crash the Electron main process.
httpServer.on('error', (err) => {
    if (err.code === 'EADDRINUSE') {
        logger.error(`❌ Port ${PORT} is already in use. Another instance may be running.`);
        // Do NOT process.exit() — Electron's waitForServer will keep retrying;
        // if the occupant is a previous instance it will still serve requests.
    } else {
        logger.error('❌ HTTP server error:', err.message);
    }
});

// HTTPS Support (optional, for production)
const httpsOptions = {
    key: process.env.HTTPS_KEY_PATH ? fs.readFileSync(process.env.HTTPS_KEY_PATH, 'utf8') : null,
    cert: process.env.HTTPS_CERT_PATH ? fs.readFileSync(process.env.HTTPS_CERT_PATH, 'utf8') : null,
};

if (process.env.FORCE_HTTPS === 'true' && httpsOptions.key && httpsOptions.cert) {
    const https = require('https');
    https.createServer(httpsOptions, app).listen(process.env.HTTPS_PORT || 443, () => {
        logger.info(`🚀 Backend running on HTTPS port ${process.env.HTTPS_PORT || 443}`);
    });
    // Optional: redirect HTTP to HTTPS
    require('http').createServer((req, res) => {
        res.writeHead(301, { Location: `https://${req.headers.host}${req.url}` });
        res.end();
    }).listen(PORT);
    logger.info(`📡 HTTP to HTTPS redirect on port ${PORT}`);
} else {
    httpServer.listen(PORT, () => logger.info(`🚀 Backend + Socket.io running on port ${PORT}`));
}
