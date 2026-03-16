/**
 * server/db-pg.js — PostgreSQL adapter (Phase 3)
 *
 * Provides the same callback-based API as sqlite3 so server.js doesn't
 * need to change at all when switching databases.
 *
 * Usage: set DB_TYPE=postgres and DATABASE_URL=postgresql://user:pass@host:5432/biznex in .env
 *
 * To set up on Raspberry Pi:
 *   sudo apt install postgresql
 *   sudo -u postgres createuser biznex --pwprompt
 *   sudo -u postgres createdb biznex -O biznex
 *   node server/migrate-pg.js    # run once
 */
require('dotenv').config();
const { Pool } = require('pg');

const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: process.env.PG_SSL === 'true' ? { rejectUnauthorized: false } : false,
    max: 10,
    idleTimeoutMillis: 30000,
    connectionTimeoutMillis: 5000,
});

pool.on('connect', () => console.log('✅ PostgreSQL connected'));
pool.on('error', (err) => console.error('❌ PostgreSQL pool error:', err.message));

// --- Compatibility helpers -------------------------------------------------

/**
 * Convert SQLite ? placeholders to PostgreSQL $1, $2, ...
 */
function toPostgresParams(sql) {
    let i = 0;
    return sql.replace(/\?/g, () => `$${++i}`);
}

/**
 * Normalise params: sqlite3 callbacks accept the params array or nothing.
 * pg needs an array; coerce undefined/null → [].
 */
function normalise(params) {
    if (!params) return [];
    if (!Array.isArray(params)) return [params];
    return params;
}

// --- SQLite3-compatible API ------------------------------------------------

/**
 * db.get(sql, params, callback) → callback(err, row | undefined)
 */
function get(sql, params, callback) {
    if (typeof params === 'function') { callback = params; params = []; }
    const pgSql = toPostgresParams(sql);
    pool.query(pgSql, normalise(params))
        .then(r => callback(null, r.rows[0] || undefined))
        .catch(e => callback(e));
}

/**
 * db.all(sql, params, callback) → callback(err, rows[])
 */
function all(sql, params, callback) {
    if (typeof params === 'function') { callback = params; params = []; }
    const pgSql = toPostgresParams(sql);
    pool.query(pgSql, normalise(params))
        .then(r => callback(null, r.rows))
        .catch(e => callback(e));
}

/**
 * db.run(sql, params, callback) → callback.call({ lastID, changes }, err)
 *
 * For INSERT statements, auto-appends RETURNING id so lastID works.
 */
function run(sql, params, callback) {
    if (typeof params === 'function') { callback = params; params = []; }
    let pgSql = toPostgresParams(sql);

    const isInsert = /^\s*INSERT\s+INTO/i.test(pgSql);
    if (isInsert && !/RETURNING\s+id/i.test(pgSql)) {
        pgSql += ' RETURNING id';
    }

    pool.query(pgSql, normalise(params))
        .then(r => {
            const lastID = isInsert && r.rows[0] ? r.rows[0].id : null;
            const changes = r.rowCount || 0;
            if (callback) callback.call({ lastID, changes }, null);
        })
        .catch(e => {
            if (callback) callback.call({ lastID: null, changes: 0 }, e);
        });
}

/**
 * db.serialize(fn) — SQLite queues all calls inside fn serially.
 * PostgreSQL connections are per-query so this is a no-op; just call fn().
 */
function serialize(fn) { fn(); }

// --- Schema initialisation -------------------------------------------------
// PostgreSQL-compatible CREATE TABLE statements (run once on first connect).

const INIT_SQL = `
BEGIN;

CREATE TABLE IF NOT EXISTS products (
    id          SERIAL PRIMARY KEY,
    name        TEXT NOT NULL UNIQUE,
    price       DOUBLE PRECISION NOT NULL,
    stock       INTEGER NOT NULL DEFAULT 0,
    threshold   INTEGER DEFAULT 5,
    category    TEXT NOT NULL DEFAULT 'Uncategorized',
    image       TEXT,
    available   INTEGER DEFAULT 1,
    supplier_id INTEGER,
    last_restock_date TEXT
);

CREATE TABLE IF NOT EXISTS suppliers (
    id              SERIAL PRIMARY KEY,
    name            TEXT NOT NULL,
    contact_person  TEXT,
    email           TEXT,
    phone           TEXT,
    address         TEXT,
    created_at      TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS orders (
    id              SERIAL PRIMARY KEY,
    total           DOUBLE PRECISION NOT NULL,
    payment_mode    TEXT NOT NULL DEFAULT 'cash',
    created_at      TIMESTAMPTZ DEFAULT NOW(),
    discount_code   TEXT,
    discount_amount DOUBLE PRECISION DEFAULT 0
);

CREATE TABLE IF NOT EXISTS order_items (
    id          SERIAL PRIMARY KEY,
    order_id    INTEGER NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
    product_id  INTEGER,
    name        TEXT NOT NULL,
    price       DOUBLE PRECISION NOT NULL DEFAULT 0,
    quantity    INTEGER NOT NULL,
    line_total  DOUBLE PRECISION NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS users (
    id              SERIAL PRIMARY KEY,
    username        TEXT UNIQUE NOT NULL,
    password_hash   TEXT NOT NULL,
    role            TEXT NOT NULL DEFAULT 'cashier',
    permissions     TEXT DEFAULT '[]'
);

CREATE TABLE IF NOT EXISTS discounts (
    id      SERIAL PRIMARY KEY,
    code    TEXT UNIQUE NOT NULL,
    type    TEXT NOT NULL,
    value   DOUBLE PRECISION NOT NULL,
    active  INTEGER DEFAULT 1
);

CREATE TABLE IF NOT EXISTS tokens (
    id          SERIAL PRIMARY KEY,
    user_id     INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    token       TEXT UNIQUE NOT NULL,
    created_at  TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS refresh_tokens (
    id          SERIAL PRIMARY KEY,
    user_id     INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    token       TEXT UNIQUE NOT NULL,
    expires_at  TIMESTAMPTZ NOT NULL,
    created_at  TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_products_name       ON products(name);
CREATE INDEX IF NOT EXISTS idx_products_category   ON products(category);
CREATE INDEX IF NOT EXISTS idx_orders_created_at   ON orders(created_at);
CREATE INDEX IF NOT EXISTS idx_order_items_order   ON order_items(order_id);

COMMIT;
`;

// Run migrations immediately on module load
pool.query(INIT_SQL)
    .then(() => console.log('✅ PostgreSQL schema initialised'))
    .catch(err => console.error('❌ PostgreSQL schema init failed:', err.message));

module.exports = { get, all, run, serialize };
