/**
 * Sentry crash reporting — Main Process initialisation
 *
 * Call initSentry() ONCE at the very top of main.js before anything else.
 * The SDK wires up:
 *   • Uncaught exceptions in the main process
 *   • Unhandled promise rejections in the main process
 *   • Child-process crashes (renderer / GPU)
 *
 * The renderer is covered by preload.js which inits @sentry/electron/renderer.
 */

const { app } = require('electron');

let _initialized = false;

/**
 * Initialise Sentry for the Electron main process.
 * Safe to call in dev — if SENTRY_DSN is not set, does nothing.
 */
function initSentry() {
    if (_initialized) return;
    _initialized = true;

    const dsn = process.env.SENTRY_DSN;
    if (!dsn) {
        // No DSN configured — skip silently (normal in dev)
        return;
    }

    try {
        const { init, setTag } = require('@sentry/electron/main');

        init({
            dsn,
            // Release string matches the version in package.json
            release: `biznex-bos@${app.getVersion()}`,
            environment: process.env.NODE_ENV || 'production',

            // Capture all unhandled exceptions & promise rejections
            integrations: (defaults) => defaults,

            // Sample 100 % of errors; lower this if you hit quota limits
            sampleRate: 1.0,

            // Don't send source maps — set to true if you upload them to Sentry
            attachStacktrace: true,

            beforeSend(event) {
                // Scrub any field names that look like they may contain credentials
                return scrubEvent(event);
            },
        });

        // Tag every event with the OS-level app version
        setTag('electron.version', process.versions.electron);
        setTag('node.version', process.versions.node);
        setTag('platform', process.platform);

        console.log('[Sentry] Initialised for main process (env:', process.env.NODE_ENV, ')');
    } catch (err) {
        // If Sentry fails to load (e.g. missing dep), log and continue — never crash the app over analytics
        console.error('[Sentry] Failed to initialise:', err.message);
    }
}

/**
 * Capture an Error or message from application code.
 * Usage: captureException(new Error('something went wrong'))
 */
function captureException(err, extras = {}) {
    if (!_initialized) return;
    try {
        const { captureException: _cap, withScope } = require('@sentry/electron/main');
        withScope((scope) => {
            Object.entries(extras).forEach(([k, v]) => scope.setExtra(k, v));
            _cap(err);
        });
    } catch (_) { /* silent */ }
}

/**
 * Capture a plain message (non-exception).
 */
function captureMessage(msg, level = 'info') {
    if (!_initialized) return;
    try {
        const { captureMessage: _cap } = require('@sentry/electron/main');
        _cap(msg, level);
    } catch (_) { /* silent */ }
}

// ─── Private helpers ─────────────────────────────────────────────────────────

const SENSITIVE_KEYS = /password|secret|token|key|auth|credentials|session/i;

function scrubEvent(event) {
    try {
        scrubObject(event);
    } catch (_) { /* ignore scrubbing errors */ }
    return event;
}

function scrubObject(obj) {
    if (!obj || typeof obj !== 'object') return;
    for (const key of Object.keys(obj)) {
        if (SENSITIVE_KEYS.test(key)) {
            obj[key] = '[Scrubbed]';
        } else {
            scrubObject(obj[key]);
        }
    }
}

module.exports = { initSentry, captureException, captureMessage };
