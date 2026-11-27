BEGIN;
SET LOCAL search_path TO public, pgtap, extensions, pg_temp;
CREATE EXTENSION IF NOT EXISTS pgtap;

SELECT plan(13);

WITH fixture AS (SELECT gen_random_uuid() AS organization_id)
SELECT ok(
  public.is_organization_storage_key_v1(
    fixture.organization_id,
    fixture.organization_id::text || '/evidence/image-1.png'
  ),
  'accepts a canonical organization storage key'
) FROM fixture;
WITH fixture AS (SELECT gen_random_uuid() AS organization_id)
SELECT ok(
  NOT EXISTS (
    SELECT 1
    FROM unnest(ARRAY['./object', '../object', '/object', 'report space.pdf', E'report\\file.pdf', E'report\n.pdf']) AS invalid(suffix)
    WHERE public.is_organization_storage_key_v1(
      fixture.organization_id,
      fixture.organization_id::text || '/' || invalid.suffix
    )
  ),
  'rejects noncanonical write keys'
) FROM fixture;

SELECT ok(
  strpos(pg_get_functiondef('public.tabular_import_prepare_base_v1(jsonb)'::regprocedure),
    $needle$v_scope_resolution JSONB := public.ui_resolve_import_scope_context_v1(v_payload);$needle$) > 0
  AND strpos(pg_get_functiondef('public.tabular_import_prepare_base_v1(jsonb)'::regprocedure),
    $needle$v_org_id UUID := public.mapping_studio_try_uuid_v1(v_scope_resolution->>'organization_id');$needle$) > 0,
  'import preparation retains resolved tenant authority'
);
SELECT ok(
  strpos(pg_get_functiondef('public.tabular_import_prepare_base_v1(jsonb)'::regprocedure),
    $needle$public.ui_tabular_import_profiles_v1(v_resource_key, COALESCE(v_payload->'scope_context', '{}'::jsonb))$needle$) > 0,
  'import preparation retains scoped profile resolution'
);
SELECT ok(
  strpos(pg_get_functiondef('public.ui_get_workflow_run_output_status_v1(uuid,text[])'::regprocedure),
    $needle$IF COALESCE(v_run.workflow_status, '') IN ('failed', 'cancelled') THEN
    v_terminal := TRUE;
    v_phase := 'failed';
    v_output_url := NULL;
    v_output_file_path := NULL;$needle$) > 0,
  'workflow output retains terminal failure admission'
);
SELECT ok(
  strpos(pg_get_functiondef('public.ui_get_workflow_run_output_status_v1(uuid,text[])'::regprocedure),
    $needle$v_execute_async_response := jsonb_set(v_execute_async_response, '{body}', v_execute_async_body);$needle$) > 0,
  'workflow output retains renderer execute HTTP failure handling'
);
SELECT ok(
  strpos(pg_get_functiondef('public.ui_get_workflow_run_output_status_v1(uuid,text[])'::regprocedure),
    $needle$v_async_response := jsonb_set(v_async_response, '{body}', v_async_body);$needle$) > 0,
  'workflow output retains renderer bundle HTTP failure handling'
);
SELECT ok(
  strpos(pg_get_functiondef('public.register_self_kyc_artifact_v1(jsonb)'::regprocedure),
    $needle$public.is_organization_storage_key_v1(v_org,p_artifact->>'storage_key')$needle$) > 0
  AND strpos(pg_get_functiondef('public.register_self_kyc_artifact_v1(jsonb)'::regprocedure),
    $needle$public.assert_self_kyc_object_v1(p_artifact->>'storage_bucket',p_artifact->>'storage_key')$needle$) > 0,
  'FieldOps self-registration checks both the key and object ownership'
);

CREATE FUNCTION pg_temp.exercise_storage_key_boundaries()
RETURNS SETOF TEXT
LANGUAGE plpgsql
AS $test$
DECLARE
  v_org UUID := gen_random_uuid();
  v_other_org UUID := gen_random_uuid();
  v_client UUID := gen_random_uuid();
  v_sender UUID := gen_random_uuid();
  v_driver UUID := gen_random_uuid();
  v_ops UUID := gen_random_uuid();
  v_artifact UUID := gen_random_uuid();
  v_shipment UUID := gen_random_uuid();
  v_step public.workflow_run_steps;
  v_run public.workflow_runs;
  v_response public.workflow_handler_response;
  v_valid_key TEXT := v_org::text || '/attachments/example.pdf';
  v_foreign_key TEXT := v_other_org::text || '/attachments/example.pdf';
BEGIN
  INSERT INTO public.organizations (id, name, slug) VALUES
    (v_org, 'Storage fixture', 'storage-fixture-' || v_org::text),
    (v_other_org, 'Other storage fixture', 'storage-fixture-' || v_other_org::text);
  INSERT INTO public.users (id, organization_id, email, full_name, user_type, status, access_scope_type)
  VALUES
    (v_driver, v_org, v_driver::text || '@example.test', 'Storage driver', 'driver', 'active', 'tenant'),
    (v_ops, v_org, v_ops::text || '@example.test', 'Storage operator', 'ops_admin', 'active', 'tenant');
  PERFORM public.provision_rbac_roles_from_templates_v1(v_org, ARRAY['driver'], v_driver);
  INSERT INTO public.rbac_user_role_assignments (organization_id, user_id, role_id, assigned_by_user_id)
  SELECT v_org, v_driver, id, v_driver FROM public.rbac_roles WHERE organization_id = v_org AND key = 'driver'
  ON CONFLICT DO NOTHING;
  INSERT INTO public.clients (id, organization_id, name, slug, sla_tier, status)
  VALUES (v_client, v_org, 'Storage fixture', 'storage-fixture-' || v_client::text, 'standard', 'active');
  INSERT INTO public.senders (id, client_id, name, brand_name, auto_provisioned, status)
  VALUES (v_sender, v_client, 'Storage fixture', 'Storage fixture', TRUE, 'active');
  INSERT INTO public.shipments (id, organization_id, client_id, sender_id, service_type, tracking_number, status)
  VALUES (v_shipment, v_org, v_client, v_sender, 'delivery', 'STORAGEFIXTURE' || left(v_shipment::text, 8), 'pending');
  INSERT INTO public.artifacts (id, organization_id, storage_bucket, storage_key)
  VALUES (v_artifact, v_other_org, 'tabular-imports', v_foreign_key);

  v_run.context := jsonb_build_object(
    'organization_id', v_org, 'client_id', v_client, 'shipment_id', v_shipment,
    'attachments', jsonb_build_array(
      jsonb_build_object('storage_bucket', 'fieldops-evidence', 'storage_key', v_valid_key),
      jsonb_build_object('storage_bucket', 'fieldops-evidence', 'storage_key', v_foreign_key)
    )
  );
  v_response := workflow_handlers.execute_shipment_update_attachment_v1(v_step, v_run);
  RETURN NEXT is(v_response.last_error, 'attachment_storage_reference_invalid', 'attachment ingest rejects an out-of-scope key');
  RETURN NEXT ok(
    NOT EXISTS (
      SELECT 1 FROM public.artifacts
      WHERE organization_id = v_org AND storage_key IN (v_valid_key, v_foreign_key)
    ),
    'a rejected attachment batch writes no artifact references'
  );
  v_run.context := jsonb_set(v_run.context, '{attachments}', jsonb_build_array(
    jsonb_build_object('content_url', 'https://example.test/fixture.pdf', 'mime_type', 'application/pdf')
  ));
  v_response := workflow_handlers.execute_shipment_update_attachment_v1(v_step, v_run);
  RETURN NEXT is(v_response.operation_result->>'artifact_count', '1', 'external attachment URLs retain their reference contract');

  PERFORM set_config('request.jwt.claim.sub', v_driver::text, true);
  PERFORM set_config('request.jwt.claim.role', 'authenticated', true);
  PERFORM set_config('request.jwt.claims', jsonb_build_object(
    'sub', v_driver, 'role', 'authenticated', 'organization_id', v_org, 'access_scope_type', 'tenant'
  )::text, true);
  EXECUTE 'SET LOCAL ROLE authenticated';
  RETURN NEXT throws_ok(
    format('SELECT api.register_mobile_artifact_v1(%L::jsonb)', jsonb_build_object(
      'storage_bucket', 'fieldops-evidence', 'storage_key', v_org::text || '/evidence/./image.png'
    )),
    '42501', 'register_mobile_artifact_v1 storage_key must be a canonical current-organization key',
    'FieldOps mobile registration rejects a noncanonical key'
  );

  PERFORM set_config('request.jwt.claim.sub', v_ops::text, true);
  PERFORM set_config('request.jwt.claims', jsonb_build_object(
    'sub', v_ops, 'role', 'authenticated', 'organization_id', v_org, 'access_scope_type', 'tenant'
  )::text, true);
  RETURN NEXT throws_ok(
    format('SELECT api.tabular_import_prepare_v1(%L::jsonb)', jsonb_build_object(
      'resource_key', 'shipments', 'write_mode', 'create', 'rule_source', 'manual',
      'scope_context', jsonb_build_object('tenant', v_org),
      'headers', jsonb_build_array('tracking_number'),
      'rows', jsonb_build_array(jsonb_build_object('tracking_number', 'storage-fixture')),
      'source_artifact_id', v_artifact
    )),
    '42501', 'tabular_import_prepare_v1 source artifact is unavailable for this organization',
    'import preparation rejects a selected artifact outside the run organization'
  );
  EXECUTE 'RESET ROLE';
END;
$test$;

SELECT * FROM pg_temp.exercise_storage_key_boundaries();
SELECT * FROM finish();
ROLLBACK;
