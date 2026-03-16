const router = require('express').Router();
const { requireAuth, requireAdmin } = require('../middleware/auth');

module.exports = function createRouter(db) {

    /* GET /api/inventory/low-stock */
    router.get('/low-stock', requireAuth, (req, res) => {
        db.all(`
            SELECT id, name, stock, threshold FROM products
            WHERE stock <= threshold ORDER BY stock ASC
        `, [], (err, rows) => {
            if (err) return res.status(500).json([]);
            res.json(rows);
        });
    });

    /* GET /api/inventory/suppliers */
    router.get('/suppliers', requireAuth, (req, res) => {
        db.all(`
            SELECT s.name as supplier_name, s.contact_person, s.email, s.phone,
                   COUNT(p.id) as product_count,
                   SUM(p.stock) as total_stock,
                   SUM(CASE WHEN p.stock <= p.threshold THEN 1 ELSE 0 END) as low_stock_count
            FROM suppliers s
            LEFT JOIN products p ON s.id = p.supplier_id
            GROUP BY s.id, s.name, s.contact_person, s.email, s.phone
            ORDER BY s.name
        `, [], (err, rows) => {
            if (err) return res.status(500).json([]);
            res.json(rows);
        });
    });

    return router;
};
