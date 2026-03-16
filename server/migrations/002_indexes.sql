-- Migration 002: Additional indexes and order improvements

-- Index on users for faster login lookups
CREATE INDEX IF NOT EXISTS idx_users_username ON users(username);

-- Index on refresh_tokens for faster cleanup
CREATE INDEX IF NOT EXISTS idx_refresh_tokens_user ON refresh_tokens(user_id);
CREATE INDEX IF NOT EXISTS idx_refresh_tokens_expires ON refresh_tokens(expires_at);

-- Index on discounts for lookup by code
CREATE INDEX IF NOT EXISTS idx_discounts_code ON discounts(code);
CREATE INDEX IF NOT EXISTS idx_discounts_active ON discounts(active);
