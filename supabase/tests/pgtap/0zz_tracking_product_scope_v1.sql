BEGIN;
SELECT plan(27);

SELECT has_function(
  'public', 'public_tracking_review_request_v1', ARRAY['jsonb'],
  'public tracking review RPC exists'
);
SELECT ok(
  pg_get_functiondef('public.public_tracking_review_request_v1(jsonb)'::regprocedure)
    LIKE '%public.request_role_is_service_v1()%',
  'tracking review uses the JWT-aware service-role helper'
);
SELECT ok(
  pg_get_functiondef('public.public_tracking_review_request_v1(jsonb)'::regprocedure)
    LIKE '%WHEN v_case.sender_id IS NOT NULL THEN ''sender''%'
  AND pg_get_functiondef('public.public_tracking_review_request_v1(jsonb)'::regprocedure)
    LIKE '%WHEN v_case.client_id IS NOT NULL THEN ''client''%'
  AND pg_get_functiondef('public.public_tracking_review_request_v1(jsonb)'::regprocedure)
    LIKE '%public.workflow_template_scope_allowed(%',
  'tracking review authorizes the deepest sender, client, or tenant scope'
);
SELECT ok(
  pg_get_functiondef('public.public_tracking_review_request_v1(jsonb)'::regprocedure)
    LIKE '%sc.request_source%FOR UPDATE%'
  AND pg_get_functiondef('public.public_tracking_review_request_v1(jsonb)'::regprocedure)
    NOT LIKE '%jsonb_build_object(''code'', ''forbidden'')%',
  'tracking review locks request source and returns generic absence on scope denial'
);
SELECT ok(
  pg_get_functiondef('public.public_tracking_assert_reviewer_v1()'::regprocedure)
    LIKE '%user_has_resource_capability_v1(''customer_shipment_changes'', ''write'')%',
  'tracking review retains the canonical write capability gate'
);
SELECT ok(
  pg_get_functiondef('public.service_offerings_validate_catalog_context_v1()'::regprocedure)
    LIKE '%zone.is_active IS TRUE%'
  AND pg_get_functiondef('public.service_offerings_validate_catalog_context_v1()'::regprocedure)
    LIKE '%resolve_branch_id_for_zone_at(zone.id, public.workflow_now()) = NEW.branch_id%',
  'active offerings require an active zone mapped to the selected branch'
);
SELECT ok(
  pg_get_functiondef('public.resolve_service_offering_context_v1(uuid,uuid)'::regprocedure)
    LIKE '%zone.is_active IS TRUE%'
  AND pg_get_functiondef('public.resolve_service_offering_context_v1(uuid,uuid)'::regprocedure)
    LIKE '%resolve_branch_id_for_zone_at(zone.id, public.workflow_now()) = branch.id%'
  AND pg_get_functiondef('public.resolve_service_offering_context_v1(uuid,uuid)'::regprocedure)
    LIKE '%workflow_now() >= so.effective_from%',
  'offering resolution requires current active and effective branch-zone truth'
);
SELECT ok(
  pg_get_triggerdef((
    SELECT oid FROM pg_trigger
     WHERE tgrelid = 'public.shipments'::regclass
       AND tgname = 'trg_00_shipments_apply_service_offering_context_v1'
       AND NOT tgisinternal
  )) LIKE '%UPDATE OF%'
  AND pg_get_triggerdef((SELECT oid FROM pg_trigger WHERE tgrelid = 'public.shipments'::regclass AND tgname = 'trg_00_shipments_apply_service_offering_context_v1')) LIKE '%organization_id%'
  AND pg_get_triggerdef((SELECT oid FROM pg_trigger WHERE tgrelid = 'public.shipments'::regclass AND tgname = 'trg_00_shipments_apply_service_offering_context_v1')) LIKE '%metadata%'
  AND pg_get_triggerdef((SELECT oid FROM pg_trigger WHERE tgrelid = 'public.shipments'::regclass AND tgname = 'trg_00_shipments_apply_service_offering_context_v1')) LIKE '%service_level%'
  AND pg_get_triggerdef((SELECT oid FROM pg_trigger WHERE tgrelid = 'public.shipments'::regclass AND tgname = 'trg_00_shipments_apply_service_offering_context_v1')) LIKE '%branch_id%'
  AND pg_get_triggerdef((SELECT oid FROM pg_trigger WHERE tgrelid = 'public.shipments'::regclass AND tgname = 'trg_00_shipments_apply_service_offering_context_v1')) LIKE '%zone_id%',
  'shipment offering projection revalidates every lineage source column'
);
SELECT ok(
  pg_get_functiondef('public.shipments_apply_service_offering_context_v1()'::regprocedure)
    LIKE '%- ''service_offering_branch_id''%'
  AND pg_get_functiondef('public.shipments_apply_service_offering_context_v1()'::regprocedure)
    LIKE '%NEW.zone_id := NULLIF(v_context->>''service_offering_zone_id'', '''')::UUID%',
  'shipment offering projection removes stale metadata and replaces nullable zone lineage'
);
SELECT ok(
  pg_get_viewdef('public.service_offering_directory'::regclass, TRUE)
    LIKE '%resolve_branch_id_for_zone_at(zone.id, workflow_now()) = branch.id%',
  'service offering availability uses current canonical branch-zone membership'
);
SELECT has_view(
  'api', 'service_branch_zone_directory',
  'service branch-zone API directory exists'
);
SELECT ok(
  COALESCE((
    SELECT c.reloptions @> ARRAY['security_invoker=true']
      FROM pg_class c
      JOIN pg_namespace n ON n.oid = c.relnamespace
     WHERE n.nspname = 'api'
       AND c.relname = 'service_branch_zone_directory'
  ), FALSE),
  'service branch-zone API directory is security invoker'
);
SELECT is(
  (SELECT array_agg(column_name::TEXT ORDER BY ordinal_position)
     FROM information_schema.columns
    WHERE table_schema = 'api'
      AND table_name = 'service_branch_zone_directory'),
  ARRAY['id', 'organization_id', 'name', 'branch_id']::TEXT[],
  'service branch-zone directory exposes only minimal columns'
);
SELECT ok(
  NOT has_table_privilege('anon', 'api.service_branch_zone_directory', 'SELECT')
  AND NOT has_table_privilege('authenticated', 'api.service_branch_zone_directory', 'SELECT')
  AND has_table_privilege('service_role', 'api.service_branch_zone_directory', 'SELECT'),
  'service branch-zone directory is reachable only through governed reads'
);
SELECT ok(
  NOT EXISTS (
    SELECT 1
      FROM public.settings s
      JOIN public.settings_versions sv ON sv.id = s.settings_version_id
     WHERE s.category = 'ui_read_registry'
       AND (
         NOT EXISTS (
           SELECT 1
             FROM jsonb_array_elements(COALESCE(sv.value->'resources', '[]'::jsonb)) resource
            WHERE resource->>'key' = 'service_branch_zone_directory'
              AND resource->>'relation' = 'api.service_branch_zone_directory'
         )
         OR NOT EXISTS (
           SELECT 1
             FROM jsonb_array_elements(COALESCE(s.cached_value->'resources', '[]'::jsonb)) resource
            WHERE resource->>'key' = 'service_branch_zone_directory'
              AND resource->>'relation' = 'api.service_branch_zone_directory'
         )
       )
  ),
  'service branch-zone directory is registered in settings and cache pairs'
);
WITH promotion_history AS (
 SELECT * FROM public.settings_versions
  WHERE category='ui_read_registry'
    AND change_reason='Register the governed effective branch-zone service directory'
), current_heads AS (
 SELECT sv.*,s.cached_value FROM public.settings s
  JOIN public.settings_versions sv ON sv.id=s.settings_version_id
    AND sv.category=s.category AND sv.scope_type=s.scope_type AND sv.scope_hash=s.scope_hash
  WHERE s.category='ui_read_registry' AND EXISTS(
   SELECT 1 FROM promotion_history history WHERE history.category=sv.category
     AND history.scope_type=sv.scope_type AND history.scope_hash=sv.scope_hash)
)
SELECT ok(
 EXISTS(SELECT 1 FROM promotion_history)
 AND NOT EXISTS(
  SELECT 1 FROM promotion_history history WHERE NOT EXISTS(
   SELECT 1 FROM current_heads head WHERE head.category=history.category
     AND head.scope_type=history.scope_type AND head.scope_hash=history.scope_hash
     AND head.version>=history.version
     AND (head.id=history.id OR history.effective_until IS NOT NULL)))
 AND NOT EXISTS(
  SELECT 1 FROM current_heads head WHERE head.cached_value IS DISTINCT FROM head.value
   OR head.effective_until IS NOT NULL OR head.version<>(
    SELECT MAX(candidate.version) FROM public.settings_versions candidate
     WHERE candidate.category=head.category AND candidate.scope_type=head.scope_type
       AND candidate.scope_hash=head.scope_hash)
   OR NOT EXISTS(
    SELECT 1 FROM public.settings_versions prior WHERE prior.category=head.category
      AND prior.scope_type=head.scope_type AND prior.scope_hash=head.scope_hash
      AND prior.version<head.version AND prior.effective_until IS NOT NULL
      AND prior.schema_version=head.schema_version))
 AND NOT EXISTS(
  SELECT 1 FROM promotion_history history WHERE NOT EXISTS(
   SELECT 1 FROM public.settings_versions prior WHERE prior.category=history.category
     AND prior.scope_type=history.scope_type AND prior.scope_hash=history.scope_hash
     AND prior.version<history.version AND prior.effective_until IS NOT NULL
     AND prior.schema_version=history.schema_version)),
  'branch-zone registry promotion retains a closed predecessor and current pointer/cache/version parity'
);
SELECT ok(
  EXISTS (SELECT 1 FROM public.settings WHERE category = 'ui_read_registry')
  AND NOT EXISTS (
    SELECT 1 FROM public.settings s
    LEFT JOIN public.settings_versions sv ON sv.id = s.settings_version_id
     WHERE s.category = 'ui_read_registry'
       AND (
         sv.id IS NULL OR sv.category IS DISTINCT FROM s.category
         OR sv.scope_type IS DISTINCT FROM s.scope_type OR sv.scope_hash IS DISTINCT FROM s.scope_hash
         OR s.cached_value IS DISTINCT FROM sv.value OR sv.effective_until IS NOT NULL
         OR sv.version <> (
           SELECT MAX(candidate.version) FROM public.settings_versions candidate
            WHERE candidate.category = sv.category AND candidate.scope_type = sv.scope_type
              AND candidate.scope_hash = sv.scope_hash
         )
         OR (sv.version > 1 AND NOT EXISTS (
           SELECT 1 FROM public.settings_versions prior
            WHERE prior.category = sv.category AND prior.scope_type = sv.scope_type
              AND prior.scope_hash = sv.scope_hash AND prior.version < sv.version
              AND prior.effective_until IS NOT NULL AND prior.schema_version = sv.schema_version
         ))
         OR EXISTS (
           SELECT 1 FROM public.settings_versions prior
            WHERE prior.category = sv.category AND prior.scope_type = sv.scope_type
              AND prior.scope_hash = sv.scope_hash AND prior.version < sv.version
              AND prior.approved_at IS NOT NULL AND prior.effective_until IS NULL
         )
       )
  ),
  'every current registry pointer retains cache/max-version/open-window parity and closed predecessors'
);

CREATE OR REPLACE FUNCTION pg_temp.capture_tracking_product_sqlstate(p_sql TEXT)
RETURNS TEXT
LANGUAGE plpgsql
AS $function$
BEGIN
  EXECUTE p_sql;
  RETURN NULL;
EXCEPTION WHEN others THEN
  RETURN SQLSTATE;
END;
$function$;

DO $fixture$
DECLARE
  v_org UUID := gen_random_uuid();
  v_foreign_org UUID := gen_random_uuid();
  v_client UUID := gen_random_uuid();
  v_user UUID := gen_random_uuid();
  v_branch_one UUID := gen_random_uuid();
  v_branch_two UUID := gen_random_uuid();
  v_foreign_branch UUID := gen_random_uuid();
  v_zone_one UUID := gen_random_uuid();
  v_zone_two UUID := gen_random_uuid();
  v_inactive_zone UUID := gen_random_uuid();
  v_foreign_zone UUID := gen_random_uuid();
  v_level UUID := gen_random_uuid();
  v_offering_one UUID := gen_random_uuid();
  v_offering_two UUID := gen_random_uuid();
BEGIN
  INSERT INTO public.organizations (id, name, slug)
  VALUES
    (v_org, 'Tracking product scope', 'tracking-product-' || substr(v_org::TEXT, 1, 8)),
    (v_foreign_org, 'Tracking product foreign', 'tracking-product-foreign-' || substr(v_foreign_org::TEXT, 1, 8));

  INSERT INTO public.clients (id, organization_id, name, slug)
  VALUES (v_client, v_org, 'Tracking product client', 'tracking-product-client-' || substr(v_client::TEXT, 1, 8));
  INSERT INTO public.users (
    id, organization_id, email, full_name, access_scope_type, access_scope_id
  ) VALUES (
    v_user, v_org, 'tracking-product-' || substr(v_user::TEXT, 1, 8) || '@example.com',
    'Tracking Product Client User', 'client', v_client
  );

  INSERT INTO public.branches (id, organization_id, code, name, is_active)
  VALUES
    (v_branch_one, v_org, 'tracking-one', 'Tracking Branch One', TRUE),
    (v_branch_two, v_org, 'tracking-two', 'Tracking Branch Two', TRUE),
    (v_foreign_branch, v_foreign_org, 'tracking-foreign', 'Tracking Foreign Branch', TRUE);
  INSERT INTO public.zones (id, organization_id, name, slug, is_active)
  VALUES
    (v_zone_one, v_org, 'Tracking Zone One', 'tracking-zone-one', TRUE),
    (v_zone_two, v_org, 'Tracking Zone Two', 'tracking-zone-two', TRUE),
    (v_inactive_zone, v_org, 'Tracking Zone Inactive', 'tracking-zone-inactive', FALSE),
    (v_foreign_zone, v_foreign_org, 'Tracking Zone Foreign', 'tracking-zone-foreign', TRUE);
  INSERT INTO public.branch_zones (branch_id, zone_id)
  VALUES
    (v_branch_one, v_zone_one),
    (v_branch_two, v_zone_two),
    (v_branch_one, v_inactive_zone),
    (v_foreign_branch, v_foreign_zone);

  INSERT INTO public.service_levels (id, organization_id, key, name, is_active)
  VALUES (v_level, v_org, 'standard', 'Tracking Standard', TRUE);
  INSERT INTO public.service_offerings (
    id, service_level_id, branch_id, zone_id, is_active, metadata
  ) VALUES
    (v_offering_one, v_level, v_branch_one, v_zone_one, TRUE, '{"display":{"name":"One"}}'::jsonb),
    (v_offering_two, v_level, v_branch_two, v_zone_two, TRUE, '{"display":{"name":"Two"}}'::jsonb);

  PERFORM set_config('test.tracking_product_org', v_org::TEXT, TRUE);
  PERFORM set_config('test.tracking_product_user', v_user::TEXT, TRUE);
  PERFORM set_config('test.tracking_product_level', v_level::TEXT, TRUE);
  PERFORM set_config('test.tracking_product_branch_one', v_branch_one::TEXT, TRUE);
  PERFORM set_config('test.tracking_product_branch_two', v_branch_two::TEXT, TRUE);
  PERFORM set_config('test.tracking_product_zone_one', v_zone_one::TEXT, TRUE);
  PERFORM set_config('test.tracking_product_zone_two', v_zone_two::TEXT, TRUE);
  PERFORM set_config('test.tracking_product_inactive_zone', v_inactive_zone::TEXT, TRUE);
  PERFORM set_config('test.tracking_product_offering_one', v_offering_one::TEXT, TRUE);
  PERFORM set_config('test.tracking_product_offering_two', v_offering_two::TEXT, TRUE);
END;
$fixture$;

SELECT is(
  pg_temp.capture_tracking_product_sqlstate(format(
    'INSERT INTO public.service_offerings (service_level_id, branch_id, zone_id, is_active) VALUES (%L::uuid, %L::uuid, %L::uuid, TRUE)',
    current_setting('test.tracking_product_level'),
    current_setting('test.tracking_product_branch_two'),
    current_setting('test.tracking_product_zone_one')
  )),
  '23514',
  'active offering rejects a zone currently mapped to another branch'
);
SELECT is(
  pg_temp.capture_tracking_product_sqlstate(format(
    'INSERT INTO public.service_offerings (service_level_id, branch_id, zone_id, is_active) VALUES (%L::uuid, %L::uuid, %L::uuid, TRUE)',
    current_setting('test.tracking_product_level'),
    current_setting('test.tracking_product_branch_one'),
    current_setting('test.tracking_product_inactive_zone')
  )),
  '23514',
  'active offering rejects an inactive zone'
);
SELECT is(
  public.resolve_service_offering_context_v1(
    current_setting('test.tracking_product_org')::UUID,
    current_setting('test.tracking_product_offering_one')::UUID
  )->>'service_offering_branch_id',
  current_setting('test.tracking_product_branch_one'),
  'resolver returns the currently mapped active branch'
);

CREATE TEMP TABLE shipment_offering_projection_probe (
  organization_id UUID,
  metadata JSONB,
  service_level TEXT,
  branch_id UUID,
  zone_id UUID
) ON COMMIT DROP;
CREATE TRIGGER trg_shipment_offering_projection_probe
  BEFORE INSERT OR UPDATE OF organization_id, metadata, service_level, branch_id, zone_id
  ON shipment_offering_projection_probe
  FOR EACH ROW
  EXECUTE FUNCTION public.shipments_apply_service_offering_context_v1();

SELECT lives_ok(
  format(
    'INSERT INTO shipment_offering_projection_probe (organization_id, metadata) VALUES (%L::uuid, jsonb_build_object(''service_offering_id'', %L))',
    current_setting('test.tracking_product_org'),
    current_setting('test.tracking_product_offering_one')
  ),
  'shipment projection accepts a valid current offering'
);
SELECT ok(
  EXISTS (
    SELECT 1 FROM shipment_offering_projection_probe
     WHERE service_level = 'standard'
       AND branch_id = current_setting('test.tracking_product_branch_one')::UUID
       AND zone_id = current_setting('test.tracking_product_zone_one')::UUID
       AND metadata->>'service_offering_branch_id' = current_setting('test.tracking_product_branch_one')
  ),
  'shipment projection writes the canonical offering lineage'
);
SELECT lives_ok(
  format(
    'UPDATE shipment_offering_projection_probe SET metadata = jsonb_build_object(''service_offering_id'', %L)',
    current_setting('test.tracking_product_offering_two')
  ),
  'shipment projection accepts replacement with another valid offering'
);
SELECT ok(
  EXISTS (
    SELECT 1 FROM shipment_offering_projection_probe
     WHERE branch_id = current_setting('test.tracking_product_branch_two')::UUID
       AND zone_id = current_setting('test.tracking_product_zone_two')::UUID
       AND metadata->>'service_offering_branch_id' = current_setting('test.tracking_product_branch_two')
       AND metadata->>'service_offering_zone_id' = current_setting('test.tracking_product_zone_two')
  ),
  'shipment projection replaces all prior derived lineage'
);
SELECT lives_ok(
  'UPDATE shipment_offering_projection_probe SET metadata = metadata - ''service_offering_id''',
  'shipment projection accepts offering removal'
);
SELECT ok(
  EXISTS (
    SELECT 1 FROM shipment_offering_projection_probe
     WHERE service_level IS NULL
       AND branch_id IS NULL
       AND zone_id IS NULL
       AND NOT (metadata ?| ARRAY[
         'service_level_key', 'service_offering_branch_id', 'service_offering_zone_id'
       ])
  ),
  'shipment projection clears only stale derived lineage after offering removal'
);

SELECT set_config('request.jwt.claim.role', 'authenticated', TRUE);
SELECT set_config('request.jwt.claim.sub', current_setting('test.tracking_product_user'), TRUE);
SELECT set_config(
  'request.jwt.claims',
  jsonb_build_object(
    'role', 'authenticated',
    'sub', current_setting('test.tracking_product_user')
  )::TEXT,
  TRUE
);
SELECT ok(
  EXISTS (
    SELECT 1 FROM api.service_branch_zone_directory
     WHERE organization_id = current_setting('test.tracking_product_org')::UUID
  )
  AND NOT EXISTS (
    SELECT 1 FROM api.service_branch_zone_directory
     WHERE organization_id <> current_setting('test.tracking_product_org')::UUID
  ),
  'client-scoped JWT reads only its own organization branch-zone directory'
);
SELECT set_config('request.jwt.claim.role', '', TRUE);
SELECT set_config('request.jwt.claim.sub', '', TRUE);
SELECT set_config('request.jwt.claims', '', TRUE);

SELECT * FROM finish();
ROLLBACK;
