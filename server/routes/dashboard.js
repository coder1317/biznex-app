const router = require('express').Router();
const { requireAuth } = require('../middleware/auth');

module.exports = function createRouter(db) {

    /* GET /api/dashboard/sales-range */
    router.get('/sales-range', requireAuth, (req, res) => {
        const range = req.query.range || 'today';
        const VALID_RANGES = {
            today: "DATE(created_at) = DATE('now')",
            '7d':  "DATE(created_at) >= DATE('now', '-6 days')",
            '30d': "DATE(created_at) >= DATE('now', '-29 days')",
        };
        const dateCondition = VALID_RANGES[range];
        if (!dateCondition) return res.json([]);

        db.all(`
            SELECT DATE(created_at) AS day, COUNT(id) AS orders, SUM(total) AS revenue
            FROM orders
            WHERE ${dateCondition}
            GROUP BY DATE(created_at)
            ORDER BY DATE(created_at)
        `, [], (err, rows) => {
            if (err) return res.status(500).json([]);
            res.json(rows);
        });
    });

    /* GET /api/dashboard/daily-sales */
    router.get('/daily-sales', requireAuth, (req, res) => {
        db.get(`
            SELECT COUNT(id) as orders, COALESCE(SUM(total), 0) as revenue
            FROM orders
            WHERE DATE(created_at) = DATE('now')
        `, [], (err, row) => {
            if (err) return res.status(500).json({});
            res.json(row || { orders: 0, revenue: 0 });
        });
    });

    /* GET /api/dashboard/stock */
    router.get('/stock', requireAuth, (req, res) => {
        db.all(`
            SELECT COUNT(*) AS total_products,
                   SUM(CASE WHEN stock <= 5 THEN 1 ELSE 0 END) AS low_stock
            FROM products
        `, [], (err, rows) => {
            if (err) return res.status(500).json({});
            res.json(rows[0]);
        });
    });

    /* GET /api/dashboard/recent-orders */
    router.get('/recent-orders', requireAuth, (req, res) => {
        db.all(`
            SELECT id, total, created_at FROM orders ORDER BY id DESC LIMIT 5
        `, [], (err, rows) => {
            if (err) return res.status(500).json([]);
            res.json(rows);
        });
    });

    return router;
};
