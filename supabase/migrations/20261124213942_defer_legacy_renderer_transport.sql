BEGIN;
SET LOCAL search_path TO pg_catalog, pg_temp;
SET LOCAL lock_timeout = '30s';

DO $transport$
DECLARE
  definition text := pg_get_functiondef('public.get_claimed_edge_job_call_spec_v1(uuid,uuid)'::regprocedure);
  before_transport constant text := $before$    IF v_job.renderer_credential_ref IS NOT NULL THEN
      v_spec := public.resolve_label_renderer_edge_config_v1$before$;
  after_transport constant text := $after$    IF v_job.renderer_credential_ref IS NOT NULL THEN
      -- Only HTTP workers need to declare their transport version. SQL callers retain their contract.
      IF current_setting('request.method', true) = 'POST'
         AND (NULLIF(current_setting('request.headers', true), '')::jsonb->>'x-masarx-renderer-transport')
               IS DISTINCT FROM '1' THEN
        UPDATE public.outbound_calls
        SET status = 'pending_edge',
            scheduled_at = lease_expires_at,
            lease_expires_at = NULL,
            edge_lease_token = NULL
        WHERE id = p_job_id;
        RETURN NULL;
      END IF;

      v_spec := public.resolve_label_renderer_edge_config_v1$after$;
BEGIN
  IF cardinality(string_to_array(definition, before_transport)) <> 2 THEN
    RAISE EXCEPTION 'Expected one renderer spec branch in the leased Edge callable';
  END IF;

  EXECUTE replace(definition, before_transport, after_transport);
END;
$transport$;

COMMIT;
