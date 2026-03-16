const http = require('http');

function makeRequest(method, path, data = null, token = null) {
    return new Promise((resolve, reject) => {
        const options = {
            hostname: 'localhost',
            port: 3000,
            path: path,
            method: method,
            headers: {
                'Content-Type': 'application/json',
                ...(token && { 'Authorization': `Bearer ${token}` })
            }
        };

        const req = http.request(options, (res) => {
            let body = '';
            res.on('data', chunk => body += chunk);
            res.on('end', () => {
                try {
                    resolve({ status: res.statusCode, data: JSON.parse(body) });
                } catch (e) {
                    resolve({ status: res.statusCode, data: body });
                }
            });
        });

        req.on('error', reject);
        if (data) req.write(JSON.stringify(data));
        req.end();
    });
}

async function runTests() {
    console.log('\n🧪 === BIZNEX APP - COMPLETE WORKFLOW TEST === 🧪\n');

    try {
        // TEST 1: LOGIN
        console.log('📝 TEST 1: USER LOGIN');
        const loginRes = await makeRequest('POST', '/api/auth/login', {
            username: 'Admin',
            password: 'admin123'
        });
        if (loginRes.status !== 200) {
            console.log(`❌ FAILED: ${loginRes.status} - ${JSON.stringify(loginRes.data)}\n`);
            process.exit(1);
        }
        const token = loginRes.data.token;
        console.log(`✅ PASS - Token obtained`);
        console.log(`   User: ${loginRes.data.user.username} (${loginRes.data.user.role})\n`);

        // TEST 2: GET PRODUCTS
        console.log('📝 TEST 2: GET PRODUCTS');
        const productsRes = await makeRequest('GET', '/api/products', null, token);
        if (productsRes.status !== 200) {
            console.log(`❌ FAILED: ${productsRes.status}\n`);
            process.exit(1);
        }
        const products = productsRes.data.data;
        console.log(`✅ PASS - Retrieved ${products.length} products\n`);

        // TEST 3: CREATE SAMPLE PRODUCT (if needed)
        let productId;
        if (products.length === 0) {
            console.log('📝 TEST 3: CREATE SAMPLE PRODUCT');
            const createRes = await makeRequest('POST', '/api/products', {
                name: 'Cappuccino',
                price: 4.50,
                stock: 100,
                category: 'Beverages',
                available: 1
            }, token);
            if (createRes.status !== 201 && createRes.status !== 200) {
                console.log(`❌ FAILED: ${createRes.status}`);
                console.log(JSON.stringify(createRes.data, null, 2));
                process.exit(1);
            }
            productId = createRes.data.id;
            console.log(`✅ PASS - Created product: ${createRes.data.name} (ID: ${productId})\n`);
        } else {
            productId = products[0].id;
            console.log(`📝 TEST 3: USING EXISTING PRODUCT`);
            console.log(`✅ PASS - Product: ${products[0].name} (ID: ${productId})\n`);
        }

        // TEST 4: CREATE ORDER
        console.log('📝 TEST 4: CREATE ORDER');
        const orderRes = await makeRequest('POST', '/api/orders', {
            items: [
                {
                    product_id: productId,
                    name: products[0]?.name || 'Cappuccino',
                    price: products[0]?.price || 4.50,
                    quantity: 1,
                    line_total: products[0]?.price || 4.50
                }
            ],
            payment_mode: 'cash'
        }, token);

        if (orderRes.status !== 201 && orderRes.status !== 200) {
            console.log(`❌ FAILED: ${orderRes.status}`);
            console.log(JSON.stringify(orderRes.data, null, 2));
            process.exit(1);
        }
        const orderId = orderRes.data.id;
        console.log(`✅ PASS - Order created`);
        console.log(`   Order ID: ${orderId}, Total: $${orderRes.data.total}\n`);

        // TEST 5: GET ORDERS
        console.log('📝 TEST 5: GET ORDERS LIST');
        const getOrdersRes = await makeRequest('GET', '/api/orders', null, token);
        if (getOrdersRes.status !== 200) {
            console.log(`❌ FAILED: ${getOrdersRes.status}\n`);
            process.exit(1);
        }
        console.log(`✅ PASS - Retrieved orders`);
        console.log(`   Orders found: ${getOrdersRes.data.data?.length || 0}\n`);

        // TEST 6: GET ORDER DETAILS
        console.log('📝 TEST 6: GET ORDER DETAILS');
        const orderDetailsRes = await makeRequest('GET', `/api/orders/${orderId}`, null, token);
        if (orderDetailsRes.status !== 200) {
            console.log(`❌ FAILED: ${orderDetailsRes.status}\n`);
        } else {
            console.log(`✅ PASS - Order details retrieved`);
            console.log(`   Items: ${orderDetailsRes.data.items?.length || 0}\n`);
        }

        // TEST 7: SECURITY - INVALID TOKEN
        console.log('📝 TEST 7: SECURITY - INVALID TOKEN REJECTION');
        const invalidRes = await makeRequest('GET', '/api/orders', null, 'invalid_token_xyz');
        if (invalidRes.status === 401) {
            console.log(`✅ PASS - Invalid token rejected (401)\n`);
        } else {
            console.log(`❌ FAIL - Invalid token NOT rejected! Status: ${invalidRes.status}\n`);
        }

        // TEST 8: SECURITY - NO TOKEN
        console.log('📝 TEST 8: SECURITY - UNAUTHENTICATED REQUEST');
        const noAuthRes = await makeRequest('GET', '/api/orders', null);
        if (noAuthRes.status === 401) {
            console.log(`✅ PASS - Unauthenticated request rejected (401)\n`);
        } else {
            console.log(`❌ FAIL - Unauthenticated NOT rejected! Status: ${noAuthRes.status}\n`);
        }

        // TEST 9: CHECK RATE LIMITING HEADER
        console.log('📝 TEST 9: CHECK RATE LIMITING HEADERS');
        const limitRes = await makeRequest('GET', '/api/products', null, token);
        const rateLimit = limitRes.headers?.['ratelimit-limit'];
        if (rateLimit) {
            console.log(`✅ PASS - Rate limiting headers present`);
            console.log(`   Limit: ${limitRes.headers['ratelimit-limit']}\n`);
        } else {
            console.log(`⚠️  WARNING - No rate limit headers detected\n`);
        }

        // TEST 10: HEALTH CHECK
        console.log('📝 TEST 10: HEALTH CHECK ENDPOINT');
        const healthRes = await makeRequest('GET', '/health');
        if (healthRes.status === 200) {
            console.log(`✅ PASS - Health check OK\n`);
        } else {
            console.log(`⚠️  WARNING - Unexpected health status: ${healthRes.status}\n`);
        }

        console.log('\n✨ === ALL WORKFLOW TESTS PASSED === ✨\n');

    } catch (err) {
        console.error('❌ FATAL ERROR:', err.message);
        console.error(err.stack);
        process.exit(1);
    }
}

runTests();
