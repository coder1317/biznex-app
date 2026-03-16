const jwt = require('jsonwebtoken');

const SENSITIVE_FIELDS = new Set([
    'password', 'password_hash', 'token', 'refreshToken',
    'accessToken', 'adminSecret', 'newPassword', 'new_password',
]);

function sanitizeBody(body) {
    if (!body || typeof body !== 'object') return body;
    const clean = { ...body };
    SENSITIVE_FIELDS.forEach(k => { if (k in clean) clean[k] = '[REDACTED]'; });
    return clean;
}

function requireAuth(req, res, next) {
    const token = req.headers.authorization?.replace('Bearer ', '');
    if (!token) return res.status(401).json({ error: 'Authentication required' });
    try {
        const decoded = jwt.verify(token, process.env.JWT_SECRET);
        req.user = {
            id: decoded.id,
            username: decoded.username,
            role: decoded.role,
            permissions: decoded.permissions || [],
        };
        next();
    } catch {
        return res.status(401).json({ error: 'Invalid token' });
    }
}

function requireAdmin(req, res, next) {
    if (req.user) {
        if (req.user.role === 'admin') return next();
        return res.status(403).json({ error: 'Admin access required' });
    }
    requireAuth(req, res, () => {
        if (req.user && req.user.role === 'admin') return next();
        return res.status(403).json({ error: 'Admin access required' });
    });
}

module.exports = { requireAuth, requireAdmin, sanitizeBody };
