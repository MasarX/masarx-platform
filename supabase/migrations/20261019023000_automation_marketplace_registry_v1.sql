-- Marketplace contracts on current versioned settings; no in-place settings history edits.
BEGIN;
SET LOCAL search_path TO public,extensions,pg_temp;
SET LOCAL lock_timeout='10s';
SELECT pg_advisory_xact_lock(hashtext('20261019023000_automation_marketplace_registry_v1'));

-- Availability follows the approved catalogue pointer, not a background-maintained flag.
CREATE VIEW public.automation_asset_installs_read_v1 WITH (security_invoker=TRUE) AS
 SELECT i.id,i.listing_id,i.installed_from_listing_version_id,i.current_listing_version_id,i.organization_id,
  i.asset_kind,i.target_scope_type,i.target_scope_id,i.install_status,i.installed_resource_type,i.installed_resource_id,
  i.forked_at,EXISTS(
   SELECT 1 FROM public.automation_asset_listings l
   JOIN public.automation_asset_listing_versions next_v ON next_v.id=l.latest_listing_version_id AND next_v.listing_id=l.id
   JOIN public.automation_asset_listing_versions current_v ON current_v.id=i.current_listing_version_id
   WHERE l.id=i.listing_id AND l.publication_status='approved' AND next_v.publication_status='approved'
    AND next_v.listing_version_no>current_v.listing_version_no AND i.install_status='installed' AND i.forked_at IS NULL
    AND public.automation_marketplace_can_read_asset_v1(next_v.organization_id,l.owner_scope_type,l.owner_scope_id,next_v.visibility,next_v.publication_status)
  ) AS upgrade_available,i.metadata,i.created_by,i.updated_by,i.created_at,i.updated_at,i.installed_at
 FROM public.automation_asset_installs i;
REVOKE ALL ON public.automation_asset_installs_read_v1 FROM PUBLIC,anon,authenticated,service_role;
GRANT SELECT ON public.automation_asset_installs_read_v1 TO authenticated,service_role;

-- Mirror only the existing safe SELECT surface; lifecycle writes remain RPC-only.
CREATE VIEW api.workflow_template_revisions WITH (security_invoker=TRUE) AS SELECT * FROM public.workflow_template_revisions;
CREATE VIEW api.automation_asset_listings WITH (security_invoker=TRUE) AS SELECT * FROM public.automation_asset_listings;
CREATE VIEW api.automation_asset_listing_versions WITH (security_invoker=TRUE) AS SELECT * FROM public.automation_asset_listing_versions;
CREATE VIEW api.automation_asset_reviews WITH (security_invoker=TRUE) AS SELECT * FROM public.automation_asset_reviews;
CREATE VIEW api.automation_asset_installs WITH (security_invoker=TRUE) AS SELECT * FROM public.automation_asset_installs_read_v1;
CREATE VIEW api.automation_asset_install_variables WITH (security_invoker=TRUE) AS SELECT * FROM public.automation_asset_install_variables;
CREATE VIEW api.automation_asset_install_bindings WITH (security_invoker=TRUE) AS SELECT * FROM public.automation_asset_install_bindings;
REVOKE ALL ON api.workflow_template_revisions,api.automation_asset_listings,api.automation_asset_listing_versions,
 api.automation_asset_reviews,api.automation_asset_installs,api.automation_asset_install_variables,
 api.automation_asset_install_bindings FROM PUBLIC,anon,authenticated,service_role;
GRANT SELECT ON api.workflow_template_revisions,api.automation_asset_listings,api.automation_asset_listing_versions,
 api.automation_asset_reviews,api.automation_asset_installs,api.automation_asset_install_variables,
 api.automation_asset_install_bindings TO authenticated,service_role;

DO $$
DECLARE
  v_current JSONB;
  v_next JSONB;
  v_capabilities JSONB := '[]'::jsonb;
  v_roles JSONB := '[]'::jsonb;
  v_resource_map JSONB := '{}'::jsonb;
  v_updated_roles JSONB := '[]'::jsonb;
  v_entry JSONB;
  v_role_key TEXT;
  v_keys JSONB;
BEGIN
  SELECT sv.value
    INTO v_current
    FROM public.settings s
    JOIN public.settings_versions sv ON sv.id = s.settings_version_id
   WHERE s.category = 'access_control_policy'
     AND s.scope_type = public.get_root_scope_type_key_v1()
     AND s.scope_id IS NULL
   LIMIT 1;

  IF v_current IS NULL THEN
    RAISE EXCEPTION 'access_control_policy global settings missing';
  END IF;

  v_capabilities := COALESCE(v_current->'capabilities', '[]'::jsonb);

  IF NOT EXISTS (
    SELECT 1 FROM jsonb_array_elements(v_capabilities) item WHERE item->>'key' = 'automation_marketplace.read'
  ) THEN
    v_capabilities := v_capabilities || jsonb_build_array(
      jsonb_build_object(
        'key', 'automation_marketplace.read',
        'label', 'Automation marketplace read',
        'category', 'automation',
        'description', 'Read automation marketplace listings, versions, installs, and reviews.'
      )
    );
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM jsonb_array_elements(v_capabilities) item WHERE item->>'key' = 'automation_marketplace.publish'
  ) THEN
    v_capabilities := v_capabilities || jsonb_build_array(
      jsonb_build_object(
        'key', 'automation_marketplace.publish',
        'label', 'Automation marketplace publish',
        'category', 'automation',
        'description', 'Create listings, versions, workflow revisions, and publish tenant-shared/private assets.'
      )
    );
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM jsonb_array_elements(v_capabilities) item WHERE item->>'key' = 'automation_marketplace.review'
  ) THEN
    v_capabilities := v_capabilities || jsonb_build_array(
      jsonb_build_object(
        'key', 'automation_marketplace.review',
        'label', 'Automation marketplace review',
        'category', 'automation',
        'description', 'Review and approve marketplace-public automation assets.'
      )
    );
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM jsonb_array_elements(v_capabilities) item WHERE item->>'key' = 'automation_marketplace.install'
  ) THEN
    v_capabilities := v_capabilities || jsonb_build_array(
      jsonb_build_object(
        'key', 'automation_marketplace.install',
        'label', 'Automation marketplace install',
        'category', 'automation',
        'description', 'Install automation marketplace assets as local copies.'
      )
    );
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM jsonb_array_elements(v_capabilities) item WHERE item->>'key' = 'automation_marketplace.upgrade'
  ) THEN
    v_capabilities := v_capabilities || jsonb_build_array(
      jsonb_build_object(
        'key', 'automation_marketplace.upgrade',
        'label', 'Automation marketplace upgrade',
        'category', 'automation',
        'description', 'Upgrade or fork installed marketplace assets.'
      )
    );
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM jsonb_array_elements(v_capabilities) item WHERE item->>'key' = 'automation_marketplace.manage_connections'
  ) THEN
    v_capabilities := v_capabilities || jsonb_build_array(
      jsonb_build_object(
        'key', 'automation_marketplace.manage_connections',
        'label', 'Automation marketplace manage connections',
        'category', 'automation',
        'description', 'Create, rotate, revoke, and bind installer-owned marketplace connections.'
      )
    );
  END IF;

  v_roles := COALESCE(v_current->'roles', '[]'::jsonb);

  -- Named templates require explicit owner assignment; existing roles are not escalated.
  v_updated_roles:=v_roles;

  IF NOT EXISTS (
    SELECT 1 FROM jsonb_array_elements(v_updated_roles) item WHERE item->>'key' = 'automation_marketplace_publisher'
  ) THEN
    v_updated_roles := v_updated_roles || jsonb_build_array(
      jsonb_build_object(
        'key', 'automation_marketplace_publisher',
        'label', 'Automation Marketplace Publisher',
        'capability_keys', jsonb_build_array(
          'automation_marketplace.read',
          'automation_marketplace.publish'
        )
      )
    );
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM jsonb_array_elements(v_updated_roles) item WHERE item->>'key' = 'automation_marketplace_reviewer'
  ) THEN
    v_updated_roles := v_updated_roles || jsonb_build_array(
      jsonb_build_object(
        'key', 'automation_marketplace_reviewer',
        'label', 'Automation Marketplace Reviewer',
        'capability_keys', jsonb_build_array(
          'automation_marketplace.read',
          'automation_marketplace.review'
        )
      )
    );
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM jsonb_array_elements(v_updated_roles) item WHERE item->>'key' = 'automation_marketplace_installer'
  ) THEN
    v_updated_roles := v_updated_roles || jsonb_build_array(
      jsonb_build_object(
        'key', 'automation_marketplace_installer',
        'label', 'Automation Marketplace Installer',
        'capability_keys', jsonb_build_array(
          'automation_marketplace.read',
          'automation_marketplace.install',
          'automation_marketplace.upgrade',
          'automation_marketplace.manage_connections'
        )
      )
    );
  END IF;

  v_resource_map := COALESCE(v_current->'resource_map', '{}'::jsonb);

  v_resource_map := jsonb_set(
    v_resource_map,
    '{workflow_template_revisions}',
    jsonb_build_object(
      'read', 'automation_marketplace.read',
      'write', 'automation_marketplace.publish'
    ),
    true
  );

  v_resource_map := jsonb_set(
    v_resource_map,
    '{automation_asset_listings}',
    jsonb_build_object(
      'read', 'automation_marketplace.read',
      'write', 'automation_marketplace.publish'
    ),
    true
  );

  v_resource_map := jsonb_set(
    v_resource_map,
    '{automation_asset_listing_versions}',
    jsonb_build_object(
      'read', 'automation_marketplace.read',
      'write', 'automation_marketplace.publish'
    ),
    true
  );

  v_resource_map := jsonb_set(
    v_resource_map,
    '{automation_asset_reviews}',
    jsonb_build_object(
      'read', 'automation_marketplace.read',
      'review', 'automation_marketplace.review'
    ),
    true
  );

  v_resource_map := jsonb_set(
    v_resource_map,
    '{automation_asset_installs}',
    jsonb_build_object(
      'read', 'automation_marketplace.read',
      'install', 'automation_marketplace.install',
      'upgrade', 'automation_marketplace.upgrade'
    ),
    true
  );

  v_resource_map := jsonb_set(
    v_resource_map,
    '{integration_connections}',
    jsonb_build_object(
      'read', 'automation_marketplace.manage_connections',
      'write', 'automation_marketplace.manage_connections'
    ),
    true
  );

  v_next := v_current;
  v_next := jsonb_set(v_next, '{capabilities}', v_capabilities, true);
  v_next := jsonb_set(v_next, '{roles}', v_updated_roles, true);
  v_next := jsonb_set(v_next, '{resource_map}', v_resource_map, true);

  IF v_next IS DISTINCT FROM (SELECT sv.value FROM public.settings s JOIN public.settings_versions sv ON sv.id=s.settings_version_id WHERE s.category='access_control_policy' AND s.scope_type=public.get_root_scope_type_key_v1() AND s.scope_id IS NULL) THEN
    PERFORM public.upsert_settings_value_v1('access_control_policy',public.get_root_scope_type_key_v1(),NULL,v_next,
      (SELECT sv.schema_version FROM public.settings s JOIN public.settings_versions sv ON sv.id=s.settings_version_id WHERE s.category='access_control_policy' AND s.scope_type=public.get_root_scope_type_key_v1() AND s.scope_id IS NULL),
      'Add marketplace capability and explicit role templates');
  END IF;
END $$;


DO $$
DECLARE
  v_current JSONB;
  v_resources JSONB := '[]'::jsonb;
  v_item JSONB;
  v_updated JSONB := '[]'::jsonb;
  v_def JSONB;
  v_defs JSONB;
  v_key TEXT;
  v_found BOOLEAN;
BEGIN
  v_defs := jsonb_build_array(
    jsonb_build_object(
      'key', 'workflow_template_revisions',
      'label', 'Workflow template revisions',
      'relation', 'public.workflow_template_revisions',
      'id_column', 'id',
      'capability_read', 'automation_marketplace.read',
      'capability_write', 'automation_marketplace.publish',
      'select', jsonb_build_array(
        'id','workflow_template_id','organization_id','scope_type','scope_id','revision_no','snapshot','artifact_hash','notes','created_by','created_at'
      ),
      'filters', jsonb_build_array(
        jsonb_build_object('key','workflow_template_id','column','workflow_template_id','op','eq'),
        jsonb_build_object('key','scope_type','column','scope_type','op','eq'),
        jsonb_build_object('key','revision_no','column','revision_no','op','eq')
      ),
      'default_sort', jsonb_build_object('column','created_at','direction','desc')
    ),
    jsonb_build_object(
      'key', 'automation_asset_listings',
      'label', 'Automation marketplace listings',
      'relation', 'public.automation_asset_listings',
      'id_column', 'id',
      'capability_read', 'automation_marketplace.read',
      'capability_write', 'automation_marketplace.publish',
      'select', jsonb_build_array(
        'id','organization_id','owner_scope_type','owner_scope_id','asset_kind','title','summary','visibility','publication_status','latest_listing_version_id','metadata','created_by','updated_by','created_at','updated_at'
      ),
      'filters', jsonb_build_array(
        jsonb_build_object('key','asset_kind','column','asset_kind','op','eq'),
        jsonb_build_object('key','visibility','column','visibility','op','eq'),
        jsonb_build_object('key','publication_status','column','publication_status','op','eq'),
        jsonb_build_object('key','title','column','title','op','ilike')
      ),
      'default_sort', jsonb_build_object('column','updated_at','direction','desc')
    ),
    jsonb_build_object(
      'key', 'automation_asset_listing_versions',
      'label', 'Automation marketplace listing versions',
      'relation', 'public.automation_asset_listing_versions',
      'id_column', 'id',
      'capability_read', 'automation_marketplace.read',
      'capability_write', 'automation_marketplace.publish',
      'select', jsonb_build_array(
        'id','listing_id','organization_id','asset_kind','listing_version_no','visibility','publication_status','source_snapshot_type','source_snapshot_id','manifest','snapshot_payload','docs','compatibility','egress_profile','artifact_hash','created_by','submitted_at','approved_at','approved_by','created_at','updated_at'
      ),
      'filters', jsonb_build_array(
        jsonb_build_object('key','listing_id','column','listing_id','op','eq'),
        jsonb_build_object('key','asset_kind','column','asset_kind','op','eq'),
        jsonb_build_object('key','visibility','column','visibility','op','eq'),
        jsonb_build_object('key','publication_status','column','publication_status','op','eq')
      ),
      'default_sort', jsonb_build_object('column','listing_version_no','direction','desc')
    ),
    jsonb_build_object(
      'key', 'automation_asset_reviews',
      'label', 'Automation marketplace reviews',
      'relation', 'public.automation_asset_reviews',
      'id_column', 'id',
      'capability_read', 'automation_marketplace.read',
      'capability_write', 'automation_marketplace.review',
      'select', jsonb_build_array(
        'id','listing_version_id','organization_id','review_status','submission_notes','reviewer_user_id','decision_notes','automated_checks','evidence','created_by','created_at','reviewed_at','updated_at'
      ),
      'filters', jsonb_build_array(
        jsonb_build_object('key','listing_version_id','column','listing_version_id','op','eq'),
        jsonb_build_object('key','review_status','column','review_status','op','eq')
      ),
      'default_sort', jsonb_build_object('column','created_at','direction','desc')
    ),
    jsonb_build_object(
      'key', 'automation_asset_installs',
      'label', 'Automation marketplace installs',
      'relation', 'public.automation_asset_installs_read_v1',
      'id_column', 'id',
      'capability_read', 'automation_marketplace.read',
      'capability_write', 'automation_marketplace.install',
      'select', jsonb_build_array(
        'id','listing_id','installed_from_listing_version_id','current_listing_version_id','organization_id','asset_kind','target_scope_type','target_scope_id','install_status','installed_resource_type','installed_resource_id','forked_at','upgrade_available','metadata','created_by','updated_by','created_at','updated_at','installed_at'
      ),
      'filters', jsonb_build_array(
        jsonb_build_object('key','listing_id','column','listing_id','op','eq'),
        jsonb_build_object('key','asset_kind','column','asset_kind','op','eq'),
        jsonb_build_object('key','target_scope_type','column','target_scope_type','op','eq'),
        jsonb_build_object('key','install_status','column','install_status','op','eq')
      ),
      'default_sort', jsonb_build_object('column','updated_at','direction','desc')
    ),
    jsonb_build_object(
      'key', 'automation_asset_install_variables',
      'label', 'Automation marketplace install variables',
      'relation', 'public.automation_asset_install_variables',
      'id_column', 'id',
      'capability_read', 'automation_marketplace.read',
      'capability_write', 'automation_marketplace.install',
      'select', jsonb_build_array(
        'id','install_id','variable_key','value','created_by','created_at','updated_at'
      ),
      'filters', jsonb_build_array(
        jsonb_build_object('key','install_id','column','install_id','op','eq'),
        jsonb_build_object('key','variable_key','column','variable_key','op','eq')
      ),
      'default_sort', jsonb_build_object('column','created_at','direction','asc')
    ),
    jsonb_build_object(
      'key', 'automation_asset_install_bindings',
      'label', 'Automation marketplace install bindings',
      'relation', 'public.automation_asset_install_bindings',
      'id_column', 'id',
      'capability_read', 'automation_marketplace.read',
      'capability_write', 'automation_marketplace.install',
      'select', jsonb_build_array(
        'id','install_id','binding_key','binding_type','connection_id','runtime_resource_type','runtime_resource_id','config','created_by','created_at','updated_at'
      ),
      'filters', jsonb_build_array(
        jsonb_build_object('key','install_id','column','install_id','op','eq'),
        jsonb_build_object('key','binding_type','column','binding_type','op','eq'),
        jsonb_build_object('key','connection_id','column','connection_id','op','eq')
      ),
      'default_sort', jsonb_build_object('column','created_at','direction','asc')
    ),
    jsonb_build_object(
      'key', 'integration_connections',
      'label', 'Automation marketplace connections',
      'relation', 'public.integration_connections',
      'id_column', 'id',
      'capability_read', 'automation_marketplace.manage_connections',
      'capability_write', 'automation_marketplace.manage_connections',
      'select', jsonb_build_array(
        'id','organization_id','owner_scope_type','owner_scope_id','provider_id','provider_key','name','auth_type','status','secret_storage_mode','credential_generation','secret_hint','runtime_auth_config_id','config','oauth_metadata','metadata','expires_at','last_tested_at','last_tested_credential_generation','last_used_at','last_rotated_at','revoked_at','created_by','updated_by','created_at','updated_at'
      ),
      'filters', jsonb_build_array(
        jsonb_build_object('key','provider_key','column','provider_key','op','eq'),
        jsonb_build_object('key','auth_type','column','auth_type','op','eq'),
        jsonb_build_object('key','status','column','status','op','eq'),
        jsonb_build_object('key','name','column','name','op','ilike')
      ),
      'default_sort', jsonb_build_object('column','updated_at','direction','desc')
    )
  );

  SELECT sv.value
    INTO v_current
    FROM public.settings s
    JOIN public.settings_versions sv ON sv.id = s.settings_version_id
   WHERE s.category = 'ui_read_registry'
     AND s.scope_type = public.get_root_scope_type_key_v1()
     AND s.scope_id IS NULL
   LIMIT 1;

  IF v_current IS NULL THEN
    RAISE EXCEPTION 'ui_read_registry global settings missing';
  END IF;

  v_resources := COALESCE(v_current->'resources', '[]'::jsonb);

  FOR v_def IN SELECT * FROM jsonb_array_elements(v_defs)
  LOOP
    v_key := v_def->>'key';
    v_found := FALSE;
    v_updated := '[]'::jsonb;

    FOR v_item IN SELECT * FROM jsonb_array_elements(v_resources)
    LOOP
      IF v_item->>'key' = v_key THEN
        v_item := v_def;
        v_found := TRUE;
      END IF;
      v_updated := v_updated || jsonb_build_array(v_item);
    END LOOP;

    IF v_found IS FALSE THEN
      v_updated := v_updated || jsonb_build_array(v_def);
    END IF;

    v_resources := v_updated;
  END LOOP;

  v_current := jsonb_set(v_current, '{resources}', v_resources, true);

  IF v_current IS DISTINCT FROM (SELECT sv.value FROM public.settings s JOIN public.settings_versions sv ON sv.id=s.settings_version_id WHERE s.category='ui_read_registry' AND s.scope_type=public.get_root_scope_type_key_v1() AND s.scope_id IS NULL) THEN
    PERFORM public.upsert_settings_value_v1('ui_read_registry',public.get_root_scope_type_key_v1(),NULL,v_current,
      (SELECT sv.schema_version FROM public.settings s JOIN public.settings_versions sv ON sv.id=s.settings_version_id WHERE s.category='ui_read_registry' AND s.scope_type=public.get_root_scope_type_key_v1() AND s.scope_id IS NULL),
      'Register marketplace read resources');
  END IF;
END $$;



-------------------------------------------------------------------------------
-- 2) ui_navigation entries
-------------------------------------------------------------------------------

DO $$
DECLARE
  v_current JSONB;
  v_console_sections JSONB := '[]'::jsonb;
  v_section JSONB;
  v_items JSONB;
  v_found BOOLEAN := FALSE;
  v_section_item JSONB := jsonb_build_object(
    'id', 'automation-marketplace',
    'label', 'Marketplace',
    'href', '/console/automation/marketplace',
    'resource', 'automation_asset_listings',
    'capability', 'automation_marketplace.read'
  );
  v_installs_item JSONB := jsonb_build_object(
    'id', 'automation-marketplace-installs',
    'label', 'Installs',
    'href', '/console/automation/marketplace/installs',
    'resource', 'automation_asset_installs',
    'capability', 'automation_marketplace.read'
  );
  v_reviews_item JSONB := jsonb_build_object(
    'id', 'automation-marketplace-reviews',
    'label', 'Reviews',
    'href', '/console/automation/marketplace/reviews',
    'resource', 'automation_asset_reviews',
    'capability', 'automation_marketplace.review'
  );
  v_connections_item JSONB := jsonb_build_object(
    'id', 'automation-marketplace-connections',
    'label', 'Connections',
    'href', '/console/automation/marketplace/connections',
    'resource', 'integration_connections',
    'capability', 'automation_marketplace.manage_connections'
  );
BEGIN
  SELECT sv.value
    INTO v_current
    FROM public.settings s
    JOIN public.settings_versions sv ON sv.id = s.settings_version_id
   WHERE s.category = 'ui_navigation'
     AND s.scope_type = public.get_root_scope_type_key_v1()
     AND s.scope_id IS NULL
   LIMIT 1;

  IF v_current IS NULL THEN
    RAISE EXCEPTION 'ui_navigation global settings missing';
  END IF;

  FOR v_section IN
    SELECT *
    FROM jsonb_array_elements(COALESCE(v_current#>'{apps,console,sections}', '[]'::jsonb))
  LOOP
    IF v_section->>'id' = 'automation' THEN
      v_found := TRUE;
      v_items := COALESCE(v_section->'items', '[]'::jsonb);

      IF NOT EXISTS (SELECT 1 FROM jsonb_array_elements(v_items) item WHERE item->>'id' = 'automation-marketplace') THEN
        v_items := v_items || jsonb_build_array(v_section_item);
      END IF;
      IF NOT EXISTS (SELECT 1 FROM jsonb_array_elements(v_items) item WHERE item->>'id' = 'automation-marketplace-installs') THEN
        v_items := v_items || jsonb_build_array(v_installs_item);
      END IF;
      IF NOT EXISTS (SELECT 1 FROM jsonb_array_elements(v_items) item WHERE item->>'id' = 'automation-marketplace-reviews') THEN
        v_items := v_items || jsonb_build_array(v_reviews_item);
      END IF;
      IF NOT EXISTS (SELECT 1 FROM jsonb_array_elements(v_items) item WHERE item->>'id' = 'automation-marketplace-connections') THEN
        v_items := v_items || jsonb_build_array(v_connections_item);
      END IF;

      v_section := jsonb_set(v_section, '{items}', v_items, TRUE);
    END IF;

    v_console_sections := v_console_sections || jsonb_build_array(v_section);
  END LOOP;

  IF v_found IS FALSE THEN
    v_console_sections := v_console_sections || jsonb_build_array(
      jsonb_build_object(
        'id', 'automation',
        'label', 'Automation',
        'items', jsonb_build_array(v_section_item, v_installs_item, v_reviews_item, v_connections_item)
      )
    );
  END IF;

  v_current := jsonb_set(v_current, '{apps,console,sections}', v_console_sections, TRUE);

  IF v_current IS DISTINCT FROM (SELECT sv.value FROM public.settings s JOIN public.settings_versions sv ON sv.id=s.settings_version_id WHERE s.category='ui_navigation' AND s.scope_type=public.get_root_scope_type_key_v1() AND s.scope_id IS NULL) THEN
    PERFORM public.upsert_settings_value_v1('ui_navigation',public.get_root_scope_type_key_v1(),NULL,v_current,
      (SELECT sv.schema_version FROM public.settings s JOIN public.settings_versions sv ON sv.id=s.settings_version_id WHERE s.category='ui_navigation' AND s.scope_type=public.get_root_scope_type_key_v1() AND s.scope_id IS NULL),
      'Register marketplace navigation');
  END IF;
END $$;


-- Thin invoker wrappers expose only the retained thirteen lifecycle contracts.
CREATE SCHEMA IF NOT EXISTS api;
GRANT USAGE ON SCHEMA api TO authenticated,service_role;
DO $wrappers$
DECLARE f RECORD; name TEXT; call_args TEXT; i INTEGER;
BEGIN
 FOREACH name IN ARRAY ARRAY['automation_asset_create_listing_v1','automation_asset_publish_version_v1','automation_asset_submit_review_v1','automation_asset_review_decide_v1','integration_connection_upsert_v1','integration_connection_test_v1','integration_connection_rotate_v1','integration_connection_revoke_v1','integration_connection_bind_install_v1','automation_asset_install_v1','automation_asset_upgrade_preview_v1','automation_asset_upgrade_apply_v1','automation_asset_fork_v1'] LOOP
  SELECT p.oid,p.pronargs INTO STRICT f FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='public' AND p.proname=name;
  call_args:='';
  FOR i IN 1..f.pronargs LOOP call_args:=call_args || CASE WHEN i>1 THEN ',' ELSE '' END || '$' || i; END LOOP;
  EXECUTE format('CREATE OR REPLACE FUNCTION api.%I(%s) RETURNS jsonb LANGUAGE sql SECURITY INVOKER SET search_path TO public,extensions,pg_temp AS $fn$ SELECT public.%I(%s); $fn$',
   name,pg_get_function_arguments(f.oid),name,call_args);
  EXECUTE format('REVOKE ALL ON FUNCTION api.%I(%s) FROM PUBLIC,anon,authenticated,service_role',name,pg_get_function_identity_arguments(f.oid));
  EXECUTE format('GRANT EXECUTE ON FUNCTION api.%I(%s) TO authenticated,service_role',name,pg_get_function_identity_arguments(f.oid));
 END LOOP;
END;
$wrappers$;

COMMIT;
