-- Migration: Seed QA access roles
-- Purpose: Register known user_type values for QA read access (row-driven allowlist).

BEGIN;

SET search_path TO qa, public, extensions, pg_temp;

INSERT INTO qa.qa_access_roles (user_type, enabled, notes)
VALUES
    ('account_manager', false, 'QA reader role (disabled by default)'),
    ('driver', false, 'QA reader role (disabled by default)'),
    ('dispatcher', false, 'QA reader role (disabled by default)')
ON CONFLICT (user_type) DO NOTHING;

UPDATE qa.qa_access_roles
SET enabled = true
WHERE user_type IN ('ops_admin', 'super_admin');

COMMIT;
