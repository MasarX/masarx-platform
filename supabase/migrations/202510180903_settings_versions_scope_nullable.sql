BEGIN;

-- Drop legacy foreign keys that reference the old composite key
ALTER TABLE public.settings
    DROP CONSTRAINT IF EXISTS settings_settings_version_fk,
    DROP CONSTRAINT IF EXISTS settings_settings_version_id_scope_id_fkey;

ALTER TABLE public.settings_cache
    DROP CONSTRAINT IF EXISTS settings_cache_settings_version_fk,
    DROP CONSTRAINT IF EXISTS settings_cache_settings_version_id_settings_scope_id_fkey;

-- Rebuild settings_versions with nullable scope_id support
CREATE TABLE public.settings_versions_new (
    id UUID NOT NULL DEFAULT gen_random_uuid(),
    category TEXT NOT NULL,
    scope_type TEXT NOT NULL,
    scope_id UUID,
    scope_hash UUID NOT NULL DEFAULT '00000000-0000-0000-0000-000000000000'::uuid,
    version INTEGER NOT NULL,
    value JSONB NOT NULL,
    schema_version INTEGER,
    change_reason TEXT,
    requested_by UUID REFERENCES public.users(id),
    approved_by UUID REFERENCES public.users(id),
    approved_at TIMESTAMPTZ,
    effective_from TIMESTAMPTZ NOT NULL DEFAULT now(),
    effective_until TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (id, scope_hash),
    CONSTRAINT settings_versions_new_effective_dates_check CHECK (effective_until IS NULL OR effective_until > effective_from),
    CONSTRAINT settings_versions_scope_hash_check CHECK (scope_hash = COALESCE(scope_id, '00000000-0000-0000-0000-000000000000'::uuid))
) PARTITION BY HASH (scope_hash);

CREATE TABLE public.settings_versions_new_p0
    PARTITION OF public.settings_versions_new
    FOR VALUES WITH (MODULUS 1, REMAINDER 0);

CREATE INDEX idx_settings_versions_new_scope_id ON public.settings_versions_new(scope_id);
CREATE INDEX idx_settings_versions_new_scope ON public.settings_versions_new(scope_type, scope_id);
CREATE INDEX idx_settings_versions_new_category ON public.settings_versions_new(category);
CREATE INDEX idx_settings_versions_new_effective ON public.settings_versions_new(effective_from, effective_until);

CREATE UNIQUE INDEX idx_settings_versions_new_current
    ON public.settings_versions_new(category, scope_type, scope_hash)
    WHERE effective_until IS NULL AND approved_at IS NOT NULL;

ALTER TABLE public.settings_versions_new
    ADD CONSTRAINT settings_versions_id_scope_hash_unique UNIQUE (id, scope_hash);

INSERT INTO public.settings_versions_new (
    id,
    category,
    scope_type,
    scope_id,
    scope_hash,
    version,
    value,
    schema_version,
    change_reason,
    requested_by,
    approved_by,
    approved_at,
    effective_from,
    effective_until,
    created_at
)
SELECT
    id,
    category,
    scope_type,
    CASE
        WHEN scope_type = 'global' AND scope_id = '00000000-0000-0000-0000-000000000000'::uuid THEN NULL
        ELSE scope_id
    END AS scope_id,
    COALESCE(scope_id, '00000000-0000-0000-0000-000000000000'::uuid) AS scope_hash,
    version,
    value,
    schema_version,
    change_reason,
    requested_by,
    approved_by,
    approved_at,
    effective_from,
    effective_until,
    created_at
FROM public.settings_versions;

ALTER TABLE public.settings_versions RENAME TO settings_versions_v1_backup;

ALTER TABLE public.settings_versions_new RENAME TO settings_versions;

COMMENT ON TABLE public.settings_versions IS 'Versioned configuration settings with approval workflow and HASH partitioning by resolved scope.';
COMMENT ON COLUMN public.settings_versions.scope_hash IS 'Resolved scope identifier used for partitioning and FK references (scope_id or UUID nil for global rows).';

DROP TABLE public.settings_versions_v1_backup CASCADE;

ALTER TABLE public.settings_versions_new_p0 RENAME TO settings_versions_p0;

ALTER INDEX idx_settings_versions_new_scope_id RENAME TO idx_settings_versions_scope_id;
ALTER INDEX idx_settings_versions_new_scope RENAME TO idx_settings_versions_scope;
ALTER INDEX idx_settings_versions_new_category RENAME TO idx_settings_versions_category;
ALTER INDEX idx_settings_versions_new_effective RENAME TO idx_settings_versions_effective;
ALTER INDEX idx_settings_versions_new_current RENAME TO idx_settings_versions_current_hash;
UPDATE public.settings_versions
SET scope_hash = COALESCE(scope_id, '00000000-0000-0000-0000-000000000000'::uuid);

DROP TRIGGER IF EXISTS settings_versions_scope_guard ON public.settings_versions;
DROP TRIGGER IF EXISTS settings_scope_guard ON public.settings;

-- Refresh settings + cache metadata to use scope_hash semantics
ALTER TABLE public.settings
    DROP CONSTRAINT IF EXISTS settings_category_scope_type_scope_id_key,
    ADD COLUMN IF NOT EXISTS scope_hash UUID;

UPDATE public.settings
SET scope_hash = COALESCE(scope_id, '00000000-0000-0000-0000-000000000000'::uuid);

ALTER TABLE public.settings
    ALTER COLUMN scope_hash SET NOT NULL,
    ALTER COLUMN scope_hash SET DEFAULT '00000000-0000-0000-0000-000000000000'::uuid,
    ADD CONSTRAINT settings_scope_hash_check CHECK (scope_hash = COALESCE(scope_id, '00000000-0000-0000-0000-000000000000'::uuid)),
    ADD CONSTRAINT settings_scope_hash_unique UNIQUE (category, scope_type, scope_hash),
    ADD CONSTRAINT settings_category_scope_type_scope_id_key UNIQUE (category, scope_type, scope_id);

ALTER TABLE public.settings_cache
    ADD COLUMN IF NOT EXISTS settings_scope_hash UUID;

UPDATE public.settings_cache
SET settings_scope_hash = COALESCE(settings_scope_id, '00000000-0000-0000-0000-000000000000'::uuid);

ALTER TABLE public.settings_cache
    ALTER COLUMN settings_scope_hash SET NOT NULL,
    ALTER COLUMN settings_scope_hash SET DEFAULT '00000000-0000-0000-0000-000000000000'::uuid,
    ADD CONSTRAINT settings_cache_scope_hash_check CHECK (settings_scope_hash = COALESCE(settings_scope_id, '00000000-0000-0000-0000-000000000000'::uuid));

UPDATE public.settings
SET scope_id = NULL,
    scope_hash = '00000000-0000-0000-0000-000000000000'::uuid
WHERE scope_type = 'global';

UPDATE public.settings_cache
SET settings_scope_id = NULL,
    settings_scope_hash = '00000000-0000-0000-0000-000000000000'::uuid
WHERE settings_scope_id = '00000000-0000-0000-0000-000000000000'::uuid;

-- Ensure scope_hash remains in sync on DML
CREATE OR REPLACE FUNCTION public.sync_settings_versions_scope_hash()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
    NEW.scope_hash := COALESCE(NEW.scope_id, '00000000-0000-0000-0000-000000000000'::uuid);
    RETURN NEW;
END;
$$;

CREATE TRIGGER settings_versions_scope_hash_sync
BEFORE INSERT OR UPDATE ON public.settings_versions
FOR EACH ROW EXECUTE FUNCTION public.sync_settings_versions_scope_hash();

CREATE OR REPLACE FUNCTION public.sync_settings_scope_hash()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
    NEW.scope_hash := COALESCE(NEW.scope_id, '00000000-0000-0000-0000-000000000000'::uuid);
    RETURN NEW;
END;
$$;

CREATE TRIGGER settings_scope_hash_sync
BEFORE INSERT OR UPDATE ON public.settings
FOR EACH ROW EXECUTE FUNCTION public.sync_settings_scope_hash();

CREATE OR REPLACE FUNCTION public.sync_settings_cache_scope_hash()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
    NEW.settings_scope_hash := COALESCE(NEW.settings_scope_id, '00000000-0000-0000-0000-000000000000'::uuid);
    RETURN NEW;
END;
$$;

CREATE TRIGGER settings_cache_scope_hash_sync
BEFORE INSERT OR UPDATE ON public.settings_cache
FOR EACH ROW EXECUTE FUNCTION public.sync_settings_cache_scope_hash();

-- Rebuild validation trigger without sentinel logic
CREATE OR REPLACE FUNCTION public.validate_settings_scope()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
    scope_valid BOOLEAN := false;
BEGIN
    IF NEW.scope_type = 'global' THEN
        IF NEW.scope_id IS NULL THEN
            scope_valid := true;
        END IF;
    ELSIF NEW.scope_type = 'tenant' THEN
        SELECT TRUE INTO scope_valid FROM public.organizations WHERE id = NEW.scope_id;
    ELSIF NEW.scope_type = 'client' THEN
        SELECT TRUE INTO scope_valid FROM public.clients WHERE id = NEW.scope_id;
    ELSIF NEW.scope_type = 'sender' THEN
        SELECT TRUE INTO scope_valid FROM public.senders WHERE id = NEW.scope_id;
    ELSIF NEW.scope_type = 'resource' THEN
        SELECT TRUE INTO scope_valid FROM public.providers WHERE id = NEW.scope_id;
    ELSIF NEW.scope_type = 'source' THEN
        SELECT TRUE INTO scope_valid FROM public.webhook_sources WHERE id = NEW.scope_id;
    ELSE
        RAISE EXCEPTION 'Unsupported scope_type %', NEW.scope_type USING ERRCODE = '23514';
    END IF;

    IF NOT scope_valid THEN
        RAISE EXCEPTION 'Invalid scope %/% for % record %', NEW.scope_type, NEW.scope_id, TG_TABLE_NAME, NEW.id USING ERRCODE = '23514';
    END IF;

    IF TG_TABLE_NAME = 'settings' THEN
        PERFORM 1
        FROM public.settings_versions sv
        WHERE sv.id = NEW.settings_version_id
          AND sv.scope_type = NEW.scope_type
          AND sv.scope_hash = NEW.scope_hash;

        IF NOT FOUND THEN
            RAISE EXCEPTION 'settings row % references version % with mismatched scope', NEW.id, NEW.settings_version_id USING ERRCODE = '23503';
        END IF;
    END IF;

    RETURN NEW;
END;
$$;

CREATE CONSTRAINT TRIGGER settings_versions_scope_guard
AFTER INSERT OR UPDATE ON public.settings_versions
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION public.validate_settings_scope();

CREATE CONSTRAINT TRIGGER settings_scope_guard
AFTER INSERT OR UPDATE ON public.settings
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION public.validate_settings_scope();

-- Recreate foreign keys against the new scope_hash primary key
ALTER TABLE public.settings
    ADD CONSTRAINT settings_settings_version_fk
    FOREIGN KEY (settings_version_id, scope_hash)
    REFERENCES public.settings_versions (id, scope_hash)
    DEFERRABLE INITIALLY DEFERRED
    NOT VALID;

ALTER TABLE public.settings_cache
    ADD CONSTRAINT settings_cache_settings_version_fk
    FOREIGN KEY (settings_version_id, settings_scope_hash)
    REFERENCES public.settings_versions (id, scope_hash)
    DEFERRABLE INITIALLY DEFERRED
    NOT VALID;

ALTER TABLE public.settings VALIDATE CONSTRAINT settings_settings_version_fk;
ALTER TABLE public.settings_cache VALIDATE CONSTRAINT settings_cache_settings_version_fk;

-- Normalize resolver functions to rely on NULL globals
CREATE OR REPLACE FUNCTION resolve_settings(
    p_category TEXT,
    p_scope_type TEXT,
    p_scope_id UUID
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
    v_value JSONB;
    v_client_id UUID;
    v_org_id UUID;
    v_sender_id UUID;
BEGIN
    IF p_category IS NULL THEN
        RETURN NULL;
    END IF;

    IF p_scope_type IS NULL OR p_scope_type = '' THEN
        p_scope_type := 'global';
    ELSIF p_scope_type = 'organization' THEN
        p_scope_type := 'tenant';
    END IF;

    IF p_scope_type = 'global' THEN
        SELECT cached_value
        INTO v_value
        FROM settings
        WHERE category = p_category
          AND scope_type = 'global'
          AND scope_id IS NULL
        ORDER BY last_updated DESC
        LIMIT 1;
        RETURN v_value;
    END IF;

    SELECT cached_value
    INTO v_value
    FROM settings
    WHERE category = p_category
      AND scope_type = p_scope_type
      AND (
            (scope_type = 'global' AND scope_id IS NULL)
            OR scope_id = p_scope_id
          )
    ORDER BY last_updated DESC
    LIMIT 1;

    IF v_value IS NOT NULL THEN
        RETURN v_value;
    END IF;

    IF p_scope_type = 'resource' THEN
        RETURN resolve_settings(p_category, 'global', NULL);
    ELSIF p_scope_type = 'source' THEN
        SELECT sender_id, organization_id
        INTO v_sender_id, v_org_id
        FROM webhook_sources
        WHERE id = p_scope_id;

        IF v_sender_id IS NOT NULL THEN
            v_value := resolve_settings(p_category, 'sender', v_sender_id);
            IF v_value IS NOT NULL THEN
                RETURN v_value;
            END IF;

            SELECT client_id INTO v_client_id FROM senders WHERE id = v_sender_id;
            IF v_client_id IS NOT NULL THEN
                v_value := resolve_settings(p_category, 'client', v_client_id);
                IF v_value IS NOT NULL THEN
                    RETURN v_value;
                END IF;
            END IF;
        END IF;

        IF v_client_id IS NULL AND v_sender_id IS NULL AND v_org_id IS NULL THEN
            SELECT organization_id INTO v_org_id FROM webhook_sources WHERE id = p_scope_id;
        END IF;

        IF v_org_id IS NOT NULL THEN
            v_value := resolve_settings(p_category, 'tenant', v_org_id);
            IF v_value IS NOT NULL THEN
                RETURN v_value;
            END IF;
        END IF;

        RETURN resolve_settings(p_category, 'global', NULL);
    ELSIF p_scope_type = 'sender' THEN
        SELECT client_id INTO v_client_id FROM senders WHERE id = p_scope_id;
        IF v_client_id IS NOT NULL THEN
            v_value := resolve_settings(p_category, 'client', v_client_id);
            IF v_value IS NOT NULL THEN
                RETURN v_value;
            END IF;
        END IF;

        SELECT c.organization_id INTO v_org_id
        FROM senders s
        JOIN clients c ON c.id = s.client_id
        WHERE s.id = p_scope_id;

        IF v_org_id IS NOT NULL THEN
            v_value := resolve_settings(p_category, 'tenant', v_org_id);
            IF v_value IS NOT NULL THEN
                RETURN v_value;
            END IF;
        END IF;

        RETURN resolve_settings(p_category, 'global', NULL);
    ELSIF p_scope_type = 'client' THEN
        SELECT organization_id INTO v_org_id FROM clients WHERE id = p_scope_id;
        IF v_org_id IS NOT NULL THEN
            v_value := resolve_settings(p_category, 'tenant', v_org_id);
            IF v_value IS NOT NULL THEN
                RETURN v_value;
            END IF;
        END IF;

        RETURN resolve_settings(p_category, 'global', NULL);
    ELSIF p_scope_type = 'tenant' THEN
        RETURN resolve_settings(p_category, 'global', NULL);
    ELSE
        RETURN resolve_settings(p_category, 'global', NULL);
    END IF;
END;
$$;

CREATE OR REPLACE FUNCTION resolve_webhook_ingest_policy(
    p_webhook_source_id UUID
)
RETURNS TABLE (
    settings_id UUID,
    settings_version_id UUID,
    scope_type TEXT,
    scope_id UUID,
    policy JSONB,
    policy_version INT
)
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
    v_sender_id UUID;
    v_client_id UUID;
    v_org_id UUID;
    v_rows INT;
BEGIN
    SELECT sender_id, organization_id
    INTO v_sender_id, v_org_id
    FROM webhook_sources
    WHERE id = p_webhook_source_id;

    IF NOT FOUND THEN
        RAISE EXCEPTION 'webhook source % not found', p_webhook_source_id;
    END IF;

    IF v_sender_id IS NOT NULL THEN
        SELECT client_id INTO v_client_id FROM senders WHERE id = v_sender_id;
    END IF;

    RETURN QUERY
    SELECT ranked.id,
           ranked.settings_version_id,
           ranked.scope_type,
           ranked.scope_id,
           ranked.policy,
           ranked.version
    FROM (
        SELECT s.id,
               s.settings_version_id,
               s.scope_type,
               s.scope_id,
               s.cached_value AS policy,
               sv.version,
               1 AS priority
        FROM settings s
        JOIN settings_versions sv ON sv.id = s.settings_version_id
        WHERE s.category = 'webhook_ingest_policy'
          AND s.scope_type = 'source'
          AND s.scope_id = p_webhook_source_id

        UNION ALL
        SELECT s.id,
               s.settings_version_id,
               s.scope_type,
               s.scope_id,
               s.cached_value,
               sv.version,
               2 AS priority
        FROM settings s
        JOIN settings_versions sv ON sv.id = s.settings_version_id
        WHERE s.category = 'webhook_ingest_policy'
          AND s.scope_type = 'sender'
          AND v_sender_id IS NOT NULL
          AND s.scope_id = v_sender_id

        UNION ALL
        SELECT s.id,
               s.settings_version_id,
               s.scope_type,
               s.scope_id,
               s.cached_value,
               sv.version,
               3 AS priority
        FROM settings s
        JOIN settings_versions sv ON sv.id = s.settings_version_id
        WHERE s.category = 'webhook_ingest_policy'
          AND s.scope_type = 'client'
          AND v_client_id IS NOT NULL
          AND s.scope_id = v_client_id

        UNION ALL
        SELECT s.id,
               s.settings_version_id,
               s.scope_type,
               s.scope_id,
               s.cached_value,
               sv.version,
               4 AS priority
        FROM settings s
        JOIN settings_versions sv ON sv.id = s.settings_version_id
        WHERE s.category = 'webhook_ingest_policy'
          AND s.scope_type = 'tenant'
          AND v_org_id IS NOT NULL
          AND s.scope_id = v_org_id

        UNION ALL
        SELECT s.id,
               s.settings_version_id,
               s.scope_type,
               s.scope_id,
               s.cached_value,
               sv.version,
               5 AS priority
        FROM settings s
        JOIN settings_versions sv ON sv.id = s.settings_version_id
        WHERE s.category = 'webhook_ingest_policy'
          AND s.scope_type = 'global'
          AND s.scope_id IS NULL
    ) ranked
    ORDER BY ranked.priority
    LIMIT 1;

    GET DIAGNOSTICS v_rows = ROW_COUNT;
    IF v_rows = 0 THEN
        RAISE EXCEPTION 'No webhook_ingest_policy found for webhook_source_id=%', p_webhook_source_id;
    END IF;
END;
$$;

COMMIT;
