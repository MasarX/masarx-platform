BEGIN;
SET LOCAL search_path TO pg_catalog;
SET LOCAL lock_timeout = '10s';

-- Patch the current catalog definition, preserving its owner and ACL.
DO $partition_write_plan$
DECLARE
  planner CONSTANT regprocedure := 'public.ui_rpc_executor_privilege_plan_v1()'::regprocedure;
  before_hash CONSTANT text := '98b2df1a98d7cdb61acaab6a4e0027ab8e87411d8e0252fadba7a79029a8d2e0';
  after_hash CONSTANT text := '2d4f4d8da4478c2b0b3ae9b48925d00c145775f53a0df7b8298f081f4bb4efbf';
  before_seam CONSTANT text := $before$    SELECT operation,c.oid,'relation',c.oid FROM pg_class c
      CROSS JOIN (VALUES ('INSERT'),('UPDATE'),('DELETE')) op(operation)$before$;
  after_seam CONSTANT text := $after$    -- Keep historical SELECT grants on partitions reached by routed writes.
    SELECT operation,c.oid,'relation',c.oid FROM pg_class c
      CROSS JOIN (VALUES ('INSERT'),('UPDATE'),('DELETE')) op(operation)
     WHERE NOT c.relispartition OR EXISTS (
       SELECT 1 FROM aclexplode(c.relacl) acl
       WHERE acl.grantee='ui_rpc_executor'::regrole AND acl.privilege_type='SELECT')
    UNION
    -- Direct writes still require the named relation, even without an existing grant.
    SELECT 'function',parent,'relation',child FROM function_write_edges$after$;
  definition text;
  body_hash text;
BEGIN
  SELECT encode(sha256(convert_to(replace(prosrc, E'\r\n', E'\n'), 'UTF8')), 'hex')
    INTO body_hash FROM pg_proc
    WHERE oid = planner AND proowner = current_user::regrole::oid AND prosecdef
      AND provolatile = 's' AND proconfig = ARRAY['search_path=public, extensions, pg_temp'];

  -- DEV can install the same definition before the closure records it.
  IF body_hash IS DISTINCT FROM after_hash THEN
    definition := replace(pg_get_functiondef(planner), E'\r\n', E'\n');
    IF body_hash IS DISTINCT FROM before_hash
      OR length(definition) - length(replace(definition, before_seam, '')) IS DISTINCT FROM length(before_seam) THEN
      RAISE EXCEPTION 'Unrecognized executor privilege planner definition';
    END IF;

    EXECUTE replace(definition, before_seam, after_seam);
  END IF;

  -- Both the predecessor and closure receipts must match the corrected plan at their own epoch.
  IF (SELECT jsonb_agg(to_jsonb(p) ORDER BY object_kind, object_id, privilege, column_name)
      FROM public.ui_rpc_executor_privilege_plan_v1() p)
    IS DISTINCT FROM (SELECT value FROM public.marketplace_review_readback_state_v1 WHERE key = 'plan_after') THEN
    RAISE EXCEPTION 'Corrected executor plan does not match the current sealed receipt';
  END IF;
END;
$partition_write_plan$;
COMMIT;
