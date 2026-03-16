/**
 * server/migrator.js
 *
 * Lightweight SQLite migration runner.
 * Reads sequentially-numbered .sql files from server/migrations/
 * and applies any that haven't been applied yet.
 *
 * Usage (called in db.js after initial setup):
 *   const runMigrations = require('./migrator');
 *   runMigrations(db, () => { /* ready *\/ });
 */

const fs   = require('fs');
const path = require('path');

const MIGRATIONS_DIR = path.join(__dirname, 'migrations');

/**
 * @param {object} db  - sqlite3 Database instance
 * @param {function} done - callback when all migrations complete
 */
function runMigrations(db, done) {
    // 1. Ensure the tracking table exists
    db.run(`
        CREATE TABLE IF NOT EXISTS schema_migrations (
            id         INTEGER PRIMARY KEY AUTOINCREMENT,
            filename   TEXT NOT NULL UNIQUE,
            applied_at TEXT DEFAULT (datetime('now','localtime'))
        )
    `, (err) => {
        if (err) {
            console.error('❌ Could not create schema_migrations table:', err.message);
            if (done) done(err);
            return;
        }

        // 2. Get list of already-applied migrations
        db.all('SELECT filename FROM schema_migrations', [], (err, rows) => {
            if (err) { if (done) done(err); return; }
            const applied = new Set(rows.map(r => r.filename));

            // 3. Read available migration files sorted by name
            let files = [];
            try {
                files = fs.readdirSync(MIGRATIONS_DIR)
                    .filter(f => f.endsWith('.sql'))
                    .sort();
            } catch {
                // Migrations dir doesn't exist yet — nothing to do
                console.log('ℹ️  No migrations directory found, skipping migrations');
                if (done) done(null);
                return;
            }

            const pending = files.filter(f => !applied.has(f));
            if (pending.length === 0) {
                console.log('✅ Database schema up to date');
                if (done) done(null);
                return;
            }

            console.log(`🔄 Applying ${pending.length} pending migration(s)…`);

            // 4. Apply each pending migration in sequence
            let i = 0;
            function applyNext() {
                if (i >= pending.length) {
                    console.log('✅ All migrations applied');
                    if (done) done(null);
                    return;
                }
                const filename = pending[i++];
                const filePath = path.join(MIGRATIONS_DIR, filename);
                let sql;
                try {
                    sql = fs.readFileSync(filePath, 'utf8');
                } catch (e) {
                    console.error(`❌ Could not read migration ${filename}:`, e.message);
                    if (done) done(e);
                    return;
                }

                console.log(`  → Applying migration: ${filename}`);
                db.exec(sql, (execErr) => {
                    if (execErr) {
                        console.error(`❌ Migration ${filename} failed:`, execErr.message);
                        if (done) done(execErr);
                        return;
                    }
                    // Record as applied
                    db.run('INSERT INTO schema_migrations (filename) VALUES (?)', [filename], (insErr) => {
                        if (insErr) {
                            console.error(`❌ Could not record migration ${filename}:`, insErr.message);
                            if (done) done(insErr);
                            return;
                        }
                        console.log(`  ✅ Applied: ${filename}`);
                        applyNext();
                    });
                });
            }

            applyNext();
        });
    });
}

module.exports = runMigrations;
