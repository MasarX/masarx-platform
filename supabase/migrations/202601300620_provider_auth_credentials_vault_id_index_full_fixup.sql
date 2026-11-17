-- Plan: PLAN-202601-last-mile-enterprise-audit / Step: S04
-- Migration: FK index hygiene for provider_auth_configs.credentials_vault_id
-- Purpose:
--   - pgTAP enforces that FK columns have supporting non-partial indexes.
--   - Replace the partial index on provider_auth_configs.credentials_vault_id with a full index.
-- Date: 2026-01-30

BEGIN;

DROP INDEX IF EXISTS public.idx_provider_auth_configs_credentials_vault_id;

CREATE INDEX IF NOT EXISTS idx_provider_auth_configs_credentials_vault_id
  ON public.provider_auth_configs(credentials_vault_id);

COMMIT;

