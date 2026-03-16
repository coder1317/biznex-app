const router = require('express').Router();
const { requireAuth } = require('../middleware/auth');

module.exports = function createRouter(db, io, logger, getPrinter, printReceipt) {

    /* GET /api/orders */
    router.get('/', requireAuth, (req, res) => {
        const page   = Math.max(1, parseInt(req.query.page)  || 1);
        const limit  = Math.min(500, Math.max(1, parseInt(req.query.limit) || 50));
        const offset = (page - 1) * limit;

        db.get('SELECT COUNT(*) AS total FROM orders', [], (cntErr, cntRow) => {
            if (cntErr) return res.status(500).json([]);
            db.all(`
                SELECT o.id, o.total, o.payment_mode, o.created_at,
                       GROUP_CONCAT(oi.name || ' x ' || oi.quantity, ', ') AS items
                FROM orders o
                LEFT JOIN order_items oi ON o.id = oi.order_id
                GROUP BY o.id
                ORDER BY o.id DESC
                LIMIT ? OFFSET ?
            `, [limit, offset], (err, rows) => {
                if (err) return res.status(500).json([]);
                res.json({ data: rows, total: cntRow.total, page, limit });
            });
        });
    });

    /* GET /api/orders/:id */
    router.get('/:id', requireAuth, (req, res) => {
        const orderId = req.params.id;
        db.get(
            'SELECT id, total, payment_mode, created_at, discount_code, discount_amount FROM orders WHERE id=?',
            [orderId],
            (err, order) => {
                if (err || !order) return res.status(404).json({ error: 'Order not found' });
                const subtotal = order.total + (order.discount_amount || 0);
                db.all(
                    'SELECT product_id, name, quantity, price, line_total FROM order_items WHERE order_id=? ORDER BY id ASC',
                    [orderId],
                    (err2, items) => {
                        if (err2) return res.status(500).json({ error: 'Items error' });
                        const cleanItems = items.map(i => ({
                            product_id: i.product_id,
                            name: i.name || 'Unknown',
                            quantity: typeof i.quantity === 'number' ? i.quantity : 0,
                            price: typeof i.price === 'number' ? i.price : 0,
                            line_total: typeof i.line_total === 'number' ? i.line_total : (i.quantity || 0) * (i.price || 0),
                        }));
                        res.json({ order: { ...order, subtotal }, items: cleanItems });
                    }
                );
            }
        );
    });

    /* POST /api/orders */
    router.post('/', requireAuth, async (req, res) => {
        const { items, payment_mode, discount_code } = req.body;
        if (!items || !Array.isArray(items) || items.length === 0)
            return res.status(400).json({ error: 'Empty cart' });

        const dbGet = (sql, params) => new Promise((resolve, reject) =>
            db.get(sql, params, (err, row) => err ? reject(err) : resolve(row)));
        const dbRun = (sql, params) => new Promise((resolve, reject) =>
            db.run(sql, params, function (err) { err ? reject(err) : resolve(this); }));

        try {
            for (const it of items) {
                if (!it.product_id || !it.name || typeof it.quantity !== 'number' || typeof it.line_total !== 'number')
                    return res.status(400).json({ error: 'Invalid item payload' });
                const product = await dbGet('SELECT stock, available FROM products WHERE id=?', [it.product_id]);
                if (!product) return res.status(400).json({ error: `Product not found: ${it.name}` });
                if (!product.available) return res.status(400).json({ error: `Product unavailable: ${it.name}` });
                if (product.stock < it.quantity) return res.status(400).json({ error: `Insufficient stock for ${it.name}` });
            }

            const subtotal = items.reduce((s, i) => s + Number(i.line_total || (i.price * i.quantity || 0)), 0);

            let discountAmount = 0;
            if (discount_code) {
                const discount = await dbGet('SELECT type, value FROM discounts WHERE code=? AND active=1', [discount_code]);
                if (!discount) return res.status(400).json({ error: 'Invalid discount code' });
                discountAmount = discount.type === 'percentage'
                    ? subtotal * (discount.value / 100)
                    : discount.value;
                discountAmount = Math.min(discountAmount, subtotal);
            }
            const total = subtotal - discountAmount;

            await dbRun('BEGIN TRANSACTION', []);

            const orderRes = await new Promise((resolve, reject) =>
                db.run(
                    'INSERT INTO orders (total, payment_mode, discount_code, discount_amount) VALUES (?, ?, ?, ?)',
                    [total, payment_mode || 'cash', discount_code || null, discountAmount],
                    function (err) { err ? reject(err) : resolve({ id: this.lastID }); }
                )
            );
            const orderId = orderRes.id;

            for (const it of items) {
                await dbRun(
                    'INSERT INTO order_items (order_id, product_id, name, price, quantity, line_total) VALUES (?, ?, ?, ?, ?, ?)',
                    [orderId, it.product_id, it.name, it.price, it.quantity, it.line_total]
                );
                await dbRun('UPDATE products SET stock=stock-? WHERE id=?', [it.quantity, it.product_id]);
                const postStock = await dbGet('SELECT name, stock, threshold FROM products WHERE id=?', [it.product_id]);
                if (postStock && postStock.stock <= 0) {
                    await dbRun('UPDATE products SET available=0 WHERE id=?', [it.product_id]);
                    io.emit('product:updated', { id: it.product_id });
                } else if (postStock && postStock.stock > 0 && postStock.stock <= (postStock.threshold || 5)) {
                    io.emit('stock:low', { id: it.product_id, name: postStock.name, stock: postStock.stock });
                }
            }

            await dbRun('COMMIT', []);

            const createdAt = new Date().toISOString();
            res.json({ order_id: orderId, total, subtotal, discount_amount: discountAmount, discount_code, created_at: createdAt });
            io.emit('order:created', { id: orderId, total });

            // Fire-and-forget print
            (async () => {
                try {
                    if (!getPrinter || !printReceipt) return;
                    const settings = await new Promise(resolve =>
                        db.all('SELECT key, value FROM business_settings', [], (e, rows) => {
                            const s = {};
                            (rows || []).forEach(r => { s[r.key] = r.value; });
                            resolve(s);
                        })
                    );
                    const printer = getPrinter(settings);
                    await printReceipt(printer, { id: orderId, created_at: createdAt, payment_mode: payment_mode || 'cash', total, items }, settings);
                } catch (err) {
                    logger.error('Printing failed (best-effort):', err && err.message);
                }
            })();

        } catch (err) {
            try { await dbRun('ROLLBACK', []); } catch { /* ignore */ }
            logger.error('Failed to place order:', err);
            res.status(500).json({ error: err.message });
        }
    });

    /* GET /api/orders/:id/print */
    router.get('/:id/print', requireAuth, (req, res) => {
        const orderId = req.params.id;
        db.get('SELECT id, total, payment_mode, created_at FROM orders WHERE id=?', [orderId], (err, order) => {
            if (err || !order) return res.status(404).json({ error: 'Order not found' });
            db.all(
                'SELECT product_id, name, quantity, price, line_total FROM order_items WHERE order_id=? ORDER BY id ASC',
                [orderId],
                (err2, items) => {
                    if (err2) return res.status(500).json({ error: 'Items error' });
                    if (!getPrinter || !printReceipt)
                        return res.json({ success: false, message: 'Printer unavailable on server' });

                    db.all('SELECT key, value FROM business_settings', [], async (settErr, settRows) => {
                        const settings = {};
                        (settRows || []).forEach(r => { settings[r.key] = r.value; });
                        try {
                            const printer = getPrinter(settings);
                            const orderData = {
                                id: order.id,
                                created_at: order.created_at,
                                payment_mode: order.payment_mode,
                                total: order.total,
                                items: items.map(i => ({ name: i.name, quantity: i.quantity, price: i.price, line_total: i.line_total })),
                            };
                            await printReceipt(printer, orderData, settings);
                            res.json({ success: true });
                        } catch (err3) {
                            res.status(500).json({ success: false, error: err3 && err3.message });
                        }
                    });
                }
            );
        });
    });

    /* GET /api/orders/:id/bill */
    router.get('/:id/bill', requireAuth, (req, res) => {
        const orderId = req.params.id;
        db.get('SELECT id, total, payment_mode, created_at FROM orders WHERE id=?', [orderId], (err, order) => {
            if (err || !order) return res.status(404).json({ error: 'Order not found' });
            db.all(
                'SELECT product_id, name, quantity, price, line_total FROM order_items WHERE order_id=? ORDER BY id ASC',
                [orderId],
                (err2, items) => {
                    if (err2) return res.status(500).json({ error: 'Items error' });
                    db.all('SELECT key, value FROM business_settings', [], (settErr, settingRows) => {
                        const settings = {};
                        (settingRows || []).forEach(r => { settings[r.key] = r.value; });
                        const cleanItems = items.map(i => ({
                            name: i.name || 'Unknown',
                            quantity: typeof i.quantity === 'number' ? i.quantity : 0,
                            price: typeof i.price === 'number' ? i.price : 0,
                            line_total: typeof i.line_total === 'number' ? i.line_total : (i.quantity || 0) * (i.price || 0),
                        }));
                        res.json({
                            business: {
                                name: settings.business_name || 'BIZNEX BOS',
                                address: settings.business_address || '',
                            },
                            bill_no: order.id,
                            date: new Date(order.created_at || Date.now()).toISOString(),
                            payment_mode: order.payment_mode || 'cash',
                            items: cleanItems,
                            total: order.total,
                            currency_symbol: settings.currency_symbol || '$',
                        });
                    });
                }
            );
        });
    });

    return router;
};
