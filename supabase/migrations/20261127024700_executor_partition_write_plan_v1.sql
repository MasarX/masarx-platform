BEGIN;
SET LOCAL search_path TO pg_catalog;
SET LOCAL lock_timeout = '10s';

-- Patch the current catalog definition, preserving its owner and ACL.
DO $partition_write_plan$
DECLARE
  planner CONSTANT regprocedure := 'public.ui_rpc_executor_privilege_plan_v1()'::regprocedure;
  before_hash CONSTANT text := '98b2df1a98d7cdb61acaab6a4e0027ab8e87411d8e0252fadba7a79029a8d2e0';
  after_hash CONSTANT text := '2a3db6bfe90fd023f3b90af5d92ca9ad0dd682cf8f47b85d8823d22a58abadd8';
  before_seam CONSTANT text := $before$    SELECT operation,c.oid,'relation',c.oid FROM pg_class c
      CROSS JOIN (VALUES ('INSERT'),('UPDATE'),('DELETE')) op(operation)$before$;
  after_seam CONSTANT text := $after$    SELECT operation,c.oid,'relation',c.oid FROM pg_class c
      CROSS JOIN (VALUES ('INSERT'),('UPDATE'),('DELETE')) op(operation)
     WHERE NOT c.relispartition OR NOT EXISTS (
       SELECT 1 FROM pg_inherits i JOIN pg_partitioned_table parent ON parent.partrelid=i.inhparent
       WHERE i.inhrelid=c.oid)
    UNION
    -- Direct writes need the relation; routed partition writes only follow triggers.
    SELECT 'function',parent,'relation',child FROM function_write_edges$after$;
  definition text;
  body_hash text;
BEGIN
  SELECT encode(sha256(convert_to(replace(prosrc, E'\r\n', E'\n'), 'UTF8')), 'hex')
    INTO body_hash FROM pg_proc
    WHERE oid = planner AND proowner = current_user::regrole::oid AND prosecdef
      AND provolatile = 's' AND proconfig = ARRAY['search_path=public, extensions, pg_temp'];

  -- A pending closure may have required this same migration SQL before db push.
  IF body_hash = after_hash THEN
    RETURN;
  END IF;

  definition := replace(pg_get_functiondef(planner), E'\r\n', E'\n');
  IF body_hash IS DISTINCT FROM before_hash
    OR length(definition) - length(replace(definition, before_seam, '')) IS DISTINCT FROM length(before_seam) THEN
    RAISE EXCEPTION 'Unrecognized executor privilege planner definition';
  END IF;

  EXECUTE replace(definition, before_seam, after_seam);
END;
$partition_write_plan$;
COMMIT;
