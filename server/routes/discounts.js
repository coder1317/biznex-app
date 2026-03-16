  const router = require('express').Router();
const { requireAuth, requireAdmin } = require('../middleware/auth');

module.exports = function createRouter(db) {

    router.get('/', requireAdmin, (req, res) => {
        db.all('SELECT id, code, type, value, active FROM discounts', [], (err, rows) => {
            if (err) return res.status(500).json([]);
            res.json(rows);
        });
    });

    router.post('/', requireAdmin, (req, res) => {
        const { code, type, value } = req.body;
        if (!code || !type || typeof value !== 'number')
            return res.status(400).json({ error: 'Code, type, and value required' });
        if (!['percentage', 'fixed'].includes(type))
            return res.status(400).json({ error: 'Type must be percentage or fixed' });
        db.run(
            'INSERT INTO discounts (code, type, value) VALUES (?, ?, ?)',
            [code, type, value],
            function (err) {
                if (err) {
                    if (err.message.includes('UNIQUE'))
                        return res.status(400).json({ error: 'Discount code already exists' });
                    return res.status(500).json({ error: err.message });
                }
                res.json({ id: this.lastID });
            }
        );
    });

    router.put('/:id', requireAdmin, (req, res) => {
        const { code, type, value, active } = req.body;
        const id = Number(req.params.id);
        db.run(
            'UPDATE discounts SET code=?, type=?, value=?, active=? WHERE id=?',
            [code, type, value, active ? 1 : 0, id],
            function (err) {
                if (err) return res.status(500).json({ error: err.message });
                res.json({ updated: this.changes });
            }
        );
    });

    router.delete('/:id', requireAdmin, (req, res) => {
        const id = Number(req.params.id);
        db.run('DELETE FROM discounts WHERE id=?', [id], function (err) {
            if (err) return res.status(500).json({ error: err.message });
            res.json({ deleted: this.changes });
        });
    });

    router.post('/validate', requireAuth, (req, res) => {
        const { code } = req.body;
        if (!code) return res.status(400).json({ error: 'Code required' });
        db.get(
            'SELECT type, value FROM discounts WHERE code=? AND active=1',
            [code],
            (err, row) => {
                if (err) return res.status(500).json({ error: err.message });
                if (!row) return res.status(404).json({ error: 'Invalid or inactive discount code' });
                res.json({ type: row.type, value: row.value });
            }
        );
    });

    return router;
};
