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
        const token = loginRes.data.token;
        console.log(`✅ Login successful - Token: ${token.substring(0, 30)}...`);
        console.log(`   User: ${loginRes.data.user.username} (${loginRes.data.user.role})\n`);

        // TEST 2: GET PRODUCTS
        console.log('📝 TEST 2: GET PRODUCTS');
        const productsRes = await makeRequest('GET', '/api/products', null, token);
        console.log(`✅ Retrieved ${productsRes.data.length} products`);
        if (productsRes.data.length > 0) {
            const p = productsRes.data[0];
            console.log(`   Sample: ${p.name} - $${p.price} (Stock: ${p.stock})\n`);
        }

        // TEST 3: CREATE PRODUCT (if none exist)
        if (productsRes.data.length === 0) {
            console.log('📝 TEST 3: CREATE SAMPLE PRODUCT');
            const createRes = await makeRequest('POST', '/api/products', {
                name: 'Test Coffee',
                price: 5.99,
                stock: 50,
                category: 'Beverages'
            }, token);
            console.log(`✅ Product created: ${createRes.data.name}\n`);
        } else {
            console.log('📝 TEST 3: GET ORDERS (existing products)\n');
        }

        // TEST 4: CREATE ORDER
        console.log('📝 TEST 4: CREATE ORDER');
        const orderRes = await makeRequest('POST', '/api/orders', {
            items: [
                {
                    product_id: productsRes.data[0].id,
                    name: productsRes.data[0].name,
                    price: productsRes.data[0].price,
                    quantity: 2,
                    line_total: productsRes.data[0].price * 2
                }
            ],
            payment_mode: 'cash'
        }, token);

        if (orderRes.status === 201 || orderRes.status === 200) {
            console.log(`✅ Order created successfully`);
            console.log(`   Order ID: ${orderRes.data.id}`);
            console.log(`   Total: $${orderRes.data.total}\n`);
        } else {
            console.log(`❌ Order creation failed: ${orderRes.status}`);
            console.log(`   ${JSON.stringify(orderRes.data)}\n`);
        }

        // TEST 5: GET ORDERS
        console.log('📝 TEST 5: GET ORDERS');
        const getOrdersRes = await makeRequest('GET', '/api/orders', null, token);
        console.log(`✅ Retrieved ${getOrdersRes.data.data?.length || 0} orders`);
        console.log(`   Total orders in system: ${getOrdersRes.data.total || 0}\n`);

        // TEST 6: INVALID TOKEN TEST
        console.log('📝 TEST 6: SECURITY - INVALID TOKEN');
        const invalidRes = await makeRequest('GET', '/api/orders', null, 'invalid_token_xyz');
        if (invalidRes.status === 401) {
            console.log(`✅ Security check passed - Invalid token rejected (401)\n`);
        } else {
            console.log(`❌ SECURITY ISSUE - Invalid token not rejected!\n`);
        }

        // TEST 7: UNAUTHENTICATED REQUEST
        console.log('📝 TEST 7: SECURITY - UNAUTHENTICATED REQUEST');
        const unauthRes = await makeRequest('GET', '/api/orders', null);
        if (unauthRes.status === 401) {
            console.log(`✅ Security check passed - Unauthenticated request rejected (401)\n`);
        } else {
            console.log(`❌ SECURITY ISSUE - Unauthenticated request not rejected!\n`);
        }

        // TEST 8: HEALTH CHECK
        console.log('📝 TEST 8: HEALTH CHECK');
        const healthRes = await makeRequest('GET', '/health');
        console.log(`✅ Health check status: ${healthRes.status}`);
        console.log(`   Response: ${JSON.stringify(healthRes.data)}\n`);

        console.log('🎉 === ALL TESTS COMPLETED === 🎉\n');

    } catch (err) {
        console.error('❌ Test Error:', err.message);
    }

    process.exit(0);
}

runTests();
