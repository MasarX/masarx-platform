-- Migration: seed logestechs provider id used by auth config
-- Purpose: ensure provider 6247874b-190d-4442-a717-1f0f5f28682d exists before auth credentials are inserted.

BEGIN;

SET search_path TO public, pg_temp;

DO $$
DECLARE
    v_org UUID;
BEGIN
    SELECT organization_id
      INTO v_org
      FROM providers
     WHERE name = 'logestechs_3pl'
     ORDER BY created_at
     LIMIT 1;

    IF v_org IS NULL THEN
        SELECT id INTO v_org FROM organizations ORDER BY created_at LIMIT 1;
    END IF;

    IF NOT EXISTS (
        SELECT 1 FROM providers WHERE id = '6247874b-190d-4442-a717-1f0f5f28682d'::UUID
    ) THEN
        INSERT INTO providers (
            id,
            organization_id,
            name,
            provider_type,
            enabled,
            priority_rank,
            health_status
        )
        VALUES (
            '6247874b-190d-4442-a717-1f0f5f28682d'::UUID,
            v_org,
            'logestechs_3pl_auth_seed',
            '3pl',
            TRUE,
            10,
            'healthy'
        );
    END IF;
END $$;

COMMIT;
