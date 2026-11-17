-- Migration: Audit row redaction rules (row-driven)
-- Date: 2025-12-29
--
-- Purpose:
--  - Provide a row-driven mechanism to redact sensitive columns from audit_table_changes.row_old/row_new.
--  - Keep defaults backward-compatible: no rule => store row as-is.
BEGIN;

-------------------------------------------------------------------------------
-- 1) Config table: audit_redaction_rules
-------------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.audit_redaction_rules (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  table_schema TEXT NOT NULL DEFAULT 'public',
  table_name TEXT NOT NULL,
  mode TEXT NOT NULL DEFAULT 'denylist',
  columns TEXT[] NOT NULL DEFAULT '{}'::text[],
  redaction_token TEXT NOT NULL DEFAULT '[REDACTED]',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT audit_redaction_rules_mode_check CHECK (mode IN ('denylist', 'allowlist')),
  CONSTRAINT audit_redaction_rules_unique UNIQUE (table_schema, table_name)
);

COMMENT ON TABLE public.audit_redaction_rules
  IS 'Row-driven audit redaction rules for audit_table_changes row_old/row_new.';
COMMENT ON COLUMN public.audit_redaction_rules.mode
  IS 'denylist = redact listed columns; allowlist = keep listed columns only.';
COMMENT ON COLUMN public.audit_redaction_rules.columns
  IS 'Column names (JSON keys) used by the chosen mode.';

ALTER TABLE public.audit_redaction_rules ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON TABLE public.audit_redaction_rules FROM PUBLIC;
REVOKE ALL ON TABLE public.audit_redaction_rules FROM anon;
REVOKE ALL ON TABLE public.audit_redaction_rules FROM authenticated;

DROP POLICY IF EXISTS audit_redaction_rules_service_policy ON public.audit_redaction_rules;
CREATE POLICY audit_redaction_rules_service_policy
  ON public.audit_redaction_rules
  FOR ALL
  TO service_role
  USING (TRUE)
  WITH CHECK (TRUE);

DROP TRIGGER IF EXISTS trg_audit_redaction_rules_set_updated_at ON public.audit_redaction_rules;
CREATE TRIGGER trg_audit_redaction_rules_set_updated_at
  BEFORE UPDATE ON public.audit_redaction_rules
  FOR EACH ROW
  EXECUTE FUNCTION public.set_updated_at();

-------------------------------------------------------------------------------
-- 2) Helper: audit_redact_row
-------------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.audit_redact_row(
  p_table_schema TEXT,
  p_table_name TEXT,
  p_row JSONB
)
RETURNS JSONB
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path TO public, extensions, pg_temp
AS $function$
DECLARE
  v_mode TEXT;
  v_cols TEXT[];
  v_token TEXT;
  v_out JSONB;
  i INT;
BEGIN
  IF p_row IS NULL THEN
    RETURN NULL;
  END IF;

  SELECT mode, columns, redaction_token
    INTO v_mode, v_cols, v_token
    FROM public.audit_redaction_rules
   WHERE table_schema = COALESCE(NULLIF(btrim(p_table_schema), ''), 'public')
     AND table_name = p_table_name
   LIMIT 1;

  IF NOT FOUND THEN
    RETURN p_row;
  END IF;

  v_cols := COALESCE(v_cols, '{}'::text[]);
  v_token := COALESCE(NULLIF(v_token, ''), '[REDACTED]');

  IF v_mode = 'allowlist' THEN
    SELECT COALESCE(jsonb_object_agg(k, v), '{}'::jsonb)
      INTO v_out
      FROM jsonb_each(p_row) AS e(k, v)
     WHERE k = ANY(v_cols);
    RETURN v_out;
  END IF;

  -- denylist (default)
  v_out := p_row;
  IF array_length(v_cols, 1) IS NULL OR array_length(v_cols, 1) = 0 THEN
    RETURN v_out;
  END IF;

  -- Replace key values with a redaction token (preserves presence without leaking content).
  FOR i IN 1..array_length(v_cols, 1) LOOP
    IF v_cols[i] IS NULL OR btrim(v_cols[i]) = '' THEN
      CONTINUE;
    END IF;
    IF v_out ? v_cols[i] THEN
      v_out := jsonb_set(v_out, ARRAY[v_cols[i]], to_jsonb(v_token), true);
    END IF;
  END LOOP;

  RETURN v_out;
END;
$function$;

COMMENT ON FUNCTION public.audit_redact_row(TEXT, TEXT, JSONB)
  IS 'Apply row-driven redaction rules to a JSONB row snapshot for audit_table_changes.';

-------------------------------------------------------------------------------
-- 3) Apply redaction inside audit_capture_row_change
-------------------------------------------------------------------------------
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
  v_pk_source JSONB := NULL;
  v_pk_cols TEXT[];
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

  -- Build primary key JSON dynamically from the table's declared PK columns.
  -- Falls back to `{id: ...}` when no PK exists but an `id` column is present.
  v_pk_source := COALESCE(v_row_new, v_row_old);
  IF v_pk_source IS NOT NULL THEN
    SELECT array_agg(a.attname ORDER BY array_position(i.indkey, a.attnum))
      INTO v_pk_cols
      FROM pg_catalog.pg_index i
      JOIN pg_catalog.pg_attribute a
        ON a.attrelid = i.indrelid
       AND a.attnum = ANY(i.indkey)
       AND a.attisdropped = false
     WHERE i.indrelid = TG_RELID
       AND i.indisprimary;

    IF v_pk_cols IS NOT NULL AND array_length(v_pk_cols, 1) > 0 THEN
      SELECT jsonb_object_agg(k, v_pk_source -> k)
        INTO v_pk
        FROM unnest(v_pk_cols) AS k;
    END IF;

    IF v_pk IS NULL AND v_pk_source ? 'id' THEN
      v_pk := jsonb_build_object('id', v_pk_source->'id');
    END IF;
  END IF;

  IF v_row_new ? 'organization_id' THEN
    v_org := NULLIF(v_row_new->>'organization_id','')::uuid;
  ELSIF v_row_old ? 'organization_id' THEN
    v_org := NULLIF(v_row_old->>'organization_id','')::uuid;
  END IF;

  -- Apply row-driven redaction to stored snapshots (never affects PK extraction above).
  v_row_old := public.audit_redact_row(TG_TABLE_SCHEMA, TG_TABLE_NAME, v_row_old);
  v_row_new := public.audit_redact_row(TG_TABLE_SCHEMA, TG_TABLE_NAME, v_row_new);

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

  IF v_row_new ? 'correlation_id' AND v_row_new->>'correlation_id' <> '' THEN
    v_corr := NULLIF(v_row_new->>'correlation_id','')::uuid;
  ELSIF v_row_old ? 'correlation_id' AND v_row_old->>'correlation_id' <> '' THEN
    v_corr := NULLIF(v_row_old->>'correlation_id','')::uuid;
  ELSE
    v_corr := public.current_correlation_id();
  END IF;

  v_org := COALESCE(v_org, '00000000-0000-0000-0000-000000000000'::uuid);

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
  IS 'Row-level audit trigger: captures old/new, actor, org (coalesced to uuid_nil), correlation_id into audit_table_changes (dynamic PK extraction + row-driven redaction).';

COMMIT;
