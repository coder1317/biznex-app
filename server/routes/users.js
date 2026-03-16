const router = require('express').Router();
const bcrypt = require('bcryptjs');
const { requireAdmin } = require('../middleware/auth');

module.exports = function createRouter(db, logger) {

    router.get('/', requireAdmin, (req, res) => {
        db.all('SELECT id, username, role, permissions FROM users', [], (err, rows) => {
            if (err) {
                logger.error('Users fetch error:', err.message);
                return res.status(500).json([]);
            }
            const out = (rows || []).map(r => {
                try { r.permissions = r.permissions ? JSON.parse(r.permissions) : []; } catch { r.permissions = []; }
                return r;
            });
            res.json(out);
        });
    });

    router.post('/', requireAdmin, (req, res) => {
        const { username, password, role, permissions } = req.body;
        if (!username || !password || !role) {
            return res.status(400).json({ error: 'Username, password, and role required' });
        }
        if (!['admin', 'cashier'].includes(role)) {
            return res.status(400).json({ error: 'Invalid role' });
        }
        let permJson = '[]';
        try {
            if (Array.isArray(permissions)) permJson = JSON.stringify(permissions);
            else if (typeof permissions === 'string' && permissions.trim())
                permJson = JSON.stringify(permissions.split(',').map(s => s.trim()));
        } catch { permJson = '[]'; }

        bcrypt.hash(password, 10, (err, hash) => {
            if (err) return res.status(500).json({ error: 'Password hashing failed' });
            db.run(
                'INSERT INTO users (username, password_hash, role, permissions) VALUES (?, ?, ?, ?)',
                [username, hash, role, permJson],
                function (err2) {
                    if (err2) {
                        if (err2.message.includes('UNIQUE'))
                            return res.status(400).json({ error: 'Username already exists' });
                        return res.status(500).json({ error: err2.message });
                    }
                    res.json({ id: this.lastID });
                }
            );
        });
    });

    router.put('/:id', requireAdmin, (req, res) => {
        const { username, password, role, permissions } = req.body;
        const id = Number(req.params.id);
        if (!username || !role) return res.status(400).json({ error: 'Username and role required' });
        if (!['admin', 'cashier'].includes(role)) return res.status(400).json({ error: 'Invalid role' });

        let permJson = null;
        try {
            if (permissions !== undefined) {
                permJson = Array.isArray(permissions)
                    ? JSON.stringify(permissions)
                    : JSON.stringify(String(permissions).split(',').map(s => s.trim()));
            }
        } catch { permJson = '[]'; }

        const update = (hash) => {
            const params = hash
                ? (permJson !== null ? [username, hash, role, permJson, id] : [username, hash, role, id])
                : (permJson !== null ? [username, role, permJson, id] : [username, role, id]);
            const sql = hash
                ? (permJson !== null
                    ? 'UPDATE users SET username=?, password_hash=?, role=?, permissions=? WHERE id=?'
                    : 'UPDATE users SET username=?, password_hash=?, role=? WHERE id=?')
                : (permJson !== null
                    ? 'UPDATE users SET username=?, role=?, permissions=? WHERE id=?'
                    : 'UPDATE users SET username=?, role=? WHERE id=?');
            db.run(sql, params, function (err) {
                if (err) return res.status(500).json({ error: err.message });
                res.json({ updated: this.changes });
            });
        };

        if (password) {
            bcrypt.hash(password, 10, (err, hash) => {
                if (err) return res.status(500).json({ error: 'Password hashing failed' });
                update(hash);
            });
        } else {
            update(null);
        }
    });

    router.delete('/:id', requireAdmin, (req, res) => {
        const id = Number(req.params.id);
        if (id === req.user.id) return res.status(400).json({ error: 'Cannot delete yourself' });
        db.run('DELETE FROM users WHERE id = ?', [id], function (err) {
            if (err) return res.status(500).json({ error: err.message });
            res.json({ deleted: this.changes });
        });
    });

    return router;
};
