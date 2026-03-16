// Phase 3: PostgreSQL support — set DB_TYPE=postgres in .env to use PostgreSQL instead of SQLite.
if (process.env.DB_TYPE === 'postgres') {
    console.log('🐘 Using PostgreSQL (db-pg.js)');
    module.exports = require('./db-pg');
} else {

const path = require("path");
const sqlite3 = require("sqlite3").verbose();

const dbPath = process.env.DB_PATH || path.join(__dirname, "biznex.db");
console.log("DB PATH:", dbPath);

const db = new sqlite3.Database(dbPath, (err) => {
    if (err) {
        console.error("❌ DB OPEN ERROR:", err.message);        // Even on open failure, signal ready so requests get an error rather than hanging forever
        db._isReady = true;
        (db._readyCallbacks || []).forEach(fn => fn());
        db._readyCallbacks = [];    } else {
        console.log("✅ DB connected");
    }
});

db.serialize(() => {
    db.run(`
        CREATE TABLE IF NOT EXISTS products (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            name TEXT NOT NULL,
            price REAL NOT NULL,
            stock INTEGER NOT NULL,
            threshold INTEGER DEFAULT 5,
            category TEXT NOT NULL DEFAULT 'Uncategorized',
            image TEXT,
            available INTEGER DEFAULT 1
        )
    `, (err) => {
        if (err) console.error("❌ products table error:", err.message);
        else console.log("✅ products table ready");
    });

    // Ensure legacy databases get the new column
    db.all("PRAGMA table_info(products)", [], (err, cols) => {
        if (err) return;
        const hasThreshold = cols.some(c => c.name === 'threshold');
        const hasAvailable = cols.some(c => c.name === 'available');
        const hasCategory = cols.some(c => c.name === 'category');

        if (!hasThreshold) {
            console.log('ALTERING products table to add threshold column');
            db.run("ALTER TABLE products ADD COLUMN threshold INTEGER DEFAULT 5", [], (e) => {
                if (e) console.error('Failed to add threshold column:', e.message);
                else console.log('threshold column added');
            });
        }

        if (!hasAvailable) {
            console.log('ALTERING products table to add available column');
            db.run("ALTER TABLE products ADD COLUMN available INTEGER DEFAULT 1", [], (e) => {
                if (e) console.error('Failed to add available column:', e.message);
                else console.log('available column added');
            });
        }

        if (!hasCategory) {
            console.log('ALTERING products table to add category column');
            db.run("ALTER TABLE products ADD COLUMN category TEXT DEFAULT 'Uncategorized'", [], (e) => {
                if (e) console.error('Failed to add category column:', e.message);
                else console.log('category column added');
            });
        }

        const hasImage = cols.some(c => c.name === 'image');
        if (!hasImage) {
            console.log('ALTERING products table to add image column');
            db.run("ALTER TABLE products ADD COLUMN image TEXT", [], (e) => {
                if (e) console.error('Failed to add image column:', e.message);
                else console.log('image column added');
            });
        }
    });

    // Suppliers table for inventory tracking
    db.run(`
        CREATE TABLE IF NOT EXISTS suppliers (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            name TEXT NOT NULL,
            contact_person TEXT,
            email TEXT,
            phone TEXT,
            address TEXT,
            created_at TEXT DEFAULT (datetime('now','localtime'))
        )
    `, (err) => {
        if (err) console.error("❌ suppliers table error:", err.message);
        else console.log("✅ suppliers table ready");
    });

    // Ensure products table has supplier_id
    db.all("PRAGMA table_info(products)", [], (err, cols) => {
        if (err) return;
        const hasSupplierId = cols.some(c => c.name === 'supplier_id');
        const hasLastRestock = cols.some(c => c.name === 'last_restock_date');

        if (!hasSupplierId) {
            console.log('ALTERING products table to add supplier_id column');
            db.run("ALTER TABLE products ADD COLUMN supplier_id INTEGER REFERENCES suppliers(id)", [], (e) => {
                if (e) console.error('Failed to add supplier_id column:', e.message);
                else console.log('supplier_id column added');
            });
        }

        if (!hasLastRestock) {
            console.log('ALTERING products table to add last_restock_date column');
            db.run("ALTER TABLE products ADD COLUMN last_restock_date TEXT", [], (e) => {
                if (e) console.error('Failed to add last_restock_date column:', e.message);
                else console.log('last_restock_date column added');
            });
        }
    });

    // Orders table: keep totals non-null, track payment_mode and created_at
    db.run(`
        CREATE TABLE IF NOT EXISTS orders (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            total REAL NOT NULL,
            payment_mode TEXT NOT NULL DEFAULT 'cash',
            created_at TEXT DEFAULT (datetime('now','localtime'))
        )
    `, (err) => {
        if (err) console.error("❌ orders table error:", err.message);
        else console.log("✅ orders table ready");
    });

    // Order items: snapshot fields at sale time (name, price, quantity, line_total)
    db.run(`
        CREATE TABLE IF NOT EXISTS order_items (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            order_id INTEGER NOT NULL,
            product_id INTEGER,
            name TEXT NOT NULL,
            price REAL NOT NULL,
            quantity INTEGER NOT NULL,
            line_total REAL NOT NULL
        )
    `, (err) => {
        if (err) console.error("❌ order_items table error:", err.message);
        else console.log("✅ order_items table ready");
    });

    // Users table for authentication
    db.run(`
        CREATE TABLE IF NOT EXISTS users (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            username TEXT UNIQUE NOT NULL,
            password_hash TEXT NOT NULL,
            role TEXT NOT NULL DEFAULT 'cashier',
            permissions TEXT DEFAULT '[]'
        )
    `, (err) => {
        if (err) console.error("❌ users table error:", err.message);
        else console.log("✅ users table ready");
    });

    // Ensure users table has permissions column (JSON string of allowed modules)
    db.all("PRAGMA table_info(users)", [], (err, cols) => {
        if (err || !cols) return;
        const names = cols.map(c => c.name);
        if (!names.includes('permissions')) {
            console.log('ALTERING users table to add permissions column');
            db.run("ALTER TABLE users ADD COLUMN permissions TEXT DEFAULT '[]'", [], (e) => {
                if (e) console.error('Failed to add permissions column:', e.message);
                else console.log('permissions column added to users');
            });
        }
    });

    // Discounts table for promotions
    db.run(`
        CREATE TABLE IF NOT EXISTS discounts (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            code TEXT UNIQUE NOT NULL,
            type TEXT NOT NULL, -- 'percentage' or 'fixed'
            value REAL NOT NULL,
            active INTEGER DEFAULT 1
        )
    `, (err) => {
        if (err) console.error("❌ discounts table error:", err.message);
        else console.log("✅ discounts table ready");
    });

    // Phase 2: Refresh tokens table for secure token rotation
    db.run(`
        CREATE TABLE IF NOT EXISTS refresh_tokens (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            user_id INTEGER NOT NULL,
            token TEXT UNIQUE NOT NULL,
            expires_at TEXT NOT NULL,
            created_at TEXT DEFAULT (datetime('now','localtime')),
            FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
        )
    `, (err) => {
        if (err) console.error("❌ refresh_tokens table error:", err.message);
        else console.log("✅ refresh_tokens table ready");
    });

    // Seed sample discounts
    db.get("SELECT COUNT(*) as count FROM discounts", [], (err, row) => {
        if (err) return console.error("Error checking discounts:", err.message);
        if (row.count === 0) {
            const sampleDiscounts = [
                { code: 'SAVE10', type: 'percentage', value: 10 },
                { code: 'FLAT50', type: 'fixed', value: 50 }
            ];
            sampleDiscounts.forEach(d => {
                db.run("INSERT INTO discounts (code, type, value) VALUES (?, ?, ?)", [d.code, d.type, d.value], (err) => {
                    if (err) console.error("Error seeding discount:", err.message);
                });
            });
            console.log("✅ Sample discounts seeded");
        }
    });

    // Seed sample suppliers
    db.get("SELECT COUNT(*) as count FROM suppliers", [], (err, row) => {
        if (err) return console.error("Error checking suppliers:", err.message);
        if (row.count === 0) {
            const sampleSuppliers = [
                { name: 'Fresh Foods Inc.', contact_person: 'John Smith', email: 'john@freshfoods.com', phone: '+91-9876543210', address: '123 Market Street, Mumbai' },
                { name: 'Beverage Distributors Ltd.', contact_person: 'Sarah Johnson', email: 'sarah@beverages.com', phone: '+91-9876543211', address: '456 Supply Lane, Delhi' },
                { name: 'Snack Masters', contact_person: 'Mike Davis', email: 'mike@snackmasters.com', phone: '+91-9876543212', address: '789 Warehouse Road, Bangalore' }
            ];
            sampleSuppliers.forEach(s => {
                db.run("INSERT INTO suppliers (name, contact_person, email, phone, address) VALUES (?, ?, ?, ?, ?)", 
                    [s.name, s.contact_person, s.email, s.phone, s.address], (err) => {
                    if (err) console.error("Error seeding supplier:", err.message);
                });
            });
            console.log("✅ Sample suppliers seeded");
        }
    });

    // Ensure orders has discount_code and discount_amount
    db.all("PRAGMA table_info(orders)", [], (err2, cols2) => {
        if (err2 || !cols2) return;
        const names2 = cols2.map(c => c.name);
        if (!names2.includes('discount_code')) {
            console.log('Adding orders.discount_code column');
            db.run("ALTER TABLE orders ADD COLUMN discount_code TEXT", [], (e) => {
                if (e) console.error('Add discount_code failed:', e.message);
                else console.log('orders.discount_code added');
            });
        }
        if (!names2.includes('discount_amount')) {
            console.log('Adding orders.discount_amount column');
            db.run("ALTER TABLE orders ADD COLUMN discount_amount REAL DEFAULT 0", [], (e) => {
                if (e) console.error('Add discount_amount failed:', e.message);
                else console.log('orders.discount_amount added');
            });
        }
    });

    // Seed default admin user if no users exist
    db.get("SELECT COUNT(*) as count FROM users", [], (err, row) => {
        if (err) return console.error("Error checking users:", err.message);
        if (row.count === 0) {
            const bcrypt = require('bcryptjs');
            const saltRounds = 10;
            const defaultPassword = 'admin123'; // Change this in production
            bcrypt.hash(defaultPassword, saltRounds, (err, hash) => {
                if (err) return console.error("Error hashing password:", err.message);
                // default admin gets full permissions (allow all core modules)
                const defaultPerms = JSON.stringify(['dashboard','pos','products','suppliers','orders','reports','discounts','users']);
                db.run("INSERT INTO users (username, password_hash, role, permissions) VALUES (?, ?, ?, ?)", ['admin', hash, 'admin', defaultPerms], (err) => {
                    if (err) console.error("Error seeding admin user:", err.message);
                    else console.log("✅ Default admin user created: username=admin, password=admin123");
                });
            });
        }
    });

    // Backfill / Migrate legacy columns if present
    db.all("PRAGMA table_info(order_items)", [], (err, cols) => {
        if (err || !cols) return;
        const names = cols.map(c => c.name);
        // If legacy product_name exists and new `name` missing, add it and copy
        if (names.includes('product_name') && !names.includes('name')) {
            console.log('Migrating order_items.product_name -> name');
            db.run("ALTER TABLE order_items ADD COLUMN name TEXT", [], (e) => {
                if (e) return console.error('Add column name failed:', e.message);
                db.run("UPDATE order_items SET name = product_name", [], (ee) => {
                    if (ee) console.error('Populate name failed:', ee.message);
                    else console.log('order_items.name populated from product_name');
                });
            });
        }
        if (names.includes('price_at_sale') && !names.includes('price')) {
            console.log('Migrating order_items.price_at_sale -> price');
            db.run("ALTER TABLE order_items ADD COLUMN price REAL", [], (e) => {
                if (e) return console.error('Add column price failed:', e.message);
                db.run("UPDATE order_items SET price = price_at_sale", [], (ee) => {
                    if (ee) console.error('Populate price failed:', ee.message);
                    else console.log('order_items.price populated from price_at_sale');
                });
            });
        }
        if (!names.includes('line_total')) {
            console.log('Adding order_items.line_total column');
            db.run("ALTER TABLE order_items ADD COLUMN line_total REAL DEFAULT 0", [], (e) => {
                if (e) return console.error('Add column line_total failed:', e.message);
                db.run("UPDATE order_items SET line_total = COALESCE(quantity,0) * COALESCE(price,0)", [], (ee) => {
                    if (ee) console.error('Populate line_total failed:', ee.message);
                    else console.log('order_items.line_total populated');
                });
            });
        }
    });

    // Ensure orders has payment_mode and created_at (migrate time -> created_at)
    db.all("PRAGMA table_info(orders)", [], (err2, cols2) => {
        if (err2 || !cols2) return;
        const names2 = cols2.map(c => c.name);
        if (!names2.includes('payment_mode')) {
            console.log('Adding orders.payment_mode column');
            db.run("ALTER TABLE orders ADD COLUMN payment_mode TEXT DEFAULT 'cash'", [], (e) => {
                if (e) console.error('Add payment_mode failed:', e.message);
                else console.log('orders.payment_mode added');
            });
        }
        if (!names2.includes('created_at')) {
            console.log('Adding orders.created_at column and migrating time -> created_at');
            // Add column with localtime default
            db.run("ALTER TABLE orders ADD COLUMN created_at TEXT DEFAULT (datetime('now','localtime'))", [], (e) => {
                if (e) return console.error('Add created_at failed:', e.message);
                db.run("UPDATE orders SET created_at = time WHERE time IS NOT NULL", [], (ee) => {
                    if (ee) console.error('Populate created_at failed:', ee.message);
                    else console.log('orders.created_at populated from time');
                });
            });
        }
    });

    // One-time cleanup: fix bad/null epoch timestamps in orders
    db.run(`
        UPDATE orders
        SET created_at = datetime('now','localtime')
        WHERE created_at IS NULL
           OR created_at = '1970-01-01 00:00:00'
           OR created_at LIKE '1970%'
    `, [], (err) => {
        if (err) console.error('Failed to clean orders.created_at:', err.message);
        else console.log('orders.created_at cleanup executed');
    });

    // Add indexes for performance
    db.run("CREATE INDEX IF NOT EXISTS idx_products_name ON products(name)", [], (err) => {
        if (err) console.error('Failed to create products name index:', err.message);
        else console.log('✅ Index on products.name created');
    });
    db.run("CREATE INDEX IF NOT EXISTS idx_products_category ON products(category)", [], (err) => {
        if (err) console.error('Failed to create products category index:', err.message);
        else console.log('✅ Index on products.category created');
    });
    db.run("CREATE INDEX IF NOT EXISTS idx_products_available ON products(available)", [], (err) => {
        if (err) console.error('Failed to create products available index:', err.message);
        else console.log('✅ Index on products.available created');
    });
    db.run("CREATE INDEX IF NOT EXISTS idx_orders_created_at ON orders(created_at)", [], (err) => {
        if (err) console.error('Failed to create orders created_at index:', err.message);
        else console.log('✅ Index on orders.created_at created');
    });
    db.run("CREATE INDEX IF NOT EXISTS idx_order_items_order_id ON order_items(order_id)", [], (err) => {
        if (err) console.error('Failed to create order_items order_id index:', err.message);
        else console.log('✅ Index on order_items.order_id created');
    });

    // Run versioned migrations (new schema changes go in server/migrations/)
    const runMigrations = require('./migrator');
    runMigrations(db, (err) => {
        if (err) console.error('❌ Migration error:', err.message);
        // Signal that the DB is fully ready — server.js uses this before it
        // calls httpServer.listen() so requests never arrive before the schema
        // is complete.
        db._isReady = true;
        (db._readyCallbacks || []).forEach(fn => fn());
        db._readyCallbacks = [];
    });
});

/**
 * Call `fn` immediately if the DB is already fully initialised,
 * otherwise queue it to run once migrations are done.
 * A 30-second safety timeout fires the callback anyway so requests
 * never hang forever if something goes wrong during DB init.
 */
db.onReady = function(fn) {
    if (db._isReady) { fn(); }
    else {
        db._readyCallbacks = db._readyCallbacks || [];
        db._readyCallbacks.push(fn);
        // Safety timeout: fire after 30s regardless
        setTimeout(() => {
            if (!db._isReady) {
                console.warn('[db] onReady safety timeout fired after 30s');
                db._isReady = true;
                (db._readyCallbacks || []).forEach(f => f());
                db._readyCallbacks = [];
            }
        }, 30000);
    }
};

module.exports = db;

} // end SQLite branch (DB_TYPE !== 'postgres')
