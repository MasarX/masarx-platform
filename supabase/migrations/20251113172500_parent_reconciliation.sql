-- Parent→Repo Reconciliation: align selected parent-only helpers in repo
-- Safe and idempotent definitions harvested from parent (mhln)

BEGIN;

-- Ensure audit schema exists
CREATE SCHEMA IF NOT EXISTS audit;

-- audit.capture_row_change (SECURITY DEFINER, pinned search_path)
CREATE OR REPLACE FUNCTION audit.capture_row_change()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'extensions', 'pg_temp'
AS $$
DECLARE
  v_pk jsonb := NULL;
  v_old jsonb := NULL;
  v_new jsonb := NULL;
  v_user uuid := NULL;
  v_corr uuid := NULL;
BEGIN
  IF TG_OP IN ('UPDATE','DELETE') THEN
    v_old := to_jsonb(OLD);
  END IF;
  IF TG_OP IN ('INSERT','UPDATE') THEN
    v_new := to_jsonb(NEW);
  END IF;

  IF v_new ? 'id' THEN
    v_pk := jsonb_build_object('id', v_new->'id');
  ELSIF v_old ? 'id' THEN
    v_pk := jsonb_build_object('id', v_old->'id');
  END IF;

  BEGIN
    v_user := auth.uid();
  EXCEPTION WHEN others THEN
    v_user := NULL;
  END;
  v_corr := public.current_correlation_id();

  INSERT INTO audit.table_changes(schema_name, table_name, op, pk, row_old, row_new, changed_by, correlation_id)
  VALUES (TG_TABLE_SCHEMA, TG_TABLE_NAME, TG_OP, v_pk, v_old, v_new, v_user, v_corr);

  IF TG_OP = 'DELETE' THEN
    RETURN OLD;
  ELSE
    RETURN NEW;
  END IF;
END;
$$;

-- public.partition_apply_index_templates (no-op stub from parent)
CREATE OR REPLACE FUNCTION public.partition_apply_index_templates()
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'extensions', 'pg_temp'
AS $$
BEGIN
  RETURN 0;
END;
$$;

-- public.set_updated_at
CREATE OR REPLACE FUNCTION public.set_updated_at()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  NEW.updated_at := now();
  RETURN NEW;
END;
$$;

COMMIT;

