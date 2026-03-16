/**
 * electron-shell/license.js
 *
 * Handles all licensing logic in the main process:
 *  - Device fingerprinting
 *  - Storing / loading the license token from userData
 *  - Offline grace period check (JWT expiry)
 *  - Online validate / activate calls to the cloud server
 *  - Trial period management
 */

const os     = require('os');
const path   = require('path');
const fs     = require('fs');
const crypto = require('crypto');
const https  = require('https');
const http   = require('http');

// ─── Plan configuration (mirrors proto-license-server.js) ────────────────────
const PLAN_CONFIG = {
    starter:    { label: 'Starter',    maxDevices: 1,   badge: 'STR', color: '#6366f1' },
    business:   { label: 'Business',   maxDevices: 10,  badge: 'BIZ', color: '#0ea5e9' },
    enterprise: { label: 'Enterprise', maxDevices: null, badge: 'ENT', color: '#10b981' },
    trial:      { label: 'Trial',      maxDevices: 1,   badge: 'TRL', color: '#f59e0b' },
};

const TRIAL_DAYS = 14;

// Derive plan from key prefix (BZNX-STR-... / BZNX-BIZ-... / BZNX-ENT-...)
function getPlanFromKey(key) {
    if (!key) return null;
    const m = key.match(/^BZNX-(STR|BIZ|ENT)-/);
    if (!m) return null;
    return { STR: 'starter', BIZ: 'business', ENT: 'enterprise' }[m[1]] || null;
}

// ─── Device fingerprint ───────────────────────────────────────────────────────
function getDeviceId() {
    try {
        // Build a stable string from hardware info
        const cpuModel  = (os.cpus()[0] && os.cpus()[0].model) || '';
        const platform  = os.platform();
        const arch      = os.arch();
        const hostname  = os.hostname();

        // First non-internal MAC address we can find
        let mac = '';
        const ifaces = os.networkInterfaces();
        outer: for (const iface of Object.values(ifaces)) {
            for (const entry of iface) {
                if (!entry.internal && entry.mac && entry.mac !== '00:00:00:00:00:00') {
                    mac = entry.mac;
                    break outer;
                }
            }
        }

        const raw = `${platform}|${arch}|${cpuModel}|${hostname}|${mac}`;
        return crypto.createHash('sha256').update(raw).digest('hex').slice(0, 40);
    } catch {
        // Fallback: random persistent ID
        return crypto.randomBytes(20).toString('hex');
    }
}

// ─── Storage ─────────────────────────────────────────────────────────────────
function getLicensePath(userDataPath) {
    return path.join(userDataPath, 'license.json');
}

function loadStoredLicense(userDataPath) {
    try {
        const raw = fs.readFileSync(getLicensePath(userDataPath), 'utf8');
        return JSON.parse(raw);
    } catch {
        return null;
    }
}

function storeLicense(userDataPath, data) {
    fs.writeFileSync(getLicensePath(userDataPath), JSON.stringify(data, null, 2), 'utf8');
}

function clearLicense(userDataPath) {
    try { fs.unlinkSync(getLicensePath(userDataPath)); } catch {}
}

// ─── Minimal JWT decode (no verify — that's the server's job) ─────────────────
function decodeJwt(token) {
    try {
        const [, payload] = token.split('.');
        return JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
    } catch {
        return null;
    }
}

// ─── HTTP helper (works for both http and https) ──────────────────────────────
function cloudRequest(serverUrl, method, endpoint, body, accessToken) {
    return new Promise((resolve, reject) => {
        const url  = new URL(endpoint, serverUrl);
        const data = body ? JSON.stringify(body) : null;
        const opts = {
            hostname: url.hostname,
            port:     url.port || (url.protocol === 'https:' ? 443 : 80),
            path:     url.pathname + url.search,
            method,
            headers: {
                'Content-Type':  'application/json',
                'Accept':        'application/json',
                ...(data       ? { 'Content-Length': Buffer.byteLength(data) } : {}),
                ...(accessToken ? { 'Authorization': `Bearer ${accessToken}` }  : {}),
            },
        };
        const lib = url.protocol === 'https:' ? https : http;
        const req = lib.request(opts, (res) => {
            let raw = '';
            res.on('data', (chunk) => raw += chunk);
            res.on('end', () => {
                try {
                    resolve({ status: res.statusCode, body: JSON.parse(raw) });
                } catch {
                    resolve({ status: res.statusCode, body: raw });
                }
            });
        });
        req.on('error', reject);
        req.setTimeout(8000, () => { req.destroy(new Error('Request timed out')); });
        if (data) req.write(data);
        req.end();
    });
}

// ─── Public API ──────────────────────────────────────────────────────────────

/**
 * Check if a locally stored license token is still within its grace period.
 * Returns { valid: bool, reason: string, data: tokenPayload|null }
 */
function checkLocalLicense(userDataPath) {
    const stored = loadStoredLicense(userDataPath);
    if (!stored || !stored.licenseToken) {
        return { valid: false, reason: 'no_license' };
    }
    const payload = decodeJwt(stored.licenseToken);
    if (!payload) return { valid: false, reason: 'invalid_token' };

    const now = Math.floor(Date.now() / 1000);
    if (payload.exp && payload.exp < now) {
        return { valid: false, reason: 'grace_period_expired' };
    }
    return { valid: true, reason: 'ok', data: payload, email: stored.email };
}

/**
 * Validate license against the cloud server.
 * Updates the stored token on success.
 * Falls back to local check on network failure (grace period).
 */
async function validateOnline(userDataPath, serverUrl) {
    const stored = loadStoredLicense(userDataPath);
    if (!stored || !stored.licenseKey) {
        return { valid: false, reason: 'no_license' };
    }
    const deviceId = getDeviceId();

    try {
        const res = await cloudRequest(serverUrl, 'POST', '/api/license/validate', {
            key:       stored.licenseKey,
            device_id: deviceId,
        });

        if (res.status === 200 && res.body.valid) {
            // Refresh stored token
            stored.licenseToken = res.body.licenseToken;
            stored.plan         = res.body.plan;
            storeLicense(userDataPath, stored);
            return { valid: true, reason: 'ok', plan: res.body.plan };
        }
        return { valid: false, reason: res.body.reason || 'server_rejected' };
    } catch (err) {
        // Network error — fall back to local grace period
        console.warn('[license] Cloud validation failed, checking grace period:', err.message);
        return checkLocalLicense(userDataPath);
    }
}

/**
 * Activate a license key against the license server.
 * Only the key is needed — no account login required.
 */
async function activateLicense(userDataPath, serverUrl, { licenseKey }) {
    const deviceId   = getDeviceId();
    const deviceName = `${os.hostname()} (${os.platform()})`;

    let activateRes;
    try {
        activateRes = await cloudRequest(serverUrl, 'POST', '/api/license/activate', {
            key:         licenseKey,
            device_id:   deviceId,
            device_name: deviceName,
        });
    } catch (err) {
        return { success: false, error: 'Cannot reach license server. Check your internet connection.' };
    }

    if (activateRes.status !== 200) {
        return { success: false, error: activateRes.body.error || 'Activation failed' };
    }

    const plan      = activateRes.body.plan || 'starter';
    const maxDevices = activateRes.body.maxDevices;

    storeLicense(userDataPath, {
        licenseKey,
        licenseToken: activateRes.body.licenseToken,
        plan,
        maxDevices,
        planLabel: activateRes.body.planLabel || plan,
        deviceId,
        activatedAt: new Date().toISOString(),
    });

    return { success: true, plan, planLabel: activateRes.body.planLabel, maxDevices };
}

/**
 * Deactivate this device (free up the seat).
 */
async function deactivateLicense(userDataPath, serverUrl) {
    const stored = loadStoredLicense(userDataPath);
    if (!stored) return { success: false, error: 'No license stored' };

    try {
        const res = await cloudRequest(serverUrl, 'POST', '/api/license/deactivate', {
            key:       stored.licenseKey,
            device_id: getDeviceId(),
        }, stored.accessToken);

        clearLicense(userDataPath);
        return { success: true };
    } catch (err) {
        return { success: false, error: err.message };
    }
}

// ─── Trial period ─────────────────────────────────────────────────────────────
function getTrialPath(userDataPath) {
    return path.join(userDataPath, 'trial.json');
}

function loadTrial(userDataPath) {
    try {
        return JSON.parse(fs.readFileSync(getTrialPath(userDataPath), 'utf8'));
    } catch { return null; }
}

/**
 * Check trial status WITHOUT starting it.
 * Returns { started, active, trialActive, daysLeft, trialDays, startedAt? }
 */
function checkTrial(userDataPath) {
    const trial = loadTrial(userDataPath);
    if (!trial) {
        // No trial started yet — never auto-start; user must click "Start Trial"
        return { started: false, active: false, trialActive: false, daysLeft: 0, trialDays: TRIAL_DAYS };
    }
    const startMs   = new Date(trial.startedAt).getTime();
    const expiresMs = startMs + TRIAL_DAYS * 24 * 60 * 60 * 1000;
    const daysLeft  = Math.max(0, Math.ceil((expiresMs - Date.now()) / (24 * 60 * 60 * 1000)));
    const active    = daysLeft > 0;
    return { started: true, active, trialActive: active, daysLeft, trialDays: TRIAL_DAYS, startedAt: trial.startedAt };
}

/**
 * Explicitly start the trial (called when user clicks "Start Trial" button).
 * No-op if trial already started. Returns current trial status.
 */
function startTrial(userDataPath) {
    const existing = loadTrial(userDataPath);
    if (!existing) {
        const trial = { startedAt: new Date().toISOString() };
        fs.writeFileSync(getTrialPath(userDataPath), JSON.stringify(trial, null, 2), 'utf8');
    }
    return checkTrial(userDataPath);
}

module.exports = {
    PLAN_CONFIG,
    TRIAL_DAYS,
    getPlanFromKey,
    getDeviceId,
    checkLocalLicense,
    validateOnline,
    activateLicense,
    deactivateLicense,
    loadStoredLicense,
    clearLicense,
    checkTrial,
    startTrial,
};
