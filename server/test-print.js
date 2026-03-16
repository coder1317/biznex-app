const { getPrinter } = require('./printer');
const { printReceipt } = require('./receipt');

(async function(){
    try {
        const printer = getPrinter();
        await printReceipt(printer, {
            id: 1,
            created_at: new Date().toISOString(),
            payment_mode: 'cash',
            total: 120,
            items: [
                { name: 'Tea', quantity: 2, line_total: 24 },
                { name: 'Coffee', quantity: 1, line_total: 15 }
            ]
        });
        console.log('Print job sent');
    } catch (err) {
        console.error('Print test failed:', err && err.message);
    }
})();
