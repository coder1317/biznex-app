/**
 * proto-license-server.js
 *
 * Embedded licensing server — runs inside the Electron app on port 4000.
 * Keys encode the plan tier in their prefix:
 *
 *   BZNX-STR-XXXXXXXX-XXXXXXXX  → Starter   (1 device)
 *   BZNX-BIZ-XXXXXXXX-XXXXXXXX  → Business  (up to 10 devices)
 *   BZNX-ENT-XXXXXXXX-XXXXXXXX  → Enterprise (unlimited)
 *
 * Endpoints:
 *  GET  /health
 *  POST /api/auth/login         { email, password }          → accessToken
 *  POST /api/license/activate   { key, device_id, device_name }
 *  POST /api/license/validate   { key, device_id }
 *  POST /api/license/deactivate { key, device_id }
 *  POST /api/admin/generate-key { plan, customerName, customerEmail, adminSecret }
 *
 * Trial:
 *  POST /api/trial/start        { device_id } → starts/returns trial status
 *  GET  /api/trial/status?device_id=XXX
 */

require('dotenv').config();
const http    = require('http');
const crypto  = require('crypto');
const path    = require('path');
const sqlite3 = require('sqlite3').verbose();
const jwt     = require('jsonwebtoken');
const bcrypt  = require('bcryptjs');

const PORT         = process.env.LICENSE_PORT  || 4000;
const SECRET       = process.env.JWT_SECRET    || 'proto-dev-secret-change-in-prod';
const GRACE        = parseInt(process.env.OFFLINE_GRACE_DAYS || '7', 10);
const TRIAL_DAYS   = parseInt(process.env.TRIAL_DAYS || '14', 10);
const DB_PATH      = process.env.PROTO_DB_PATH || path.join(__dirname, 'proto-license.db');
const ADMIN_SECRET = process.env.LICENSE_ADMIN_SECRET || 'biznex-admin-2026';

// Warn loudly if running with default admin secret in production
if (process.env.NODE_ENV === 'production' && ADMIN_SECRET === 'biznex-admin-2026') {
    console.error('[license-server] ⚠️  LICENSE_ADMIN_SECRET is set to the default value. Set a strong secret in .env before deploying.');
}
if (!process.env.JWT_SECRET) {
    console.warn('[license-server] ⚠️  JWT_SECRET not set — using insecure default. Set JWT_SECRET in .env for production.');
}

// ─── Plan configuration ───────────────────────────────────────────────────────
const PLAN_CONFIG = {
    starter:    { prefix: 'STR', maxDevices: 1,         label: 'Starter' },
    business:   { prefix: 'BIZ', maxDevices: 10,        label: 'Business' },
    enterprise: { prefix: 'ENT', maxDevices: Infinity,  label: 'Enterprise' },
};

// Derive plan from key prefix
function planFromKey(key) {
    const m = key && key.match(/^BZNX-(STR|BIZ|ENT)-/);
    if (!m) return 'starter'; // default safe
    const map = { STR: 'starter', BIZ: 'business', ENT: 'enterprise' };
    return map[m[1]] || 'starter';
}

// Generate a key with plan prefix
function generateKey(plan = 'starter') {
    const cfg = PLAN_CONFIG[plan] || PLAN_CONFIG.starter;
    const seg = () => crypto.randomBytes(4).toString('hex').toUpperCase();
    return `BZNX-${cfg.prefix}-${seg()}-${seg()}`;
}

// ─── DB setup ────────────────────────────────────────────────────────────────
const db = new sqlite3.Database(DB_PATH, (err) => {
    if (err) { console.error('DB open error:', err); process.exit(1); }
    console.log(`[db] SQLite at ${DB_PATH}`);
});

// Promisify helpers
const dbRun = (sql, p=[]) => new Promise((resolve, reject) => db.run(sql, p, function(e){ e ? reject(e) : resolve(this); }));
const dbGet = (sql, p=[]) => new Promise((resolve, reject) => db.get(sql, p, (e, r) => e ? reject(e) : resolve(r)));
const dbAll = (sql, p=[]) => new Promise((resolve, reject) => db.all(sql, p, (e, r) => e ? reject(e) : resolve(r)));

db.serialize(() => {
    db.run('PRAGMA journal_mode = WAL');
    db.run(`CREATE TABLE IF NOT EXISTS accounts (
        id         INTEGER PRIMARY KEY AUTOINCREMENT,
        email      TEXT UNIQUE NOT NULL,
        password   TEXT NOT NULL,
        name       TEXT NOT NULL,
        role       TEXT NOT NULL DEFAULT 'customer',
        created_at TEXT NOT NULL DEFAULT (datetime('now'))
    )`);
    db.run(`CREATE TABLE IF NOT EXISTS license_keys (
        id          INTEGER PRIMARY KEY AUTOINCREMENT,
        key         TEXT UNIQUE NOT NULL,
        account_id  INTEGER REFERENCES accounts(id),
        plan        TEXT NOT NULL DEFAULT 'starter',
        max_devices INTEGER NOT NULL DEFAULT 1,
        is_active   INTEGER NOT NULL DEFAULT 1,
        customer_name  TEXT,
        customer_email TEXT,
        created_at  TEXT NOT NULL DEFAULT (datetime('now'))
    )`);
    db.run(`CREATE TABLE IF NOT EXISTS activations (
        id              INTEGER PRIMARY KEY AUTOINCREMENT,
        license_key_id  INTEGER NOT NULL REFERENCES license_keys(id),
        device_id       TEXT NOT NULL,
        device_name     TEXT,
        is_active       INTEGER NOT NULL DEFAULT 1,
        last_seen_at    TEXT NOT NULL DEFAULT (datetime('now')),
        UNIQUE(license_key_id, device_id)
    )`);
    db.run(`CREATE TABLE IF NOT EXISTS trials (
        id          INTEGER PRIMARY KEY AUTOINCREMENT,
        device_id   TEXT UNIQUE NOT NULL,
        started_at  TEXT NOT NULL DEFAULT (datetime('now'))
    )`);

    // ─── Column migrations (safe to run on existing DBs) ───────────────────
    const migrations = [
        `ALTER TABLE license_keys ADD COLUMN max_devices    INTEGER NOT NULL DEFAULT 1`,
        `ALTER TABLE license_keys ADD COLUMN customer_name  TEXT`,
        `ALTER TABLE license_keys ADD COLUMN customer_email TEXT`,
    ];
    for (const sql of migrations) {
        db.run(sql, (err) => {
            // SQLITE_ERROR "duplicate column name" is expected if column already exists — ignore it
            if (err && !err.message.includes('duplicate column name')) {
                console.warn('[db] migration warning:', err.message);
            }
        });
    }
    db.run('SELECT 1', () => console.log('[db] Schema ready'));
});

// ─── Helpers ───────────────────────────────────────────────────────────────────
function signToken(payload, expiresIn) {
    return jwt.sign(payload, SECRET, { expiresIn });
}

function makeLicenseToken(key, deviceId, plan) {
    return signToken({ licenseKey: key, deviceId, plan, validatedAt: new Date().toISOString() }, `${GRACE}d`);
}

// ─── HTTP server (no framework dep — uses only built-ins + sqlite + jwt + bcrypt) ──
function readBody(req) {
    return new Promise((resolve, reject) => {
        let raw = '';
        req.on('data', c => raw += c);
        req.on('end', () => { try { resolve(JSON.parse(raw || '{}')); } catch { resolve({}); } });
        req.on('error', reject);
    });
}

function send(res, status, body) {
    const data = JSON.stringify(body);
    res.writeHead(status, {
        'Content-Type':  'application/json',
        'Content-Length': Buffer.byteLength(data),
        'Access-Control-Allow-Origin':  '*',
        'Access-Control-Allow-Headers': 'Content-Type, Authorization',
        'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
    });
    res.end(data);
}

// ─── Route handlers ───────────────────────────────────────────────────────────

async function handleLogin(req, res) {
    const { email, password } = await readBody(req);
    if (!email || !password) return send(res, 400, { error: 'email and password required' });

    const account = await dbGet('SELECT * FROM accounts WHERE email=?', [email]);
    if (!account) return send(res, 401, { error: 'Invalid email or password' });

    const match = await bcrypt.compare(password, account.password);
    if (!match) return send(res, 401, { error: 'Invalid email or password' });

    const accessToken = signToken({ id: account.id, email: account.email, role: account.role }, '2h');
    const keys = await dbAll('SELECT key, plan, is_active, created_at FROM license_keys WHERE account_id=? AND is_active=1', [account.id]);

    send(res, 200, { accessToken, email: account.email, name: account.name, keys });
}

async function handleActivate(req, res) {
    const { key, device_id, device_name } = await readBody(req);
    if (!key || !device_id) return send(res, 400, { error: 'key and device_id required' });

    const licKey = await dbGet('SELECT * FROM license_keys WHERE key=? AND is_active=1', [key]);
    if (!licKey) return send(res, 404, { error: 'License key not found or has been revoked' });

    // Check if this device is already activated on this key
    const existing = await dbGet(
        'SELECT id FROM activations WHERE license_key_id=? AND device_id=? AND is_active=1',
        [licKey.id, device_id]
    );

    if (!existing) {
        // Count currently active devices for this key
        const { activeCount } = await dbGet(
            'SELECT COUNT(*) AS activeCount FROM activations WHERE license_key_id=? AND is_active=1',
            [licKey.id]
        );
        const maxDevices = licKey.max_devices || 1;

        if (maxDevices !== 999 && activeCount >= maxDevices) {
            const plan = PLAN_CONFIG[licKey.plan] || PLAN_CONFIG.starter;
            return send(res, 403, {
                error: `This ${plan.label} license is already active on ${activeCount} device(s) (max: ${maxDevices}). ` +
                       `Deactivate another device first or upgrade your plan.`,
                reason: 'device_limit_reached',
                plan: licKey.plan,
                maxDevices,
                activeDevices: activeCount,
            });
        }
    }

    await dbRun(
        `INSERT INTO activations (license_key_id, device_id, device_name)
         VALUES (?,?,?)
         ON CONFLICT(license_key_id, device_id) DO UPDATE
           SET is_active=1, last_seen_at=datetime('now'), device_name=excluded.device_name`,
        [licKey.id, device_id, device_name || null]
    );

    const plan = licKey.plan || planFromKey(key);
    const maxDev = licKey.max_devices === 999 ? 'Unlimited' : licKey.max_devices;
    console.log(`[activate] key=${key} plan=${plan} device=${device_id}`);

    const licenseToken = makeLicenseToken(key, device_id, plan);
    send(res, 200, {
        success: true,
        licenseToken,
        plan,
        planLabel: (PLAN_CONFIG[plan] || {}).label || plan,
        maxDevices: maxDev,
    });
}

async function handleValidate(req, res) {
    const { key, device_id } = await readBody(req);
    if (!key || !device_id) return send(res, 400, { error: 'key and device_id required' });

    const row = await dbGet(`SELECT lk.plan, lk.is_active, a.is_active AS act_active
        FROM license_keys lk
        JOIN activations a ON a.license_key_id=lk.id
        WHERE lk.key=? AND a.device_id=?`, [key, device_id]);

    if (!row)            return send(res, 404, { valid: false, reason: 'Not activated on this device' });
    if (!row.is_active)  return send(res, 403, { valid: false, reason: 'License key revoked' });
    if (!row.act_active) return send(res, 403, { valid: false, reason: 'Activation revoked' });

    await dbRun(`UPDATE activations SET last_seen_at=datetime('now')
        WHERE license_key_id=(SELECT id FROM license_keys WHERE key=?) AND device_id=?`, [key, device_id]);

    const licenseToken = makeLicenseToken(key, device_id, row.plan);
    send(res, 200, { valid: true, plan: row.plan, licenseToken });
}

async function handleDeactivate(req, res) {
    const { key, device_id } = await readBody(req);
    if (!key || !device_id) return send(res, 400, { error: 'key and device_id required' });

    const licKey = await dbGet('SELECT id FROM license_keys WHERE key=?', [key]);
    if (!licKey) return send(res, 404, { error: 'License key not found' });

    await dbRun(
        `UPDATE activations SET is_active=0, last_seen_at=datetime('now')
         WHERE license_key_id=? AND device_id=?`,
        [licKey.id, device_id]
    );
    console.log(`[deactivate] key=${key} device=${device_id}`);
    send(res, 200, { success: true });
}

// Trial: start or fetch trial for a device
async function handleTrialStart(req, res) {
    const { device_id } = await readBody(req);
    if (!device_id) return send(res, 400, { error: 'device_id required' });

    let trial = await dbGet('SELECT * FROM trials WHERE device_id=?', [device_id]);
    if (!trial) {
        await dbRun('INSERT OR IGNORE INTO trials (device_id) VALUES (?)', [device_id]);
        trial = await dbGet('SELECT * FROM trials WHERE device_id=?', [device_id]);
    }

    const startMs      = new Date(trial.started_at).getTime();
    const expiresMs    = startMs + TRIAL_DAYS * 24 * 60 * 60 * 1000;
    const daysLeft     = Math.max(0, Math.ceil((expiresMs - Date.now()) / (24 * 60 * 60 * 1000)));
    const trialActive  = daysLeft > 0;

    send(res, 200, { trialActive, daysLeft, trialDays: TRIAL_DAYS, startedAt: trial.started_at });
}

async function handleTrialStatus(req, res) {
    const device_id = new URL(req.url, 'http://localhost').searchParams.get('device_id');
    if (!device_id) return send(res, 400, { error: 'device_id required' });

    const trial = await dbGet('SELECT * FROM trials WHERE device_id=?', [device_id]);
    if (!trial) return send(res, 200, { trialActive: false, daysLeft: 0, started: false });

    const startMs   = new Date(trial.started_at).getTime();
    const expiresMs = startMs + TRIAL_DAYS * 24 * 60 * 60 * 1000;
    const daysLeft  = Math.max(0, Math.ceil((expiresMs - Date.now()) / (24 * 60 * 60 * 1000)));
    send(res, 200, { trialActive: daysLeft > 0, daysLeft, trialDays: TRIAL_DAYS, started: true });
}

async function handleAdminGenerateKey(req, res) {
    const { plan = 'starter', customerName = 'Customer', customerEmail, adminSecret, key: suppliedKey } = await readBody(req);
    if (adminSecret !== ADMIN_SECRET) return send(res, 403, { error: 'Invalid admin secret' });
    if (!PLAN_CONFIG[plan]) return send(res, 400, { error: `Invalid plan. Use: ${Object.keys(PLAN_CONFIG).join(', ')}` });

    const key = suppliedKey || generateKey(plan);
    const cfg = PLAN_CONFIG[plan];
    const maxDevices = cfg.maxDevices === Infinity ? 999 : cfg.maxDevices;

    // Idempotent — if the key is already registered, return it without error
    const existing = await dbGet('SELECT * FROM license_keys WHERE key=?', [key]);
    if (existing) {
        console.log(`[admin] key already exists: ${key}`);
        return send(res, 200, {
            key: existing.key,
            plan: existing.plan,
            maxDevices: existing.max_devices,
            created_at: existing.created_at,
            alreadyExisted: true,
        });
    }

    await dbRun(
        `INSERT INTO license_keys (key, plan, max_devices, customer_name, customer_email, is_active)
         VALUES (?,?,?,?,?,1)`,
        [key, plan, maxDevices, customerName || null, customerEmail || null]
    );
    const row = await dbGet('SELECT * FROM license_keys WHERE key=?', [key]);
    console.log(`[admin] generated key=${key} plan=${plan} customer=${customerEmail || 'N/A'}`);
    send(res, 200, { key: row.key, plan: row.plan, maxDevices: row.max_devices, created_at: row.created_at });
}

// ─── Router ──────────────────────────────────────────────────────────────────────────
const server = http.createServer(async (req, res) => {
    // CORS preflight
    if (req.method === 'OPTIONS') { send(res, 204, {}); return; }

    try {
        const url = req.url.split('?')[0]; // strip query string for routing
        if (req.method === 'GET'  && req.url.startsWith('/health'))                  { send(res, 200, { status: 'ok', mode: 'biznex-license', version: '2.0' }); return; }
        if (req.method === 'POST' && url === '/api/auth/login')                      { await handleLogin(req, res); return; }
        if (req.method === 'POST' && url === '/api/license/activate')                { await handleActivate(req, res); return; }
        if (req.method === 'POST' && url === '/api/license/validate')                { await handleValidate(req, res); return; }
        if (req.method === 'POST' && url === '/api/license/deactivate')              { await handleDeactivate(req, res); return; }
        if (req.method === 'POST' && url === '/api/admin/generate-key')              { await handleAdminGenerateKey(req, res); return; }
        if (req.method === 'POST' && url === '/api/trial/start')                     { await handleTrialStart(req, res); return; }
        if (req.method === 'GET'  && req.url.startsWith('/api/trial/status'))        { await handleTrialStatus(req, res); return; }
        // Legacy: keep register endpoint so old activate.html doesn't break
        if (req.method === 'POST' && url === '/api/auth/register')                   { send(res, 410, { error: 'Self-registration is disabled. Contact Biznex to get a license key.' }); return; }

        send(res, 404, { error: 'Not found' });
    } catch (err) {
        console.error('[error]', err);
        send(res, 500, { error: 'Internal server error' });
    }
});

server.listen(PORT, () => {
    console.log(`[license-server] Running on port ${PORT} | Admin secret: ${ADMIN_SECRET}`);
    console.log(`[license-server] Plans: STR=1 device, BIZ=10 devices, ENT=unlimited`);
    console.log(`[license-server] To generate a key: POST /api/admin/generate-key { plan, adminSecret, customerName, customerEmail }`);
});

server.on('error', (err) => {
    if (err.code === 'EADDRINUSE') {
        console.log(`[license-server] Port ${PORT} already in use — assuming another instance is running, continuing.`);
    } else {
        console.error('[license-server] Server error:', err.message);
    }
});
