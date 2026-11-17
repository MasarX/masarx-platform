-- Phase 1 – Geocoding Foundation Hardening
-- Creates the geocoding_attempts ledger (hash partitioned), enforces provider uniqueness,
-- and seeds canonical provider rows without secrets.
/* objectives:allow RLS_MISSING Justification: RLS/policies for geocoding_attempts are introduced in later hardening migrations after foundational partitioned-ledger DDL is established. */
/* objectives:allow POLICY_MISSING Justification: Access policies for geocoding_attempts are intentionally introduced in subsequent migrations to keep this foundational migration deterministic and append-safe. */

BEGIN;

-- Acquire advisory lock to avoid concurrent structural edits during this migration.
SELECT pg_advisory_lock(hashtext('20251101090000_geocoding_foundation_fix'));

-- Ensure we operate in the public schema explicitly.
SET search_path TO public;

-- Create geocoding_attempts parent table and partitions if they do not yet exist.
DO $$
DECLARE
    partition_index integer;
BEGIN
    IF NOT EXISTS (
        SELECT 1
        FROM pg_class c
        JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE c.relname = 'geocoding_attempts'
          AND n.nspname = 'public'
    ) THEN
        EXECUTE $ddl$
            CREATE TABLE public.geocoding_attempts (
                organization_id uuid NOT NULL REFERENCES public.organizations(id),
                client_id uuid NOT NULL REFERENCES public.clients(id),
                sender_id uuid REFERENCES public.senders(id),
                address_id uuid NOT NULL,
                workflow_run_step_id uuid REFERENCES public.workflow_run_steps(id),
                outbound_call_id uuid REFERENCES public.outbound_calls(id),
                provider_name text NOT NULL,
                attempt_order integer NOT NULL CHECK (attempt_order >= 1),
                attempt_type text NOT NULL CHECK (attempt_type IN ('primary', 'fallback', 'retry', 'manual_review', 'cache_hit')),
                status text NOT NULL DEFAULT 'queued',
                confidence numeric(5,4),
                duration_ms integer,
                decision_outcome text,
                metadata jsonb,
                created_at timestamptz NOT NULL DEFAULT now(),
                updated_at timestamptz NOT NULL DEFAULT now(),
                CONSTRAINT geocoding_attempts_metadata_check CHECK (metadata IS NULL OR jsonb_typeof(metadata) = 'object'),
                CONSTRAINT geocoding_attempts_address_fk FOREIGN KEY (address_id, client_id) REFERENCES public.addresses (id, client_id)
            ) PARTITION BY HASH (address_id);
        $ddl$;
    END IF;

    FOR partition_index IN 0..3 LOOP
        IF NOT EXISTS (
            SELECT 1
            FROM pg_class c
            JOIN pg_namespace n ON n.oid = c.relnamespace
            WHERE c.relname = format('geocoding_attempts_p%s', partition_index)
              AND n.nspname = 'public'
        ) THEN
            EXECUTE format(
                'CREATE TABLE public.geocoding_attempts_p%s PARTITION OF public.geocoding_attempts FOR VALUES WITH (MODULUS 4, REMAINDER %s);',
                partition_index,
                partition_index
            );
        END IF;

        IF NOT EXISTS (
            SELECT 1
            FROM pg_class c
            JOIN pg_namespace n ON n.oid = c.relnamespace
            WHERE c.relname = format('geocoding_attempts_p%s_address_provider_idx', partition_index)
              AND n.nspname = 'public'
        ) THEN
            EXECUTE format(
                'CREATE INDEX geocoding_attempts_p%s_address_provider_idx ON public.geocoding_attempts_p%s (address_id, provider_name);',
                partition_index,
                partition_index
            );
        END IF;

        IF NOT EXISTS (
            SELECT 1
            FROM pg_class c
            JOIN pg_namespace n ON n.oid = c.relnamespace
            WHERE c.relname = format('geocoding_attempts_p%s_org_created_idx', partition_index)
              AND n.nspname = 'public'
        ) THEN
            EXECUTE format(
                'CREATE INDEX geocoding_attempts_p%s_org_created_idx ON public.geocoding_attempts_p%s (organization_id, created_at DESC);',
                partition_index,
                partition_index
            );
        END IF;

        IF NOT EXISTS (
            SELECT 1
            FROM pg_class c
            JOIN pg_namespace n ON n.oid = c.relnamespace
            WHERE c.relname = format('geocoding_attempts_p%s_workflow_step_idx', partition_index)
              AND n.nspname = 'public'
        ) THEN
            EXECUTE format(
                'CREATE INDEX geocoding_attempts_p%s_workflow_step_idx ON public.geocoding_attempts_p%s (workflow_run_step_id);',
                partition_index,
                partition_index
            );
        END IF;
    END LOOP;
END
$$;

-- Add deterministic uniqueness constraint to prevent duplicate attempts per provider.
DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1
        FROM pg_constraint
        WHERE conname = 'geocoding_attempts_address_provider_order_key'
          AND conrelid = 'public.geocoding_attempts'::regclass
    ) THEN
        ALTER TABLE public.geocoding_attempts
            ADD CONSTRAINT geocoding_attempts_address_provider_order_key
            UNIQUE (address_id, provider_name, attempt_order);
    END IF;
END
$$;

-- Ensure providers remain unique per organization/name/type.
DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1
        FROM pg_constraint
        WHERE conname = 'providers_org_name_type_key'
          AND conrelid = 'public.providers'::regclass
    ) THEN
        ALTER TABLE public.providers
            ADD CONSTRAINT providers_org_name_type_key
            UNIQUE (organization_id, name, provider_type);
    END IF;
END
$$;

-- Seed canonical provider rows (metadata only, no credentials) under global-root.
WITH upsert_global_root AS (
    INSERT INTO public.organizations (id, name, slug, timezone, locale, billing_status)
    VALUES ('00000000-0000-0000-0000-000000000000'::uuid, 'Global', 'global-root', 'UTC', 'en-US', 'active')
    ON CONFLICT (id) DO NOTHING
    RETURNING id
),
target_org AS (
    SELECT o.id
    FROM public.organizations o
    WHERE o.id = '00000000-0000-0000-0000-000000000000'::uuid
       OR o.slug = 'global-root'
    ORDER BY CASE WHEN o.id = '00000000-0000-0000-0000-000000000000'::uuid THEN 0 ELSE 1 END
    LIMIT 1
),
upserts AS (
    SELECT
        v.id,
        t.id AS organization_id,
        v.name,
        v.provider_type,
        v.priority_rank,
        v.metadata
    FROM target_org t
    JOIN (VALUES
        ('1fdf96b5-1c64-4c34-90d3-0ffa5014a4f8'::uuid, 'google_maps', 'geocoding', 110, '{"base_url": "https://maps.googleapis.com/maps/api/geocode/json"}'::jsonb),
        ('8a96e85b-7b17-437a-920a-ad5180734d0f'::uuid, 'internal_cache', 'geocoding', 10, '{"description": "Internal geocode cache lookup"}'::jsonb),
        ('2a9b8bd5-6817-4e3f-97ec-88086ff0ce4d'::uuid, 'manual_review_virtual', 'geocoding', 900, '{"description": "Manual review placeholder provider"}'::jsonb)
    ) AS v(id, name, provider_type, priority_rank, metadata) ON TRUE
)
INSERT INTO public.providers AS p (
    id,
    organization_id,
    name,
    provider_type,
    enabled,
    priority_rank,
    metadata
)
SELECT
    u.id,
    u.organization_id,
    u.name,
    u.provider_type,
    true,
    u.priority_rank,
    u.metadata
FROM upserts u
ON CONFLICT (id) DO UPDATE
SET
    organization_id = EXCLUDED.organization_id,
    name = EXCLUDED.name,
    provider_type = EXCLUDED.provider_type,
    enabled = EXCLUDED.enabled,
    priority_rank = EXCLUDED.priority_rank,
    metadata = EXCLUDED.metadata,
    updated_at = now();

-- Release advisory lock.
SELECT pg_advisory_unlock(hashtext('20251101090000_geocoding_foundation_fix'));

COMMIT;
