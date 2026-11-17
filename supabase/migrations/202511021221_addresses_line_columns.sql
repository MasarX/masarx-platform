-- Migration 202511021221: Restore legacy line columns on addresses for geocoding functions
-- Purpose: Some stored procedures still reference addresses.line1/line2. Add nullable columns
--          so COALESCE(...) expressions work while normalized_line* remains authoritative.

ALTER TABLE addresses
    ADD COLUMN IF NOT EXISTS line1 TEXT,
    ADD COLUMN IF NOT EXISTS line2 TEXT;
