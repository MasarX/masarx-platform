-- pgTAP: Console V2 create-shipment service offering contract

SET search_path TO public, pgtap, extensions, pg_temp;

BEGIN;
CREATE EXTENSION IF NOT EXISTS pgtap;
SELECT plan(10);

CREATE OR REPLACE FUNCTION pg_temp.exercise_console_v2_create_shipment_service_offering_contract()
RETURNS SETOF TEXT
LANGUAGE plpgsql
AS $function$
DECLARE
  v_org UUID := '00000000-0000-0000-0000-000054200001';
  v_ops UUID := '00000000-0000-0000-0000-000054200002';
  v_client UUID := '00000000-0000-0000-0000-000054200003';
  v_sender UUID := '00000000-0000-0000-0000-000054200004';
  v_recipient UUID := '00000000-0000-0000-0000-000054200005';
  v_archived_offering UUID := '00000000-0000-0000-0000-000054200006';
  v_draft_offering UUID := '00000000-0000-0000-0000-000054200007';
  v_inactive_offering UUID := '00000000-0000-0000-0000-000054200008';
  v_other_org UUID := '00000000-0000-0000-0000-000054200009';
  v_offering UUID;
  v_other_offering UUID;
  v_list JSONB := '{}'::jsonb;
  v_list_rows JSONB := '[]'::jsonb;
  v_dry_result JSONB := '{}'::jsonb;
  v_create_result JSONB := '{}'::jsonb;
  v_created_shipment UUID;
  v_created_run UUID;
  v_reject_error TEXT;
BEGIN
  EXECUTE 'SET LOCAL ROLE postgres';

  INSERT INTO public.organizations (id, name, slug)
  VALUES (v_org, 'Console V2 Create Shipment Offering Org', 'console-v2-create-shipment-offering')
  ON CONFLICT (id) DO NOTHING;

  PERFORM public.bootstrap_tenant_service_catalog_defaults_v1(
    v_org,
    public.resolve_saas_onboarding_policy_v1(),
    'pgtap:console-create-shipment-offering'
  );

  INSERT INTO public.users (id, organization_id, email, full_name, user_type, status, access_scope_type, access_scope_id)
  VALUES (
    v_ops,
    v_org,
    'console-v2-create-shipment-offering@example.test',
    'Console V2 Create Shipment Offering',
    'ops_admin',
    'active',
    'tenant',
    NULL
  )
  ON CONFLICT (id) DO UPDATE
     SET organization_id = EXCLUDED.organization_id,
         user_type = EXCLUDED.user_type,
         status = EXCLUDED.status,
         access_scope_type = EXCLUDED.access_scope_type,
         access_scope_id = EXCLUDED.access_scope_id;

  INSERT INTO public.clients (id, organization_id, name, slug, status)
  VALUES (v_client, v_org, 'Console V2 Offering Client', 'console-v2-offering-client', 'active')
  ON CONFLICT (id) DO NOTHING;

  INSERT INTO public.senders (id, client_id, name, brand_name, status)
  VALUES (v_sender, v_client, 'Console V2 Offering Sender', 'Console V2 Offering Sender', 'active')
  ON CONFLICT (id) DO NOTHING;

  INSERT INTO public.recipients (id, organization_id, client_id, name, phone_number, preferred_language)
  VALUES (v_recipient, v_org, v_client, 'Console V2 Offering Recipient', '+966500000542', 'en')
  ON CONFLICT (id) DO NOTHING;

  SELECT sod.id
    INTO v_offering
    FROM public.v_service_offering_directory sod
   WHERE sod.organization_id = v_org
     AND sod.is_active IS TRUE
     AND sod.is_active_window IS TRUE
     AND sod.is_archived IS FALSE
     AND sod.is_draft IS FALSE
   ORDER BY sod.priority ASC, sod.created_at ASC
   LIMIT 1;

  INSERT INTO public.service_offerings (
    id,
    service_level_id,
    branch_id,
    zone_id,
    effective_from,
    effective_to,
    priority,
    is_active,
    metadata
  )
  SELECT
    v_archived_offering,
    so.service_level_id,
    so.branch_id,
    so.zone_id,
    so.effective_from,
    so.effective_to,
    so.priority,
    TRUE,
    jsonb_set(COALESCE(so.metadata, '{}'::jsonb), '{display,status}', to_jsonb('archived'::text), TRUE)
    FROM public.service_offerings so
   WHERE so.id = v_offering
  ON CONFLICT (id) DO UPDATE
     SET metadata = EXCLUDED.metadata,
         is_active = TRUE;

  INSERT INTO public.service_offerings (
    id,
    service_level_id,
    branch_id,
    zone_id,
    effective_from,
    effective_to,
    priority,
    is_active,
    metadata
  )
  SELECT
    v_draft_offering,
    so.service_level_id,
    so.branch_id,
    so.zone_id,
    so.effective_from,
    so.effective_to,
    so.priority,
    TRUE,
    jsonb_set(COALESCE(so.metadata, '{}'::jsonb), '{display,status}', to_jsonb('draft'::text), TRUE)
    FROM public.service_offerings so
   WHERE so.id = v_offering
  ON CONFLICT (id) DO UPDATE
     SET metadata = EXCLUDED.metadata,
         is_active = TRUE;

  INSERT INTO public.service_offerings (
    id,
    service_level_id,
    branch_id,
    zone_id,
    effective_from,
    effective_to,
    priority,
    is_active,
    metadata
  )
  SELECT
    v_inactive_offering,
    so.service_level_id,
    so.branch_id,
    so.zone_id,
    so.effective_from,
    so.effective_to,
    so.priority,
    FALSE,
    jsonb_set(COALESCE(so.metadata, '{}'::jsonb), '{display,status}', to_jsonb('active'::text), TRUE)
    FROM public.service_offerings so
   WHERE so.id = v_offering
  ON CONFLICT (id) DO UPDATE
     SET metadata = EXCLUDED.metadata,
         is_active = FALSE;

  INSERT INTO public.organizations (id, name, slug)
  VALUES (v_other_org, 'Console V2 Other Offering Org', 'console-v2-other-offering-org')
  ON CONFLICT (id) DO NOTHING;

  PERFORM public.bootstrap_tenant_service_catalog_defaults_v1(
    v_other_org,
    public.resolve_saas_onboarding_policy_v1(),
    'pgtap:console-create-shipment-cross-org'
  );

  SELECT sod.id
    INTO v_other_offering
    FROM public.v_service_offering_directory sod
   WHERE sod.organization_id = v_other_org
     AND sod.is_active IS TRUE
     AND sod.is_active_window IS TRUE
     AND sod.is_archived IS FALSE
     AND sod.is_draft IS FALSE
   ORDER BY sod.priority ASC, sod.created_at ASC
   LIMIT 1;

  RETURN NEXT ok(
    EXISTS (
      SELECT 1
        FROM jsonb_array_elements(public.resolve_settings_merged('ui_read_registry', 'tenant', v_org)->'resources') AS item(value)
       WHERE item.value->>'key' = 'service_offering_directory'
         AND item.value->>'relation' = 'public.v_service_offering_directory'
    ),
    'ui_read_registry registers service_offering_directory for Console V2 live reads'
  );

  RETURN NEXT ok(
    EXISTS (
      SELECT 1
        FROM jsonb_array_elements(public.resolve_settings_merged('ui_read_registry', 'tenant', v_org)->'resources') AS item(value)
       WHERE item.value->>'key' = 'shipment_directory'
         AND item.value->>'relation' = 'public.v_shipment_directory'
    ),
    'ui_read_registry registers shipment_directory for Console V2 live enrichment reads'
  );

  PERFORM set_config('request.jwt.claim.sub', v_ops::text, true);
  PERFORM set_config(
    'request.jwt.claims',
    jsonb_build_object(
      'role', 'authenticated',
      'sub', v_ops::text,
      'organization_id', v_org::text,
      'access_scope_type', 'tenant'
    )::text,
    true
  );
  EXECUTE 'SET LOCAL ROLE authenticated';

  v_list := api.ui_list_resource_v1('service_offering_directory', '{}'::jsonb, 20, 0, NULL::jsonb);
  v_list_rows := COALESCE(v_list->'rows', v_list->'items', '[]'::jsonb);
  RETURN NEXT ok(
    COALESCE(jsonb_array_length(v_list_rows), 0) > 0,
    'authenticated Console V2 can read service_offering_directory through api.ui_list_resource_v1'
  );

  v_reject_error := NULL;
  BEGIN
    PERFORM api.ui_create_shipment_v1(
      v_client,
      v_sender,
      'delivery',
      NULL,
      'PGTAP-OFFERING-ARCHIVED-001',
      NULL,
      'pending',
      jsonb_build_object('service_offering_id', v_archived_offering::text)
    );
  EXCEPTION WHEN OTHERS THEN
    v_reject_error := SQLERRM;
  END;
  RETURN NEXT ok(
    COALESCE(v_reject_error, '') LIKE '%service offering is unavailable%',
    'archived service offering is rejected by the live create contract'
  );

  v_reject_error := NULL;
  BEGIN
    PERFORM api.ui_create_shipment_v1(
      v_client,
      v_sender,
      'delivery',
      NULL,
      'PGTAP-OFFERING-DRAFT-001',
      NULL,
      'pending',
      jsonb_build_object('service_offering_id', v_draft_offering::text)
    );
  EXCEPTION WHEN OTHERS THEN
    v_reject_error := SQLERRM;
  END;
  RETURN NEXT ok(
    COALESCE(v_reject_error, '') LIKE '%service offering is unavailable%',
    'draft service offering is rejected by the live create contract'
  );

  v_reject_error := NULL;
  BEGIN
    PERFORM api.ui_create_shipment_v1(
      v_client,
      v_sender,
      'delivery',
      NULL,
      'PGTAP-OFFERING-INACTIVE-001',
      NULL,
      'pending',
      jsonb_build_object('service_offering_id', v_inactive_offering::text)
    );
  EXCEPTION WHEN OTHERS THEN
    v_reject_error := SQLERRM;
  END;
  RETURN NEXT ok(
    COALESCE(v_reject_error, '') LIKE '%service offering is unavailable%',
    'inactive service offering is rejected by the live create contract'
  );

  v_reject_error := NULL;
  BEGIN
    PERFORM api.ui_create_shipment_v1(
      v_client,
      v_sender,
      'delivery',
      NULL,
      'PGTAP-OFFERING-CROSS-ORG-001',
      NULL,
      'pending',
      jsonb_build_object('service_offering_id', v_other_offering::text)
    );
  EXCEPTION WHEN OTHERS THEN
    v_reject_error := SQLERRM;
  END;
  RETURN NEXT ok(
    COALESCE(v_reject_error, '') LIKE '%service offering is unavailable%',
    'cross-organization service offering is rejected by the live create contract'
  );

  v_dry_result := api.ui_create_shipment_v1(
    v_client,
    v_sender,
    'delivery',
    NULL,
    'PGTAP-OFFERING-DRY-001',
    NULL,
    'pending',
    jsonb_build_object(
      'ui', jsonb_build_object('dry_run', true),
      'service_offering_id', v_offering::text,
      'recipient_id', v_recipient::text,
      'cod_amount', 42,
      'cod_currency', 'SAR'
    )
  );

  EXECUTE 'SET LOCAL ROLE postgres';
  RETURN NEXT ok(
    v_dry_result->>'status' = 'shipment_create_preview'
    AND COALESCE((v_dry_result->>'dry_run')::boolean, FALSE) IS TRUE
    AND NOT EXISTS (
      SELECT 1
        FROM public.shipments s
       WHERE s.client_reference_number = 'PGTAP-OFFERING-DRY-001'
    ),
    'dry-run validates service offering without persisting a shipment'
  );

  PERFORM set_config('request.jwt.claim.sub', v_ops::text, true);
  PERFORM set_config(
    'request.jwt.claims',
    jsonb_build_object(
      'role', 'authenticated',
      'sub', v_ops::text,
      'organization_id', v_org::text,
      'access_scope_type', 'tenant'
    )::text,
    true
  );
  EXECUTE 'SET LOCAL ROLE authenticated';

  v_create_result := api.ui_create_shipment_v1(
    v_client,
    v_sender,
    'delivery',
    NULL,
    'PGTAP-OFFERING-CREATE-001',
    NULL,
    'pending',
    jsonb_build_object(
      'service_offering_id', v_offering::text,
      'recipient_id', v_recipient::text,
      'cod_amount', 84,
      'cod_currency', 'SAR'
    )
  );
  v_created_shipment := NULLIF(v_create_result->>'shipment_id', '')::uuid;
  v_created_run := NULLIF(v_create_result->>'workflow_run_id', '')::uuid;

  EXECUTE 'SET LOCAL ROLE postgres';
  RETURN NEXT ok(
    v_create_result->>'status' = 'shipment_created'
    AND v_created_shipment IS NOT NULL
    AND EXISTS (
      SELECT 1
        FROM public.shipments s
       WHERE s.id = v_created_shipment
         AND s.client_id = v_client
         AND s.service_type = 'delivery'
         AND s.service_type <> v_offering::text
         AND s.recipient_id = v_recipient
         AND s.cod_amount = 84
         AND s.cod_currency = 'SAR'
         AND s.metadata->>'service_offering_id' = v_offering::text
         AND s.metadata->>'recipient_id' = v_recipient::text
         AND EXISTS (
           SELECT 1
             FROM public.service_offerings so
             JOIN public.service_levels sl ON sl.id = so.service_level_id
            WHERE so.id = v_offering
              AND s.branch_id IS NOT DISTINCT FROM so.branch_id
              AND s.zone_id IS NOT DISTINCT FROM so.zone_id
              AND s.service_level = sl.key
         )
    ),
    'create shipment keeps service_type canonical and projects selected offering, recipient, and COD fields'
  );

  RETURN NEXT ok(
    v_created_run IS NOT NULL
    AND EXISTS (
      SELECT 1
        FROM public.workflow_run_steps wrs
       WHERE wrs.workflow_run_id = v_created_run
         AND wrs.handler_key = 'shipment_create'
    ),
    'created shipment workflow records shipment_create handler lineage'
  );
END;
$function$;

SELECT * FROM pg_temp.exercise_console_v2_create_shipment_service_offering_contract();

SELECT * FROM finish();

ROLLBACK;
