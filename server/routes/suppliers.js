const router = require('express').Router();
const { requireAdmin } = require('../middleware/auth');

module.exports = function createRouter(db) {

    router.get('/', requireAdmin, (req, res) => {
        db.all('SELECT * FROM suppliers ORDER BY name', [], (err, rows) => {
            if (err) return res.status(500).json([]);
            res.json(rows);
        });
    });

    router.post('/', requireAdmin, (req, res) => {
        const { name, contact_person, email, phone, address } = req.body;
        if (!name) return res.status(400).json({ error: 'Supplier name is required' });
        db.run(
            'INSERT INTO suppliers (name, contact_person, email, phone, address) VALUES (?, ?, ?, ?, ?)',
            [name, contact_person, email, phone, address],
            function (err) {
                if (err) return res.status(500).json({ error: 'Failed to create supplier' });
                res.json({ id: this.lastID, message: 'Supplier created successfully' });
            }
        );
    });

    router.put('/:id', requireAdmin, (req, res) => {
        const supplierId = req.params.id;
        const { name, contact_person, email, phone, address } = req.body;
        if (!name) return res.status(400).json({ error: 'Supplier name is required' });
        db.run(
            'UPDATE suppliers SET name=?, contact_person=?, email=?, phone=?, address=? WHERE id=?',
            [name, contact_person, email, phone, address, supplierId],
            function (err) {
                if (err) return res.status(500).json({ error: 'Failed to update supplier' });
                if (this.changes === 0) return res.status(404).json({ error: 'Supplier not found' });
                res.json({ message: 'Supplier updated successfully' });
            }
        );
    });

    router.delete('/:id', requireAdmin, (req, res) => {
        const supplierId = req.params.id;
        db.get('SELECT COUNT(*) as count FROM products WHERE supplier_id=?', [supplierId], (err, row) => {
            if (err) return res.status(500).json({ error: 'Failed to check supplier usage' });
            if (row.count > 0)
                return res.status(400).json({ error: 'Cannot delete supplier that has associated products' });
            db.run('DELETE FROM suppliers WHERE id=?', [supplierId], function (err2) {
                if (err2) return res.status(500).json({ error: 'Failed to delete supplier' });
                if (this.changes === 0) return res.status(404).json({ error: 'Supplier not found' });
                res.json({ message: 'Supplier deleted successfully' });
            });
        });
    });

    return router;
};
