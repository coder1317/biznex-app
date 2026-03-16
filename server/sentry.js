/**
 * Sentry crash reporting — Embedded Express Server
 *
 * Usage in server.js:
 *   const { initSentry, Handlers } = require('./sentry');
 *   initSentry(app);   // call before any routes
 *   // ...define routes...
 *   app.use(Handlers.error);  // MUST be the last middleware
 */

const SENSITIVE_KEYS = /password|secret|token|key|auth|credentials|session/i;

let _sentry = null;

/**
 * Initialise Sentry for the embedded Express server and attach request handler.
 * If SENTRY_DSN is not set, this is a no-op — all exported helpers become safe stubs.
 *
 * @param {import('express').Application} app
 */
function initSentry(app) {
    const dsn = process.env.SENTRY_DSN;
    if (!dsn) return;

    try {
        const Sentry = require('@sentry/node');

        Sentry.init({
            dsn,
            release: `biznex-bos-server@${process.env.npm_package_version || '1.0.0'}`,
            environment: process.env.NODE_ENV || 'production',
            sampleRate: 1.0,
            attachStacktrace: true,
            beforeSend: scrubEvent,
        });

        _sentry = Sentry;

        // Must be first middleware — captures request context
        app.use(Sentry.Handlers.requestHandler());
        app.use(Sentry.Handlers.tracingHandler());

        console.log('[Sentry] Initialised for Express server');
    } catch (err) {
        console.error('[Sentry] Failed to initialise:', err.message);
    }
}

/**
 * Sentry error-handler middleware — attach AFTER all routes.
 * If Sentry is not configured, falls through to the default Express error handler.
 */
function errorHandler(err, req, res, next) {
    if (_sentry) {
        _sentry.Handlers.errorHandler()(err, req, res, next);
    } else {
        next(err);
    }
}

/**
 * Capture an exception from application code.
 */
function captureException(err, extras = {}) {
    if (!_sentry) return;
    try {
        _sentry.withScope((scope) => {
            Object.entries(extras).forEach(([k, v]) => scope.setExtra(k, v));
            _sentry.captureException(err);
        });
    } catch (_) { /* silent */ }
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function scrubEvent(event) {
    try { scrubObject(event); } catch (_) {}
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

module.exports = { initSentry, errorHandler, captureException };
