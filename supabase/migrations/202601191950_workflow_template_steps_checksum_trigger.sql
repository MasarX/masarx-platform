-- Migration: Refresh workflow_templates.steps_checksum on step mutations
BEGIN;
SELECT pg_advisory_lock(hashtext('202601191950_workflow_template_steps_checksum_trigger'));
SET search_path TO public, extensions, pg_temp;
SET LOCAL lock_timeout = '30s';

CREATE OR REPLACE FUNCTION public.workflow_template_steps_refresh_checksum_stmt_v1()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO public, extensions, pg_temp
AS $$
DECLARE
  v_new_table TEXT := NULL;
  v_old_table TEXT := NULL;
  v_sql_parts TEXT[] := ARRAY[]::text[];
  v_sql TEXT;
  v_template_id UUID;
BEGIN
  IF TG_NARGS >= 1 THEN
    v_new_table := NULLIF(btrim(TG_ARGV[0]), '');
    IF lower(COALESCE(v_new_table, '')) = 'null' THEN
      v_new_table := NULL;
    END IF;
  END IF;
  IF TG_NARGS >= 2 THEN
    v_old_table := NULLIF(btrim(TG_ARGV[1]), '');
    IF lower(COALESCE(v_old_table, '')) = 'null' THEN
      v_old_table := NULL;
    END IF;
  END IF;

  IF v_new_table IS NOT NULL THEN
    v_sql_parts := array_append(
      v_sql_parts,
      format('SELECT workflow_template_id FROM %I', v_new_table)
    );
  END IF;
  IF v_old_table IS NOT NULL THEN
    v_sql_parts := array_append(
      v_sql_parts,
      format('SELECT workflow_template_id FROM %I', v_old_table)
    );
  END IF;

  IF array_length(v_sql_parts, 1) IS NULL THEN
    RETURN NULL;
  END IF;

  v_sql :=
    'SELECT DISTINCT workflow_template_id FROM (' ||
    array_to_string(v_sql_parts, ' UNION ') ||
    ') AS t WHERE workflow_template_id IS NOT NULL';

  FOR v_template_id IN EXECUTE v_sql LOOP
    PERFORM public.workflow_refresh_steps_checksum(v_template_id);
  END LOOP;

  RETURN NULL;
END;
$$;

DROP TRIGGER IF EXISTS workflow_template_steps_refresh_checksum_insert ON public.workflow_template_steps;
CREATE TRIGGER workflow_template_steps_refresh_checksum_insert
  AFTER INSERT ON public.workflow_template_steps
  REFERENCING NEW TABLE AS new_rows
  FOR EACH STATEMENT
  EXECUTE FUNCTION public.workflow_template_steps_refresh_checksum_stmt_v1('new_rows', NULL);

DROP TRIGGER IF EXISTS workflow_template_steps_refresh_checksum_update ON public.workflow_template_steps;
CREATE TRIGGER workflow_template_steps_refresh_checksum_update
  AFTER UPDATE ON public.workflow_template_steps
  REFERENCING NEW TABLE AS new_rows OLD TABLE AS old_rows
  FOR EACH STATEMENT
  EXECUTE FUNCTION public.workflow_template_steps_refresh_checksum_stmt_v1('new_rows', 'old_rows');

DROP TRIGGER IF EXISTS workflow_template_steps_refresh_checksum_delete ON public.workflow_template_steps;
CREATE TRIGGER workflow_template_steps_refresh_checksum_delete
  AFTER DELETE ON public.workflow_template_steps
  REFERENCING OLD TABLE AS old_rows
  FOR EACH STATEMENT
  EXECUTE FUNCTION public.workflow_template_steps_refresh_checksum_stmt_v1(NULL, 'old_rows');

REVOKE ALL ON FUNCTION public.workflow_template_steps_refresh_checksum_stmt_v1() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.workflow_template_steps_refresh_checksum_stmt_v1() TO authenticated, service_role;

SELECT pg_advisory_unlock(hashtext('202601191950_workflow_template_steps_checksum_trigger'));
COMMIT;
