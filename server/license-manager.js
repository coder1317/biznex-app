'use strict';
/**
 * ╔══════════════════════════════════════════════════════════════════╗
 * ║              BIZNEX  —  LICENSE MANAGER                         ║
 * ║                                                                  ║
 * ║  Single source of truth for everything license-related:          ║
 * ║    • Reads plan from the stored JWT license token (offline-safe) ║
 * ║    • Activates a new license key against the cloud server        ║
 * ║    • Periodically re-validates and refreshes the token           ║
 * ║    • Exposes feature flags based on the active plan              ║
 * ║    • Emits events so server.js can react (gate, unlock, etc.)    ║
 * ╚══════════════════════════════════════════════════════════════════╝
 */

require('dotenv').config();
const fs           = require('fs');
const path         = require('path');
const http         = require('http');
const https        = require('https');
const crypto       = require('crypto');
const jwt          = require('jsonwebtoken');
const EventEmitter = require('events');

// ─── Constants ────────────────────────────────────────────────────────────────

/**
 * Features available per plan.
 * Add a new key here whenever you create a new gated feature in the app.
 */
const PLAN_FEATURES = {
    starter: {
        max_locations:    1,
        cloud_sync:       true,
        auto_updates:     true,
        multi_store:      false,
        priority_support: false,
        advanced_reports: false,
        custom_branding:  false,
        api_access:       false,
    },
    business: {
        max_locations:    10,
        cloud_sync:       true,
        auto_updates:     true,
        multi_store:      true,
        priority_support: true,
        advanced_reports: true,
        custom_branding:  false,
        api_access:       false,
    },
    enterprise: {
        max_locations:    Infinity,
        cloud_sync:       true,
        auto_updates:     true,
        multi_store:      true,
        priority_support: true,
        advanced_reports: true,
        custom_branding:  true,
        api_access:       true,
    },
};

/** Human-readable plan names */
const PLAN_LABELS = {
    starter:    'Starter (1 location)',
    business:   'Business (up to 10 locations)',
    enterprise: 'Enterprise (unlimited)',
};

/** How often to re-validate with the cloud server (ms) */
const VALIDATION_INTERVAL_MS = 12 * 60 * 60 * 1000; // 12 hours

// ─── LicenseManager ───────────────────────────────────────────────────────────

class LicenseManager extends EventEmitter {
    constructor() {
        super();

        // Paths
        this._root        = path.join(__dirname, '..');
        this._licenseFile = path.join(this._root, 'rpi-license.json');
        this._trialFile   = path.join(this._root, 'rpi-trial.json');

        // State
        this._plan         = null;   // 'starter' | 'business' | 'enterprise' | null
        this._token        = null;   // Raw JWT string
        this._decoded      = null;   // Decoded JWT payload
        this._licenseKey   = null;   // e.g. "BZNX-ABCD-EFGH-IJKL"
        this._deviceId     = null;
        this._active       = false;
        this._trialActive  = false;
        this._trialDaysLeft = 0;
        this._validating   = false;
        this._validationTimer = null;

        // Cloud server URL (falls back to localhost for development)
        this._serverUrl = (process.env.LICENSE_SERVER_URL || 'http://localhost:4000').replace(/\/$/, '');
        this._skipCheck = process.env.SKIP_LICENSE_CHECK === 'true';
    }

    // ── Public API ─────────────────────────────────────────────────────────────

    /** Current plan name, or null if not activated */
    getPlan()       { return this._plan; }

    /** Human-readable plan label */
    getPlanLabel()  { return this._plan ? (PLAN_LABELS[this._plan] || this._plan) : 'No license'; }

    /** The stored license key string */
    getLicenseKey() { return this._licenseKey; }

    /** Whether the license is currently active */
    isActive()      { return this._active; }

    /** The cloud server base URL */
    getServerUrl()  { return this._serverUrl; }

    /**
     * Check if a feature is enabled under the current plan.
     * @param {string} feature - Key from PLAN_FEATURES (e.g. 'multi_store')
     * @returns {boolean}
     */
    isFeatureEnabled(feature) {
        if (!this._plan) return false;
        const features = PLAN_FEATURES[this._plan] || {};
        return features[feature] === true || features[feature] > 0;
    }

    /**
     * Get the full features object for the current plan.
     * Returns all-false object if not activated.
     */
    getFeatures() {
        if (!this._plan) {
            return Object.fromEntries(Object.keys(PLAN_FEATURES.starter).map(k => [k, false]));
        }
        return { ...(PLAN_FEATURES[this._plan] || {}) };
    }

    /**
     * Full status snapshot — used by the /api/license/status endpoint.
     */
    getStatus() {
        return {
            active:        this._active,
            plan:          this._plan,
            planLabel:     this.getPlanLabel(),
            licenseKey:    this._licenseKey,
            deviceId:      this._deviceId,
            features:      this.getFeatures(),
            expiresAt:     this._decoded?.expiresAt || null,
            validatedAt:   this._decoded?.validatedAt || null,
            maxSeats:      this._decoded?.maxSeats || null,
            serverUrl:     this._serverUrl,
            skipCheck:     this._skipCheck,
            trialActive:   this._trialActive,
            trialDaysLeft: this._trialDaysLeft,
        };
    }

    // ── Initialisation  ────────────────────────────────────────────────────────

    /**
     * Call this ONCE at startup (before routes are loaded).
     * Returns a Promise that resolves when the license state is known.
     *
     * Events emitted:
     *   'activated'        — license loaded/activated successfully  ({ plan, ... })
     *   'needs-activation' — no valid licence/trial found          ()
     *   'trial-active'     — no licence but trial is running        ({ daysLeft })
     *   'expired'          — trial OR licence has expired           ()
     *   'validation-ok'    — periodic online check passed           ({ plan })
     *   'validation-fail'  — periodic online check failed           ({ reason })
     */
    async init() {
        this._deviceId = this._getDeviceId();

        // Dev bypass — skip everything
        if (this._skipCheck) {
            this._plan   = 'enterprise';  // full access in dev
            this._active = true;
            this.emit('activated', { plan: this._plan, dev: true });
            this._log('info', '⚡ License check skipped (SKIP_LICENSE_CHECK=true) — using enterprise plan in dev');
            return;
        }

        // 1. Try loading from saved license file
        const saved = this._loadSavedLicense();
        if (saved && saved.licenseToken) {
            const decoded = this._decodeSavedToken(saved.licenseToken);
            if (decoded) {
                // Token is locally valid (not expired)
                this._applyToken(saved.licenseKey, decoded, saved.licenseToken);
                this._log('info', `✅ License loaded from disk — plan: ${this._plan}`);
                this.emit('activated', this.getStatus());

                // Fire async online validation in the background (don't block startup)
                setImmediate(() => this._backgroundValidate());
                this._schedulePeriodicValidation();
                return;
            }
        }

        // 2. Try the trial
        const trial = this._loadTrial();
        if (trial && this._isTrialActive(trial)) {
            this._trialActive   = true;
            this._trialDaysLeft = this._trialDaysLeft_(trial);
            this._active        = true;
            this._plan          = 'starter'; // trial gets starter feature set
            this._log('info', `⏱ Trial active — ${this._trialDaysLeft} day(s) remaining`);
            this.emit('trial-active', { daysLeft: this._trialDaysLeft });
            return;
        }

        // 3. Trial expired?
        if (trial && !this._isTrialActive(trial)) {
            this._log('warn', '⌛ Trial has expired');
            this.emit('expired');
            this.emit('needs-activation');
            return;
        }

        // 4. Nothing found
        this._log('info', '🔑 No license or trial found — needs activation');
        this.emit('needs-activation');
    }

    // ── Activation  ────────────────────────────────────────────────────────────

    /**
     * Activate a license key against the cloud server.
     * Saves the token to disk and updates internal state.
     *
     * @param {string} licenseKey  e.g. "BZNX-ABCD-1234-EFGH-5678"
     * @param {string} [deviceId]  defaults to hostname
     * @returns {Promise<{ ok: boolean, plan?: string, error?: string }>}
     */
    async activate(licenseKey, deviceId) {
        deviceId = deviceId || this._deviceId;
        const deviceName = require('os').hostname();

        this._log('info', `🔑 Activating license key: ${licenseKey}`);

        try {
            const response = await this._post('/api/license/activate', {
                key:         licenseKey,
                device_id:   deviceId,
                device_name: deviceName,
            });

            if (!response.success) {
                return { ok: false, error: response.error || 'Activation failed' };
            }

            // Decode and store
            const decoded = this._decodeSavedToken(response.licenseToken);
            if (!decoded) {
                return { ok: false, error: 'Invalid license token received from server' };
            }

            this._applyToken(licenseKey, decoded, response.licenseToken);

            // Persist to disk
            const stored = {
                licenseKey,
                plan:         response.plan || this._plan,
                planLabel:    PLAN_LABELS[this._plan] || this._plan,
                maxDevices:   decoded.maxSeats || 1,
                deviceId,
                activatedAt:  new Date().toISOString(),
                licenseToken: response.licenseToken,
            };
            fs.writeFileSync(this._licenseFile, JSON.stringify(stored, null, 2));

            this._log('info', `✅ License activated — plan: ${this._plan}`);
            this.emit('activated', this.getStatus());
            this._schedulePeriodicValidation();

            return { ok: true, plan: this._plan, ...this.getStatus() };
        } catch (err) {
            this._log('error', `❌ Activation error: ${err.message}`);
            return { ok: false, error: err.message || 'Cloud server not reachable' };
        }
    }

    /**
     * Deactivate this device from the cloud server.
     * Removes the local license file.
     *
     * @param {string} bearerToken  A valid account JWT (from login)
     * @returns {Promise<{ ok: boolean, error?: string }>}
     */
    async deactivate(bearerToken) {
        if (!this._licenseKey || !this._deviceId) {
            return { ok: false, error: 'No active license to deactivate' };
        }
        try {
            await this._post('/api/license/deactivate',
                { key: this._licenseKey, device_id: this._deviceId },
                bearerToken,
            );
            this._clearLocalLicense();
            this._log('info', '🔓 License deactivated and local file removed');
            this.emit('needs-activation');
            return { ok: true };
        } catch (err) {
            return { ok: false, error: err.message };
        }
    }

    /**
     * Manually trigger an online license validation.
     * Called by the periodic timer and can also be called from routes.
     * @returns {Promise<{ valid: boolean, plan?: string, reason?: string }>}
     */
    async validate() {
        if (!this._licenseKey || !this._deviceId) {
            return { valid: false, reason: 'No license key stored' };
        }
        if (this._validating) return { valid: this._active, reason: 'Validation already in progress' };

        this._validating = true;
        try {
            const response = await this._post('/api/license/validate', {
                key:       this._licenseKey,
                device_id: this._deviceId,
            });

            if (response.valid && response.licenseToken) {
                const decoded = this._decodeSavedToken(response.licenseToken);
                if (decoded) {
                    this._applyToken(this._licenseKey, decoded, response.licenseToken);
                    // Update disk token too
                    const saved = this._loadSavedLicense() || {};
                    saved.licenseToken = response.licenseToken;
                    saved.plan         = this._plan;
                    fs.writeFileSync(this._licenseFile, JSON.stringify(saved, null, 2));
                }
                this._log('info', `🔄 License re-validated — plan: ${this._plan}`);
                this.emit('validation-ok', { plan: this._plan });
                return { valid: true, plan: this._plan };
            } else {
                const reason = response.reason || response.error || 'Invalid';
                this._log('warn', `⚠️ License validation failed: ${reason}`);
                this.emit('validation-fail', { reason });
                return { valid: false, reason };
            }
        } catch (err) {
            // Network error — don't revoke the license (offline grace applies)
            this._log('warn', `⚠️ Online validation unreachable: ${err.message} — running on cached token`);
            this.emit('validation-fail', { reason: 'Server unreachable (offline mode)' });
            return { valid: this._active, reason: 'Server unreachable — offline mode' };
        } finally {
            this._validating = false;
        }
    }

    // ── Trial helpers (called from server.js RPi gate) ─────────────────────────

    /**
     * Start or read the trial.
     * @param {number} [trialDays=14]
     * @returns {{ active: boolean, daysLeft: number, startedAt: string }}
     */
    startOrReadTrial(trialDays) {
        trialDays = parseInt(process.env.TRIAL_DAYS || trialDays || 14, 10);
        let t = this._loadTrial();
        if (!t) {
            t = { startedAt: new Date().toISOString(), trialDays };
            fs.writeFileSync(this._trialFile, JSON.stringify(t, null, 2));
        }
        return {
            active:    this._isTrialActive(t),
            daysLeft:  this._trialDaysLeft_(t),
            trialDays,
            startedAt: t.startedAt,
        };
    }

    // ── Private helpers ────────────────────────────────────────────────────────

    _getDeviceId() {
        return require('os').hostname() + '-bos';
    }

    _loadSavedLicense() {
        try {
            return JSON.parse(fs.readFileSync(this._licenseFile, 'utf8'));
        } catch { return null; }
    }

    _loadTrial() {
        try {
            return JSON.parse(fs.readFileSync(this._trialFile, 'utf8'));
        } catch { return null; }
    }

    _isTrialActive(trial) {
        if (!trial?.startedAt) return false;
        const days = parseInt(trial.trialDays || process.env.TRIAL_DAYS || 14, 10);
        return (Date.now() - new Date(trial.startedAt).getTime()) / 86400000 < days;
    }

    _trialDaysLeft_(trial) {
        if (!trial?.startedAt) return 0;
        const days = parseInt(trial.trialDays || process.env.TRIAL_DAYS || 14, 10);
        return Math.max(0, Math.ceil(days - (Date.now() - new Date(trial.startedAt).getTime()) / 86400000));
    }

    /**
     * Decode a JWT without verifying the signature.
     * We use the cloud server's JWT_SECRET for full verify in `validate()`.
     * For local reading (offline mode) we just decode the payload.
     */
    _decodeSavedToken(token) {
        try {
            // Try full verification first (if JWT_SECRET is available)
            if (process.env.JWT_SECRET) {
                try {
                    return jwt.verify(token, process.env.JWT_SECRET);
                } catch (verifyErr) {
                    // Token may be signed by cloud-server's secret which differs
                    // from local JWT_SECRET — fall back to simple decode
                }
            }
            // Decode without verification (offline safe)
            return jwt.decode(token);
        } catch { return null; }
    }

    _applyToken(licenseKey, decoded, rawToken) {
        this._licenseKey = licenseKey;
        this._token      = rawToken;
        this._decoded    = decoded;
        this._plan       = decoded.plan || 'starter';
        this._active     = true;
        this._deviceId   = decoded.deviceId || this._deviceId;
    }

    _clearLocalLicense() {
        this._plan       = null;
        this._token      = null;
        this._decoded    = null;
        this._licenseKey = null;
        this._active     = false;
        try { fs.unlinkSync(this._licenseFile); } catch {}
    }

    async _backgroundValidate() {
        try { await this.validate(); } catch {}
    }

    _schedulePeriodicValidation() {
        if (this._validationTimer) clearInterval(this._validationTimer);
        this._validationTimer = setInterval(() => this._backgroundValidate(), VALIDATION_INTERVAL_MS);
        // Don't prevent process.exit()
        if (this._validationTimer.unref) this._validationTimer.unref();
    }

    /**
     * Simple HTTP/HTTPS POST to the license server.
     * @param {string} path           API path e.g. '/api/license/activate'
     * @param {object} body           JSON body
     * @param {string} [bearerToken]  Optional Authorization header
     * @returns {Promise<object>}     Parsed JSON response
     */
    _post(apiPath, body, bearerToken) {
        return new Promise((resolve, reject) => {
            const payload = JSON.stringify(body);
            const url     = new URL(this._serverUrl + apiPath);
            const isHttps = url.protocol === 'https:';
            const options = {
                hostname: url.hostname,
                port:     url.port || (isHttps ? 443 : 80),
                path:     url.pathname + url.search,
                method:   'POST',
                headers:  {
                    'Content-Type':   'application/json',
                    'Content-Length': Buffer.byteLength(payload),
                    ...(bearerToken ? { Authorization: `Bearer ${bearerToken}` } : {}),
                },
                timeout: 10000, // 10s timeout
            };

            const lib = isHttps ? https : http;
            const req = lib.request(options, (res) => {
                let data = '';
                res.on('data', (chunk) => { data += chunk; });
                res.on('end', () => {
                    try {
                        resolve(JSON.parse(data));
                    } catch {
                        reject(new Error(`Non-JSON response from license server (status ${res.statusCode})`));
                    }
                });
            });

            req.on('timeout', () => { req.destroy(); reject(new Error('License server request timed out')); });
            req.on('error', (err) => reject(err));
            req.write(payload);
            req.end();
        });
    }

    _log(level, msg) {
        const prefix = '[LicenseManager]';
        if (level === 'error') console.error(prefix, msg);
        else if (level === 'warn') console.warn(prefix, msg);
        else console.log(prefix, msg);
    }
}

// ─── Singleton export ─────────────────────────────────────────────────────────
module.exports = new LicenseManager();
