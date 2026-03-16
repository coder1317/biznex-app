const router = require('express').Router();
const { requireAuth, requireAdmin } = require('../middleware/auth');

module.exports = function createRouter(db, io) {

    /* GET  /api/products */
    router.get('/', requireAuth, (req, res) => {
        const page   = Math.max(1, parseInt(req.query.page)  || 1);
        const limit  = Math.min(200, Math.max(1, parseInt(req.query.limit) || 200));
        const offset = (page - 1) * limit;

        db.get('SELECT COUNT(*) AS total FROM products', [], (cntErr, cntRow) => {
            if (cntErr) return res.status(500).json([]);
            db.all(
                'SELECT id, name, price, stock, threshold, category, image, available FROM products LIMIT ? OFFSET ?',
                [limit, offset],
                (err, rows) => {
                    if (err) return res.status(500).json([]);
                    res.json({ data: rows, total: cntRow.total, page, limit });
                }
            );
        });
    });

    /* POST /api/products */
    router.post('/', requireAdmin, (req, res) => {
        const { name, price, stock, threshold, available, category, image } = req.body;
        if (!name || typeof price === 'undefined' || typeof stock === 'undefined' || !category)
            return res.status(400).json({ error: 'Missing required fields' });

        const availInsert = (available ?? 1) ? 1 : 0;
        db.run(
            'INSERT INTO products (name, price, stock, threshold, category, image, available) VALUES (?, ?, ?, ?, ?, ?, ?)',
            [name, price, stock, threshold || 5, category, image || null, availInsert],
            function (err) {
                if (err) {
                    if (err.message && err.message.includes('UNIQUE'))
                        return res.status(400).json({ error: 'Product with this name already exists' });
                    return res.status(500).json({ error: err.message });
                }
                const productId = this.lastID;
                io.emit('product:created', { id: productId, name, category });
                res.status(201).json({ 
                    id: productId, 
                    name, 
                    price: Number(price), 
                    stock: Number(stock), 
                    threshold: threshold || 5, 
                    category, 
                    image: image || null, 
                    available: availInsert 
                });
            }
        );
    });

    /* PUT /api/products/:id */
    router.put('/:id', requireAdmin, (req, res) => {
        const { name, price, stock, threshold, available, category, image } = req.body;
        const id = Number(req.params.id);
        const availUpdate = (available ?? 1) ? 1 : 0;
        db.run(
            'UPDATE products SET name=?, price=?, stock=?, threshold=?, category=?, image=?, available=? WHERE id=?',
            [name, price, stock, threshold, category, image || null, availUpdate, id],
            function (err) {
                if (err) return res.status(500).json({ error: err.message });
                db.get('SELECT stock FROM products WHERE id=?', [id], (e, row) => {
                    if (!e && row && row.stock <= 0) {
                        db.run('UPDATE products SET available=0 WHERE id=?', [id], (ee) => {
                            if (ee) console.error('Failed to enforce availability after update:', ee.message);
                            io.emit('product:updated', { id });
                            return res.json({ updated: this.changes });
                        });
                    } else {
                        io.emit('product:updated', { id });
                        return res.json({ updated: this.changes });
                    }
                });
            }
        );
    });

    /* PATCH /api/products/:id/availability */
    router.patch('/:id/availability', requireAdmin, (req, res) => {
        const { id } = req.params;
        const { available } = req.body;
        db.get('SELECT stock FROM products WHERE id=?', [id], (err, row) => {
            if (err) return res.status(500).json({ error: err.message });
            const requestedAvailable = Number(available) ? 1 : 0;
            if (row && row.stock <= 0 && requestedAvailable === 1)
                return res.status(400).json({ error: 'Cannot enable product with zero stock' });
            db.run(
                'UPDATE products SET available=? WHERE id=?',
                [requestedAvailable, id],
                function (e2) {
                    if (e2) return res.status(500).json({ error: e2.message });
                    io.emit('product:updated', { id: Number(id) });
                    res.json({ success: true });
                }
            );
        });
    });

    /* DELETE /api/products/:id */
    router.delete('/:id', requireAdmin, (req, res) => {
        const id = Number(req.params.id);
        db.run('DELETE FROM products WHERE id=?', [id], function (err) {
            if (err) return res.status(500).json({ error: err.message });
            io.emit('product:deleted', { id });
            res.json({ deleted: this.changes });
        });
    });

    /* POST /api/products/:id/image */
    router.post('/:id/image', requireAdmin, (req, res) => {
        const { image } = req.body;
        const id = Number(req.params.id);
        if (!image) return res.status(400).json({ error: 'No image provided' });
        if (typeof image !== 'string' || !image.startsWith('data:image/'))
            return res.status(400).json({ error: 'Image must be a valid base64 data URI (e.g. data:image/png;base64,...)' });
        const MAX_BASE64_LEN = 2 * 1024 * 1024 * 1.37;
        if (image.length > MAX_BASE64_LEN)
            return res.status(413).json({ error: 'Image too large. Maximum size is 2 MB.' });

        db.run('UPDATE products SET image=? WHERE id=?', [image, id], function (err) {
            if (err) return res.status(500).json({ error: err.message });
            res.json({ updated: this.changes });
        });
    });

    /* POST /api/products/:id/restock */
    router.post('/:id/restock', requireAuth, (req, res) => {
        const productId = req.params.id;
        const { quantity, supplier_id } = req.body;
        if (!quantity || quantity <= 0)
            return res.status(400).json({ error: 'Valid quantity is required' });
        db.run(
            "UPDATE products SET stock=stock+?, last_restock_date=datetime('now','localtime'), supplier_id=? WHERE id=?",
            [quantity, supplier_id || null, productId],
            function (err) {
                if (err) return res.status(500).json({ error: 'Failed to restock product' });
                if (this.changes === 0) return res.status(404).json({ error: 'Product not found' });
                res.json({ message: 'Product restocked successfully' });
            }
        );
    });

    return router;
};
