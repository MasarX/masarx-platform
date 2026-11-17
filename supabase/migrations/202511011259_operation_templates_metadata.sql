-- Migration 202511011259: operation_templates metadata column
-- Purpose: Ensure operation_templates includes metadata JSON blob before later migrations depend on it.
-- Adding IF NOT EXISTS guard so it can run safely across environments.

ALTER TABLE operation_templates
    ADD COLUMN IF NOT EXISTS metadata JSONB;

ALTER TABLE operation_templates
    ALTER COLUMN metadata SET DEFAULT '{}'::jsonb;

UPDATE operation_templates
SET metadata = '{}'::jsonb
WHERE metadata IS NULL;

