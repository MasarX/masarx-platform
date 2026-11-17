-- Migration: Audit ledger with partitioning + triggers + correlation helper
-- Date: 2025-12-01 12:10 UTC

BEGIN;

-------------------------------------------------------------------------------
-- 1) Audit ledger (HASH + RANGE partitioned)
-------------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS public.audit_table_changes (
    id UUID NOT NULL DEFAULT gen_random_uuid(),
    organization_id UUID,
    schema_name TEXT NOT NULL,
    table_name TEXT NOT NULL,
    op TEXT NOT NULL CHECK (op IN ('INSERT','UPDATE','DELETE','TRUNCATE')),
    pk JSONB,
    row_old JSONB,
    row_new JSONB,
    changed_by TEXT,
    correlation_id UUID,
    request_context JSONB,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (id, organization_id, created_at)
) PARTITION BY HASH (organization_id);

-- Single HASH partition (MODULUS 1) partitioned by RANGE over created_at
CREATE TABLE IF NOT EXISTS public.audit_table_changes_p0
    PARTITION OF public.audit_table_changes
    FOR VALUES WITH (MODULUS 1, REMAINDER 0)
    PARTITION BY RANGE (created_at);

-- Current month RANGE partition
DO $$
DECLARE
  v_from DATE := date_trunc('month', now())::date;
  v_to   DATE := (date_trunc('month', now()) + INTERVAL '1 month')::date;
  v_name TEXT := format('audit_table_changes_%s_%s', EXTRACT(YEAR FROM v_from)::int, lpad(EXTRACT(MONTH FROM v_from)::int::text, 2, '0'));
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'public' AND c.relname = v_name
  ) THEN
    EXECUTE format(
      'CREATE TABLE public.%I PARTITION OF public.audit_table_changes_p0 FOR VALUES FROM (%L) TO (%L)',
      v_name, v_from::timestamptz, v_to::timestamptz
    );
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_audit_table_changes_org_created
  ON public.audit_table_changes_p0 (organization_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_audit_table_changes_table_created
  ON public.audit_table_changes_p0 (table_name, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_audit_table_changes_corr
  ON public.audit_table_changes_p0 (correlation_id);

COMMENT ON TABLE public.audit_table_changes IS 'Row-level change log across user-facing tables (trace-aware, partitioned).';
COMMENT ON COLUMN public.audit_table_changes.changed_by IS 'Actor extracted from JWT claims or current_user.';
COMMENT ON COLUMN public.audit_table_changes.correlation_id IS 'Trace ID (request_contexts / workflow context).';

-------------------------------------------------------------------------------
-- 2) RLS: service_role-only
-------------------------------------------------------------------------------

ALTER TABLE public.audit_table_changes ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.audit_table_changes_p0 ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON TABLE public.audit_table_changes FROM PUBLIC;
REVOKE ALL ON TABLE public.audit_table_changes FROM anon;
REVOKE ALL ON TABLE public.audit_table_changes FROM authenticated;

REVOKE ALL ON TABLE public.audit_table_changes_p0 FROM PUBLIC;
REVOKE ALL ON TABLE public.audit_table_changes_p0 FROM anon;
REVOKE ALL ON TABLE public.audit_table_changes_p0 FROM authenticated;

GRANT ALL ON TABLE public.audit_table_changes TO service_role;
GRANT ALL ON TABLE public.audit_table_changes_p0 TO service_role;

DROP POLICY IF EXISTS audit_table_changes_service_policy ON public.audit_table_changes;
CREATE POLICY audit_table_changes_service_policy
  ON public.audit_table_changes
  FOR ALL
  TO service_role
  USING (TRUE)
  WITH CHECK (TRUE);

DROP POLICY IF EXISTS audit_table_changes_insert_public ON public.audit_table_changes;
CREATE POLICY audit_table_changes_insert_public
  ON public.audit_table_changes
  FOR INSERT
  TO PUBLIC
  WITH CHECK (TRUE);

DROP POLICY IF EXISTS audit_table_changes_service_policy ON public.audit_table_changes_p0;
CREATE POLICY audit_table_changes_service_policy
  ON public.audit_table_changes_p0
  FOR ALL
  TO service_role
  USING (TRUE)
  WITH CHECK (TRUE);

DROP POLICY IF EXISTS audit_table_changes_insert_public ON public.audit_table_changes_p0;
CREATE POLICY audit_table_changes_insert_public
  ON public.audit_table_changes_p0
  FOR INSERT
  TO PUBLIC
  WITH CHECK (TRUE);

-------------------------------------------------------------------------------
-- 3) Helpers: current_correlation_id + audit trigger
-------------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.current_correlation_id()
RETURNS UUID
LANGUAGE plpgsql
STABLE
AS $$
DECLARE
  v_raw TEXT;
BEGIN
  BEGIN
    v_raw := current_setting('request.correlation_id', true);
  EXCEPTION WHEN others THEN
    v_raw := NULL;
  END;
  IF v_raw IS NULL OR v_raw = '' THEN
    RETURN NULL;
  END IF;
  RETURN v_raw::UUID;
EXCEPTION WHEN others THEN
  RETURN NULL;
END;
$$;

COMMENT ON FUNCTION public.current_correlation_id()
  IS 'Returns the current correlation/trace id from request context if available.';

CREATE OR REPLACE FUNCTION public.audit_capture_row_change()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO public, extensions, pg_temp
AS $$
DECLARE
  v_pk JSONB := NULL;
  v_row_old JSONB := NULL;
  v_row_new JSONB := NULL;
  v_actor TEXT := NULL;
  v_corr UUID := NULL;
  v_org UUID := NULL;
  v_claims JSONB;
BEGIN
  IF TG_TABLE_NAME = 'audit_table_changes' THEN
    RETURN NULL;
  END IF;

  IF TG_OP IN ('UPDATE','DELETE') THEN
    v_row_old := to_jsonb(OLD);
  END IF;
  IF TG_OP IN ('INSERT','UPDATE') THEN
    v_row_new := to_jsonb(NEW);
  END IF;

  IF v_row_new ? 'id' THEN
    v_pk := jsonb_build_object('id', v_row_new->'id');
  ELSIF v_row_old ? 'id' THEN
    v_pk := jsonb_build_object('id', v_row_old->'id');
  END IF;

  -- Try to capture organization_id if present on row
  IF v_row_new ? 'organization_id' THEN
    v_org := NULLIF(v_row_new->>'organization_id','')::uuid;
  ELSIF v_row_old ? 'organization_id' THEN
    v_org := NULLIF(v_row_old->>'organization_id','')::uuid;
  END IF;

  -- Actor from JWT claims or current_user
  BEGIN
    v_claims := current_setting('request.jwt.claims', true)::jsonb;
    IF v_claims ? 'sub' THEN
      v_actor := v_claims->>'sub';
    ELSIF v_claims ? 'role' THEN
      v_actor := v_claims->>'role';
    END IF;
  EXCEPTION WHEN others THEN
    v_actor := NULL;
  END;
  IF v_actor IS NULL THEN
    v_actor := current_user;
  END IF;

  -- Correlation: prefer row value, otherwise ambient setting
  IF v_row_new ? 'correlation_id' AND v_row_new->>'correlation_id' <> '' THEN
    v_corr := NULLIF(v_row_new->>'correlation_id','')::uuid;
  ELSIF v_row_old ? 'correlation_id' AND v_row_old->>'correlation_id' <> '' THEN
    v_corr := NULLIF(v_row_old->>'correlation_id','')::uuid;
  ELSE
    v_corr := public.current_correlation_id();
  END IF;

  INSERT INTO public.audit_table_changes(
    organization_id,
    schema_name,
    table_name,
    op,
    pk,
    row_old,
    row_new,
    changed_by,
    correlation_id,
    request_context,
    created_at
  )
  VALUES (
    v_org,
    TG_TABLE_SCHEMA,
    TG_TABLE_NAME,
    TG_OP,
    v_pk,
    v_row_old,
    v_row_new,
    v_actor,
    v_corr,
    NULL,
    now()
  );

  IF TG_OP = 'DELETE' THEN
    RETURN OLD;
  ELSE
    RETURN NEW;
  END IF;
END;
$$;

COMMENT ON FUNCTION public.audit_capture_row_change()
  IS 'Row-level audit trigger: captures old/new, actor, org, correlation_id into audit_table_changes.';

-------------------------------------------------------------------------------
-- 4) Attach triggers to all public tables (skip audit ledger itself)
-------------------------------------------------------------------------------

DO $$
DECLARE
  r RECORD;
BEGIN
  FOR r IN
    SELECT c.relname
    FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'public'
      AND c.relkind IN ('r','p')
      AND c.relispartition = false
      AND c.relname NOT IN ('audit_table_changes')
      AND c.relname NOT LIKE 'audit_table_changes%'
  LOOP
    PERFORM 1 FROM pg_trigger t
    WHERE t.tgrelid = format('public.%I', r.relname)::regclass
      AND t.tgname = 'audit_row_change';
    IF NOT FOUND THEN
      EXECUTE format(
        'CREATE TRIGGER audit_row_change BEFORE INSERT OR UPDATE OR DELETE ON public.%I FOR EACH ROW EXECUTE FUNCTION public.audit_capture_row_change()',
        r.relname
      );
    END IF;

    PERFORM 1 FROM pg_trigger t
    WHERE t.tgrelid = format('public.%I', r.relname)::regclass
      AND t.tgname = 'audit_truncate_change';
    IF NOT FOUND THEN
      EXECUTE format(
        'CREATE TRIGGER audit_truncate_change AFTER TRUNCATE ON public.%I FOR EACH STATEMENT EXECUTE FUNCTION public.audit_capture_row_change()',
        r.relname
      );
    END IF;
  END LOOP;
END $$;

COMMIT;
