const router = require('express').Router();
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const crypto = require('crypto');
const Joi = require('joi');
const { requireAuth } = require('../middleware/auth');

module.exports = function createRouter(db, logger) {

    router.post('/login', (req, res) => {
        const schema = Joi.object({
            username: Joi.string().min(1).required(),
            password: Joi.string().min(1).required(),
        });
        const { error } = schema.validate(req.body);
        if (error) return res.status(400).json({ error: error.details[0].message });

        const { username, password } = req.body;
        db.get(
            'SELECT id, username, password_hash, role, permissions FROM users WHERE username = ?',
            [username],
            (err, user) => {
                if (err) {
                    logger.error('Login DB error:', err.message);
                    return res.status(500).json({ error: 'Database error' });
                }
                if (!user) return res.status(401).json({ error: 'Invalid credentials' });

                bcrypt.compare(password, user.password_hash, (err2, match) => {
                    if (err2) {
                        logger.error('Password compare error:', err2.message);
                        return res.status(500).json({ error: 'Authentication error' });
                    }
                    if (!match) return res.status(401).json({ error: 'Invalid credentials' });

                    let perms = [];
                    try { perms = user.permissions ? JSON.parse(user.permissions) : []; } catch { perms = []; }

                    const accessToken = jwt.sign(
                        { id: user.id, username: user.username, role: user.role, permissions: perms },
                        process.env.JWT_SECRET,
                        { expiresIn: '1h' }
                    );
                    const refreshToken = crypto.randomBytes(48).toString('hex');
                    const expiresAt = new Date(Date.now() + 7 * 24 * 3600 * 1000).toISOString();

                    db.run(
                        'INSERT INTO refresh_tokens (user_id, token, expires_at) VALUES (?, ?, ?)',
                        [user.id, refreshToken, expiresAt],
                        (rtErr) => { if (rtErr) logger.error('Store refresh token failed', rtErr.message); }
                    );

                    logger.info('User logged in:', user.username);
                    res.json({
                        user: { id: user.id, username: user.username, role: user.role, permissions: perms },
                        token: accessToken,
                        accessToken,
                        refreshToken,
                    });
                });
            }
        );
    });

    router.post('/logout', requireAuth, (req, res) => {
        const { refreshToken } = req.body || {};
        if (refreshToken) {
            db.run('DELETE FROM refresh_tokens WHERE token = ?', [refreshToken], (err) => {
                if (err) logger.error('Logout: failed to delete refresh token', err.message);
            });
        }
        res.json({ success: true });
    });

    router.post('/refresh', (req, res) => {
        const { refreshToken } = req.body || {};
        if (!refreshToken) return res.status(400).json({ error: 'Refresh token required' });

        const sql = `
            SELECT rt.token, rt.expires_at, rt.user_id, u.username, u.role, u.permissions
            FROM refresh_tokens rt
            JOIN users u ON rt.user_id = u.id
            WHERE rt.token = ?`;

        db.get(sql, [refreshToken], (err, row) => {
            if (err || !row) return res.status(401).json({ error: 'Invalid refresh token' });
            if (new Date(row.expires_at) < new Date()) {
                db.run('DELETE FROM refresh_tokens WHERE token = ?', [refreshToken]);
                return res.status(401).json({ error: 'Refresh token expired, please log in again' });
            }

            let perms = [];
            try { perms = row.permissions ? JSON.parse(row.permissions) : []; } catch { perms = []; }

            const accessToken = jwt.sign(
                { id: row.user_id, username: row.username, role: row.role, permissions: perms },
                process.env.JWT_SECRET,
                { expiresIn: '1h' }
            );
            const newRefreshToken = crypto.randomBytes(48).toString('hex');
            const expiresAt = new Date(Date.now() + 7 * 24 * 3600 * 1000).toISOString();
            db.run(
                'UPDATE refresh_tokens SET token = ?, expires_at = ? WHERE token = ?',
                [newRefreshToken, expiresAt, refreshToken],
                (updErr) => { if (updErr) logger.error('Refresh token rotation failed', updErr.message); }
            );

            res.json({ token: accessToken, accessToken, refreshToken: newRefreshToken });
        });
    });

    router.get('/me', requireAuth, (req, res) => {
        db.get(
            'SELECT id, username, role, permissions FROM users WHERE id = ?',
            [req.user.id],
            (err, row) => {
                if (err) {
                    logger.error('Failed to fetch user for /me:', err.message);
                    return res.status(500).json({ error: 'Database error' });
                }
                if (!row) return res.status(404).json({ error: 'User not found' });
                let perms = [];
                try { perms = row.permissions ? JSON.parse(row.permissions) : []; } catch { perms = []; }
                res.json({ user: { id: row.id, username: row.username, role: row.role, permissions: perms } });
            }
        );
    });

    return router;
};
