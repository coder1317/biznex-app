const router = require('express').Router();
const { requireAuth, requireAdmin } = require('../middleware/auth');

module.exports = function createRouter(db, logger) {

    /* GET /api/settings */
    router.get('/', requireAuth, (req, res) => {
        db.all('SELECT key, value FROM business_settings', [], (err, rows) => {
            if (err) return res.status(500).json({ error: err.message });
            const settings = {};
            (rows || []).forEach(r => { settings[r.key] = r.value; });
            res.json(settings);
        });
    });

    /* PATCH /api/settings */
    router.patch('/', requireAdmin, (req, res) => {
        const updates = req.body;
        if (!updates || typeof updates !== 'object')
            return res.status(400).json({ error: 'Body must be a key-value object' });
        const keys = Object.keys(updates);
        if (keys.length === 0) return res.json({ updated: 0 });

        let completed = 0;
        let failed = false;
        keys.forEach(k => {
            db.run(
                `INSERT INTO business_settings (key, value) VALUES (?, ?)
                 ON CONFLICT(key) DO UPDATE SET value=excluded.value`,
                [k, String(updates[k])],
                (err) => {
                    if (err && !failed) { failed = true; return res.status(500).json({ error: err.message }); }
                    completed++;
                    if (completed === keys.length && !failed) res.json({ updated: keys.length });
                }
            );
        });
    });

    return router;
};
