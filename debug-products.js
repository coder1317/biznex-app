const http = require('http');

const token = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpZCI6MSwidXNlcm5hbWUiOiJBZG1pbiIsInJvbGUiOiJhZG1pbiIsInBlcm1pc3Npb25zIjpbImRhc2hib2FyZCIsInBvcyIsInByb2R1Y3RzIiwic3VwcGxpZXJzIiwib3JkZXJzIiwicmVwb3J0cyIsImRpc2NvdW50cyIsInVzZXJzIl0sImlhdCI6MTc3MzY0ODI4MCwiZXhwIjoxNzczNjUxODgwfQ.QmmFA5AG2HeuDgC7h-6lkGR1jjymgvaphhh49uT7nv8";

const options = {
    hostname: 'localhost',
    port: 3000,
    path: '/api/products',
    method: 'GET',
    headers: {
        'Authorization': `Bearer ${token}`,
        'Content-Type': 'application/json'
    }
};

const req = http.request(options, (res) => {
    let body = '';
    res.on('data', chunk => body += chunk);
    res.on('end', () => {
        console.log('Status:', res.statusCode);
        console.log('Raw Response:', body);
        console.log('\nParsed:');
        try {
            const data = JSON.parse(body);
            console.log(JSON.stringify(data, null, 2));
        } catch (e) {
            console.log('Parse error:', e.message);
        }
    });
});

req.on('error', (e) => console.error('Error:', e));
req.end();
