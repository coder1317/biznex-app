-- Migration 001: Business settings table
-- Stores the business profile configured in the first-run wizard.

CREATE TABLE IF NOT EXISTS business_settings (
    key   TEXT PRIMARY KEY,
    value TEXT NOT NULL
);

-- Default settings (will be updated by the first-run wizard)
INSERT OR IGNORE INTO business_settings (key, value) VALUES ('business_name',   'My Business');
INSERT OR IGNORE INTO business_settings (key, value) VALUES ('currency_symbol', '$');
INSERT OR IGNORE INTO business_settings (key, value) VALUES ('currency_code',   'USD');
INSERT OR IGNORE INTO business_settings (key, value) VALUES ('timezone',        'UTC');
INSERT OR IGNORE INTO business_settings (key, value) VALUES ('receipt_footer',  'Thank you for your purchase!');
INSERT OR IGNORE INTO business_settings (key, value) VALUES ('tax_rate',        '0');
INSERT OR IGNORE INTO business_settings (key, value) VALUES ('tax_label',       'Tax');
