const sqlite3 = require('sqlite3').verbose();
const path = require('path');

const dbPath = path.join(__dirname, 'biznex.db');
console.log('🗑️ Clearing database at:', dbPath);

const db = new sqlite3.Database(dbPath, (err) => {
    if (err) {
        console.error('❌ DB connection error:', err.message);
        process.exit(1);
    }
    console.log('✅ Connected to database');
});

db.serialize(() => {
    // Clear all tables
    const tables = ['order_items', 'orders', 'products'];

    tables.forEach(table => {
        db.run(`DELETE FROM ${table}`, [], (err) => {
            if (err) {
                console.error(`❌ Error clearing ${table}:`, err.message);
            } else {
                console.log(`✅ Cleared ${table} table`);
            }
        });
    });

    // Reset auto-increment counters
    db.run(`DELETE FROM sqlite_sequence WHERE name IN ('products', 'orders', 'order_items')`, [], (err) => {
        if (err) {
            console.error('❌ Error resetting sequences:', err.message);
        } else {
            console.log('✅ Reset auto-increment counters');
        }
    });

    // Close database after operations complete
    setTimeout(() => {
        db.close((err) => {
            if (err) {
                console.error('❌ Error closing database:', err.message);
                process.exit(1);
            } else {
                console.log('🎉 Database cleared successfully! All data removed.');
                console.log('📝 You can now add fresh data to test the application.');
            }
        });
    }, 1000);
});