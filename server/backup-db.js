#!/usr/bin/env node

/**
 * Database Backup Script
 * Uses SQLite's VACUUM INTO for a safe, consistent snapshot even while the
 * database is live (WAL mode). Falls back to file copy on older SQLite builds.
 * Usage: node server/backup-db.js
 */

const fs      = require('fs');
const path    = require('path');
const sqlite3 = require('sqlite3').verbose();

const dbPath   = process.env.DB_PATH || path.join(__dirname, 'biznex.db');
const backupDir = path.join(__dirname, 'backups');

if (!fs.existsSync(backupDir)) {
    fs.mkdirSync(backupDir, { recursive: true });
}

const timestamp  = new Date().toISOString().replace(/[:.]/g, '-');
const backupPath = path.join(backupDir, `biznex-${timestamp}.db`);

const srcDb = new sqlite3.Database(dbPath, sqlite3.OPEN_READONLY, (openErr) => {
    if (openErr) {
        // Fall back to raw file copy if DB cannot be opened via sqlite3
        console.warn('sqlite3 open failed, falling back to file copy:', openErr.message);
        try {
            fs.copyFileSync(dbPath, backupPath);
            console.log(`✅ Database backed up (file copy) to ${backupPath}`);
        } catch (copyErr) {
            console.error('❌ Backup failed:', copyErr.message);
            process.exit(1);
        }
        return;
    }

    // VACUUM INTO creates a clean, atomic snapshot (requires SQLite 3.27+)
    srcDb.run(`VACUUM INTO '${backupPath.replace(/'/g, "''")}'`, (err) => {
        srcDb.close();
        if (err) {
            // SQLite version doesn't support VACUUM INTO — fall back to copy
            console.warn('VACUUM INTO not supported, falling back to file copy:', err.message);
            try {
                fs.copyFileSync(dbPath, backupPath);
                console.log(`✅ Database backed up (file copy) to ${backupPath}`);
            } catch (copyErr) {
                console.error('❌ Backup failed:', copyErr.message);
                process.exit(1);
            }
        } else {
            console.log(`✅ Database backed up (VACUUM INTO) to ${backupPath}`);
        }
    });
});