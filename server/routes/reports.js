const router = require('express').Router();
const { requireAuth } = require('../middleware/auth');

module.exports = function createRouter(db) {

    /* GET /api/reports/daily-sales */
    router.get('/daily-sales', requireAuth, (req, res) => {
        db.all(`
            SELECT DATE(created_at) AS day, COUNT(id) AS orders, COALESCE(SUM(total), 0) AS revenue
            FROM orders
            WHERE DATE(created_at) >= DATE('now', '-29 days')
            GROUP BY DATE(created_at)
            ORDER BY DATE(created_at) DESC
        `, [], (err, rows) => {
            if (err) return res.status(500).json([]);
            res.json(rows);
        });
    });

    /* GET /api/reports/inventory */
    router.get('/inventory', requireAuth, (req, res) => {
        db.get(`
            SELECT
                COUNT(*) AS total_products,
                SUM(CASE WHEN available=1 THEN 1 ELSE 0 END) AS available_products,
                SUM(CASE WHEN available=0 THEN 1 ELSE 0 END) AS unavailable_products,
                SUM(CASE WHEN stock <= threshold THEN 1 ELSE 0 END) AS low_stock_products
            FROM products
        `, [], (err, row) => {
            if (err) return res.status(500).json({});
            res.json(row);
        });
    });

    /* GET /api/reports/inventory/list */
    router.get('/inventory/list', requireAuth, (req, res) => {
        db.all(`
            SELECT name, stock, threshold, available,
                   CASE
                       WHEN available=0 THEN 'Unavailable'
                       WHEN stock <= threshold THEN 'Low Stock'
                       ELSE 'Available'
                   END as status
            FROM products
            ORDER BY available DESC, stock ASC
        `, [], (err, rows) => {
            if (err) return res.status(500).json([]);
            res.json(rows);
        });
    });

    return router;
};
