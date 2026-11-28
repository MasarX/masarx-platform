BEGIN;
SET LOCAL search_path TO public, extensions, pg_temp;
SELECT no_plan();

\ir ../../../scripts/deploy/hold-renderer-upgrade-jobs.sql

-- Exercise the same trigger with the row shape present before leased renderer jobs exist.
CREATE TEMP TABLE legacy_outbound_shape (status text, scheduled_at timestamptz);
CREATE TRIGGER hold_renderer_upgrade_job_v1
BEFORE INSERT ON legacy_outbound_shape
FOR EACH ROW EXECUTE FUNCTION public.hold_renderer_upgrade_job_v1();
INSERT INTO legacy_outbound_shape VALUES ('pending_edge', now());
SELECT is((SELECT scheduled_at FROM legacy_outbound_shape), now(), 'tagged outbound rows keep their schedule');
DROP TABLE legacy_outbound_shape;

CREATE TEMP TABLE tagged_renderer_fixture AS
SELECT gen_random_uuid() AS org, encode(gen_random_bytes(20), 'hex') AS credential,
       concat('https', '://', 'renderer', '.', 'example', '.', 'test', '/functions/v1/label-renderer') AS endpoint;
INSERT INTO public.organizations (id, name, slug)
SELECT org, 'Tagged renderer fixture', 'tagged-renderer-' || org FROM tagged_renderer_fixture;
SELECT set_config('request.jwt.claims', '{"role":"service_role"}', true);
SELECT set_config('request.jwt.claim.role', 'service_role', true);
SELECT public.upsert_label_provider_settings_v1('global', NULL, jsonb_build_object('version', 1, 'providers',
  jsonb_build_array(jsonb_build_object('name', 'tagged-renderer-fixture', 'invoke_url', endpoint,
    'invoke_secret', credential))), 'Tagged renderer fixture') FROM tagged_renderer_fixture;

CREATE TEMP TABLE tagged_upgrade_receipts AS
SELECT 'render' AS kind, public.invoke_label_renderer(1) AS receipt
UNION ALL
SELECT 'print', public.invoke_label_renderer_print_sync_v1(gen_random_uuid(), gen_random_uuid(),
  jsonb_build_object('organization_id', org, 'execute_dispatch_mode', 'sync_wait')) FROM tagged_renderer_fixture;
SELECT is((SELECT count(*) FROM tagged_upgrade_receipts r JOIN public.outbound_calls o
  ON o.id = (r.receipt->>'edge_job_id')::uuid
  WHERE r.receipt @> '{"status":202,"completed":false}'::jsonb
    AND o.status = 'pending_edge' AND o.scheduled_at = 'infinity'
    AND o.retry_count = 0 AND o.edge_lease_token IS NULL), 2::bigint,
  'the pre-apply holds both original receipts when the leased producer first becomes active');
SELECT is_empty($$SELECT c.job_id FROM api.claim_pending_edge_job_ids_v1(1) c JOIN tagged_upgrade_receipts r
  ON c.job_id = (r.receipt->>'edge_job_id')::uuid$$, 'the tagged batch RPC cannot dispatch a held renderer job');
SELECT throws_ok(format('SELECT api.claim_edge_job_by_id_v1(%L::uuid)', receipt->>'edge_job_id'),
  'P0001', format('claim_edge_job_by_id_v1: outbound call %s is not claimable', receipt->>'edge_job_id'),
  kind || ' cannot be sent by the tagged by-id caller before the transport gate') FROM tagged_upgrade_receipts;

\ir ../../migrations/20261128135200_release_renderer_upgrade_jobs.sql

SELECT set_config('request.method', 'POST', true);
SELECT set_config('request.headers', '{}', true);
CREATE TEMP TABLE tagged_upgrade_old_claims AS
SELECT r.*, c.* FROM tagged_upgrade_receipts r
CROSS JOIN LATERAL api.claim_edge_job_by_id_v1((r.receipt->>'edge_job_id')::uuid) c;
SELECT is(api.get_claimed_edge_job_call_spec_v1(job_id, lease_token), NULL::jsonb,
  kind || ' remains undispatched with the tagged caller after the hold is removed') FROM tagged_upgrade_old_claims;
SELECT ok(o.status = 'pending_edge' AND o.retry_count = 0 AND o.completed_at IS NULL,
  c.kind || ' preserves its attempts and pending state across both schema windows')
FROM tagged_upgrade_old_claims c JOIN public.outbound_calls o ON o.id = c.job_id;

UPDATE public.outbound_calls SET scheduled_at = now() WHERE id IN (SELECT job_id FROM tagged_upgrade_old_claims);
SELECT set_config('request.headers', '{"x-masarx-renderer-transport":"1"}', true);
CREATE TEMP TABLE tagged_upgrade_interrupted_claims AS
SELECT p.kind, p.receipt, c.*
FROM tagged_upgrade_old_claims p CROSS JOIN LATERAL api.claim_edge_job_by_id_v1(p.job_id) c;
SELECT ok(api.get_claimed_edge_job_call_spec_v1(job_id, lease_token) ? 'renderer_credential_ref',
  kind || ' gets the signed dispatch spec before the renderer upload') FROM tagged_upgrade_interrupted_claims;

-- The caller uses the same RPC without the marker after the tagged renderer rejects the request.
SELECT set_config('request.headers', '{}', true);
SELECT is(api.get_claimed_edge_job_call_spec_v1(job_id, lease_token), NULL::jsonb,
  kind || ' defers the original receipt after the interrupted upload') FROM tagged_upgrade_interrupted_claims;
SELECT ok(o.status = 'pending_edge' AND o.retry_count = 0 AND o.completed_at IS NULL AND o.edge_lease_token IS NULL,
  c.kind || ' records no failure or ownership after the signed caller defers')
FROM tagged_upgrade_interrupted_claims c JOIN public.outbound_calls o ON o.id = c.job_id;

UPDATE public.outbound_calls SET scheduled_at = now() WHERE id IN (SELECT job_id FROM tagged_upgrade_interrupted_claims);
SELECT set_config('request.headers', '{"x-masarx-renderer-transport":"1"}', true);
CREATE TEMP TABLE tagged_upgrade_new_claims AS
SELECT p.kind, p.receipt, p.lease_token AS old_token, c.*
FROM tagged_upgrade_interrupted_claims p CROSS JOIN LATERAL api.claim_edge_job_by_id_v1(p.job_id) c;
SELECT ok(lease_token IS DISTINCT FROM old_token
    AND api.get_claimed_edge_job_call_spec_v1(job_id, lease_token) ? 'renderer_credential_ref',
  kind || ' gets a renderer dispatch spec with the compatible caller') FROM tagged_upgrade_new_claims;
SELECT api.mark_claimed_edge_job_success_v1(job_id, lease_token, 200, '{}'::jsonb, '{"ok":true}'::jsonb, 1)
FROM tagged_upgrade_new_claims;
SELECT ok(public.check_async_response((receipt->>'request_id')::bigint)
  @> '{"completed":true,"status":200,"body":{"ok":true}}'::jsonb,
  kind || ' completes through the original receipt') FROM tagged_upgrade_new_claims;
SELECT throws_ok(format('SELECT api.claim_edge_job_by_id_v1(%L::uuid)', job_id),
  'P0001', format('claim_edge_job_by_id_v1: outbound call %s is not claimable', job_id),
  kind || ' cannot be claimed again after success') FROM tagged_upgrade_new_claims;

SELECT * FROM finish();
ROLLBACK;
