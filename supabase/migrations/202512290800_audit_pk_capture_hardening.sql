-- Migration: Audit trigger PK capture hardening (dynamic PK extraction)
-- Date: 2025-12-29
BEGIN;

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
  IS 'Row-level audit trigger: captures old/new, actor, org (coalesced to uuid_nil), correlation_id into audit_table_changes (dynamic PK extraction).';

COMMIT;

