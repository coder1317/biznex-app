#!/usr/bin/env node

/**
 * BIZNEX Order & Bill Validation Script
 * Usage: node backend/test-orders.js (run from app folder)
 */

const http = require('http');

const API_BASE = process.env.API_BASE || 'http://localhost:3002';

function request(method, path, body = null, headers = {}) {
    return new Promise((resolve, reject) => {
        const url = new URL(API_BASE + path);
        const options = {
            hostname: url.hostname,
            port: url.port,
            path: url.pathname + url.search,
            method: method,
            headers: Object.assign({ 'Content-Type': 'application/json' }, headers)
        };

        const req = http.request(options, (res) => {
            let data = '';
            res.on('data', (chunk) => { data += chunk; });
            res.on('end', () => {
                try {
                    resolve({ status: res.statusCode, data: JSON.parse(data) });
                } catch (e) {
                    resolve({ status: res.statusCode, data: data });
                }
            });
        });

        req.on('error', reject);
        if (body) req.write(JSON.stringify(body));
        req.end();
    });
}

async function runTests() {
    console.log('🧪 BIZNEX Order & Bill Validation\n');

    try {
        // Login first to get JWT token
        console.log('0) Logging in as admin...');
        const loginRes = await request('POST', '/api/auth/login', { username: 'admin', password: 'admin123' }).catch(err => { throw err; });
        if (loginRes.status !== 200) {
            console.error('Login failed:', loginRes);
            process.exit(1);
        }
        const token = loginRes.data.token;
        console.log('   ✅ Logged in, token length:', token.length);

        console.log('1) Adding test products...');
        const p1 = await request('POST', '/api/products', { name: 'Test Coffee', price: 50, stock: 100, category: 'Beverages', threshold: 5 }, { Authorization: `Bearer ${token}` });
        const p2 = await request('POST', '/api/products', { name: 'Test Tea', price: 30, stock: 100, category: 'Beverages', threshold: 5 }, { Authorization: `Bearer ${token}` });

        if (p1.status !== 200 || p2.status !== 200) {
            console.error('Failed to create test products', p1, p2);
            process.exit(1);
        }

        const productId1 = p1.data.id;
        const productId2 = p2.data.id;
        console.log('   ✅ Product IDs:', productId1, productId2);

        console.log('2) Creating order...');
        const orderRes = await request('POST', '/api/orders', {
            items: [
                { product_id: productId1, name: 'Test Coffee', price: 50, quantity: 1, line_total: 50 },
                { product_id: productId2, name: 'Test Tea', price: 30, quantity: 2, line_total: 60 }
            ],
            payment_mode: 'cash'
        }, { Authorization: `Bearer ${token}` });

        if (orderRes.status !== 200) {
            console.error('Order creation failed:', orderRes.data);
            process.exit(1);
        }

        const orderId = orderRes.data.order_id;
        console.log('   ✅ Order created ID:', orderId);

        console.log('3) Fetching order details...');
        const detailRes = await request('GET', `/api/orders/${orderId}`);
        if (detailRes.status !== 200) {
            console.error('Failed to fetch order:', detailRes.data);
            process.exit(1);
        }

        const items = detailRes.data.items;
        for (const it of items) {
            if (!it.name || typeof it.quantity !== 'number' || typeof it.price !== 'number' || typeof it.line_total !== 'number') {
                console.error('Invalid item in order details:', it);
                process.exit(1);
            }
        }
        console.log('   ✅ Order details items valid');

        console.log('4) Fetching bill...');
        const billRes = await request('GET', `/api/orders/${orderId}/bill`);
        if (billRes.status !== 200) {
            console.error('Bill fetch failed:', billRes.data);
            process.exit(1);
        }

        const bill = billRes.data;
        if (!bill || !bill.items || !Array.isArray(bill.items) || typeof bill.total === 'undefined') {
            console.error('Invalid bill payload', bill);
            process.exit(1);
        }
        console.log('   ✅ Bill payload valid');

        // totals check
        const sumItems = bill.items.reduce((s,i) => s + Number(i.line_total || (i.price * i.quantity || 0)), 0);
        if (Math.abs(sumItems - bill.total) > 0.01) {
            console.error('Totals mismatch: items sum', sumItems, 'bill.total', bill.total);
            process.exit(1);
        }

        console.log('\n✨ ALL TESTS PASSED ✨');
    } catch (err) {
        console.error('Test error:', err);
        process.exit(1);
    }
}

runTests();
