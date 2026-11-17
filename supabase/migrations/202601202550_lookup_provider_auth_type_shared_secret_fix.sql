-- Plan: PLAN-202601-schema-audit-improvements / Step: S04
-- Migration: Fixup provider_auth_type lookup values (provider_auth_configs uses shared_secret).

BEGIN;

SET search_path TO public, extensions, pg_temp;

INSERT INTO public.lookup_values (lookup_definition_id, value, label, sort_order, is_default, status)
SELECT d.id, 'shared_secret', 'Shared Secret', 15, false, 'active'
FROM public.lookup_definitions d
WHERE d.category = 'provider_auth_type'
ON CONFLICT (lookup_definition_id, value) DO NOTHING;

COMMIT;

