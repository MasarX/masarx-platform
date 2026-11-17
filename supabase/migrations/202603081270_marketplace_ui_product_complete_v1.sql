-- Plan: PLAN-202603-marketplace-network-product-complete / Step: S04
-- Migration: Marketplace UI registry, navigation, and commands for product-complete phase

BEGIN;
SELECT pg_advisory_lock(hashtext('202603081270_marketplace_ui_product_complete_v1'));
SET search_path TO public, extensions, pg_temp;
SET LOCAL lock_timeout = '30s';

DROP VIEW IF EXISTS public.marketplace_private_pool_memberships;
CREATE VIEW public.marketplace_private_pool_memberships
WITH (security_invoker = true)
AS
SELECT
  r.id AS request_id,
  r.requester_organization_id,
  pool.value::uuid AS supplier_organization_id,
  r.request_kind_key,
  r.status,
  r.release_state,
  r.created_at,
  r.updated_at
FROM public.marketplace_requests r
JOIN LATERAL jsonb_array_elements_text(COALESCE(r.private_pool, '[]'::jsonb)) AS pool(value) ON TRUE;

DO $$
DECLARE
  v_current JSONB;
  v_resources JSONB := '[]'::jsonb;
  v_resource JSONB;
  v_item JSONB;
  v_updated JSONB := '[]'::jsonb;
  v_new_resources JSONB := jsonb_build_array(
    jsonb_build_object(
      'key', 'marketplace_availability_windows',
      'label', 'Marketplace availability windows',
      'relation', 'public.marketplace_availability_windows',
      'id_column', 'id',
      'capability_read', 'marketplace_participants.read',
      'capability_write', 'marketplace_participants.write',
      'select', jsonb_build_array('id','participant_profile_id','availability_status','starts_at','ends_at','capacity','created_at','updated_at'),
      'filters', jsonb_build_array(
        jsonb_build_object('key', 'participant_profile_id', 'column', 'participant_profile_id', 'op', 'eq'),
        jsonb_build_object('key', 'availability_status', 'column', 'availability_status', 'op', 'eq')
      ),
      'default_sort', jsonb_build_object('column', 'starts_at', 'direction', 'desc')
    ),
    jsonb_build_object(
      'key', 'marketplace_settlement_batches',
      'label', 'Marketplace settlements',
      'relation', 'public.settlement_batches',
      'id_column', 'id',
      'capability_read', 'marketplace_contracts.read',
      'capability_write', 'marketplace_contracts.write',
      'select', jsonb_build_array('id','organization_id','kind','scope_type','subject_type','subject_id','status','status_reason','window_start_at','window_end_at','metadata','created_at','updated_at'),
      'filters', jsonb_build_array(
        jsonb_build_object('key', 'scope_type', 'column', 'scope_type', 'op', 'eq'),
        jsonb_build_object('key', 'subject_id', 'column', 'subject_id', 'op', 'eq'),
        jsonb_build_object('key', 'status', 'column', 'status', 'op', 'eq')
      ),
      'default_sort', jsonb_build_object('column', 'created_at', 'direction', 'desc')
    ),
    jsonb_build_object(
      'key', 'marketplace_private_pools',
      'label', 'Marketplace private pools',
      'relation', 'public.marketplace_private_pool_memberships',
      'id_column', 'request_id',
      'capability_read', 'marketplace_requests.read',
      'capability_write', 'marketplace_requests.write',
      'select', jsonb_build_array('request_id','requester_organization_id','supplier_organization_id','request_kind_key','status','release_state','created_at','updated_at'),
      'filters', jsonb_build_array(
        jsonb_build_object('key', 'request_id', 'column', 'request_id', 'op', 'eq'),
        jsonb_build_object('key', 'supplier_organization_id', 'column', 'supplier_organization_id', 'op', 'eq'),
        jsonb_build_object('key', 'requester_organization_id', 'column', 'requester_organization_id', 'op', 'eq')
      ),
      'default_sort', jsonb_build_object('column', 'updated_at', 'direction', 'desc')
    )
  );
BEGIN
  SELECT sv.value
    INTO v_current
    FROM public.settings s
    JOIN public.settings_versions sv ON sv.id = s.settings_version_id
   WHERE s.category = 'ui_read_registry'
     AND s.scope_type = 'global'
     AND s.scope_id IS NULL
   LIMIT 1;

  IF v_current IS NULL THEN
    RAISE EXCEPTION 'ui_read_registry global settings missing';
  END IF;

  v_resources := COALESCE(v_current->'resources', '[]'::jsonb);

  FOR v_resource IN SELECT * FROM jsonb_array_elements(v_new_resources)
  LOOP
    IF EXISTS (
      SELECT 1
        FROM jsonb_array_elements(v_resources) item
       WHERE item->>'key' = v_resource->>'key'
    ) THEN
      FOR v_item IN SELECT * FROM jsonb_array_elements(v_resources)
      LOOP
        IF v_item->>'key' = v_resource->>'key' THEN
          v_updated := v_updated || jsonb_build_array(v_resource);
        ELSE
          v_updated := v_updated || jsonb_build_array(v_item);
        END IF;
      END LOOP;
      v_resources := v_updated;
      v_updated := '[]'::jsonb;
    ELSE
      v_resources := v_resources || jsonb_build_array(v_resource);
    END IF;
  END LOOP;

  UPDATE public.settings_versions sv
     SET value = jsonb_set(v_current, '{resources}', v_resources, TRUE),
         version = sv.version + 1,
         change_reason = 'Add product-complete marketplace resources to ui_read_registry',
         approved_at = now(),
         effective_from = now()
   WHERE sv.id = (
     SELECT s.settings_version_id
       FROM public.settings s
      WHERE s.category = 'ui_read_registry'
        AND s.scope_type = 'global'
        AND s.scope_id IS NULL
      LIMIT 1
   );

  UPDATE public.settings s
     SET cached_value = sv.value,
         last_updated = now()
    FROM public.settings_versions sv
   WHERE s.category = 'ui_read_registry'
     AND s.scope_type = 'global'
     AND s.scope_id IS NULL
     AND s.settings_version_id = sv.id;
END $$;

DO $$
DECLARE
  v_current JSONB;
  v_sections JSONB := '[]'::jsonb;
  v_section JSONB;
  v_next_sections JSONB := '[]'::jsonb;
  v_marketplace JSONB;
BEGIN
  SELECT sv.value
    INTO v_current
    FROM public.settings s
    JOIN public.settings_versions sv ON sv.id = s.settings_version_id
   WHERE s.category = 'ui_navigation'
     AND s.scope_type = 'global'
     AND s.scope_id IS NULL
   LIMIT 1;

  IF v_current IS NULL THEN
    RAISE EXCEPTION 'ui_navigation global settings missing';
  END IF;

  v_sections := COALESCE(v_current->'sections', '[]'::jsonb);

  v_marketplace := jsonb_build_object(
    'id', 'marketplace',
    'label', 'Marketplace',
    'items', jsonb_build_array(
      jsonb_build_object('id', 'portal-marketplace-requests', 'label', 'Requests', 'href', '/portal/marketplace/requests', 'resource', 'marketplace_requests', 'capability', 'marketplace_requests.read'),
      jsonb_build_object('id', 'portal-marketplace-provider', 'label', 'Provider workboard', 'href', '/portal/marketplace/provider', 'capability', 'marketplace_offers.read'),
      jsonb_build_object('id', 'portal-marketplace-contracts', 'label', 'Contracts', 'href', '/portal/marketplace/contracts', 'resource', 'marketplace_contracts', 'capability', 'marketplace_contracts.read'),
      jsonb_build_object('id', 'portal-marketplace-private-pools', 'label', 'Private pools', 'href', '/portal/marketplace/private-pools', 'resource', 'marketplace_private_pools', 'capability', 'marketplace_requests.read'),
      jsonb_build_object('id', 'portal-marketplace-settlements', 'label', 'Settlements', 'href', '/portal/marketplace/settlements', 'resource', 'marketplace_settlement_batches', 'capability', 'marketplace_contracts.read'),
      jsonb_build_object('id', 'portal-marketplace-network', 'label', 'Network', 'href', '/portal/marketplace/network', 'resource', 'marketplace_participants', 'capability', 'marketplace_participants.read'),
      jsonb_build_object('id', 'portal-marketplace-work-packages', 'label', 'Work packages', 'href', '/portal/marketplace/work-packages', 'resource', 'marketplace_work_packages', 'capability', 'marketplace_work_packages.read')
    )
  );

  FOR v_section IN SELECT * FROM jsonb_array_elements(v_sections)
  LOOP
    IF v_section->>'id' = 'marketplace' THEN
      v_next_sections := v_next_sections || jsonb_build_array(v_marketplace);
    ELSE
      v_next_sections := v_next_sections || jsonb_build_array(v_section);
    END IF;
  END LOOP;

  IF NOT EXISTS (
    SELECT 1
      FROM jsonb_array_elements(v_sections) item
     WHERE item->>'id' = 'marketplace'
  ) THEN
    v_next_sections := v_next_sections || jsonb_build_array(v_marketplace);
  END IF;

  UPDATE public.settings_versions sv
     SET value = jsonb_set(v_current, '{sections}', v_next_sections, TRUE),
         version = sv.version + 1,
         change_reason = 'Extend portal marketplace navigation for product-complete phase',
         approved_at = now(),
         effective_from = now()
   WHERE sv.id = (
     SELECT s.settings_version_id
       FROM public.settings s
      WHERE s.category = 'ui_navigation'
        AND s.scope_type = 'global'
        AND s.scope_id IS NULL
      LIMIT 1
   );

  UPDATE public.settings s
     SET cached_value = sv.value,
         last_updated = now()
    FROM public.settings_versions sv
   WHERE s.category = 'ui_navigation'
     AND s.scope_type = 'global'
     AND s.scope_id IS NULL
     AND s.settings_version_id = sv.id;
END $$;

DO $$
DECLARE
  v_current JSONB;
  v_commands JSONB := '[]'::jsonb;
  v_command JSONB;
  v_item JSONB;
  v_updated JSONB := '[]'::jsonb;
  v_new JSONB := jsonb_build_array(
    jsonb_build_object('key', 'marketplace.counter', 'label', 'Counter offer', 'capability', 'marketplace_requests.write', 'execution', jsonb_build_object('type', 'rpc', 'rpc', 'marketplace_offer_counter_v1')),
    jsonb_build_object('key', 'marketplace.release', 'label', 'Release request', 'capability', 'marketplace_requests.write', 'execution', jsonb_build_object('type', 'rpc', 'rpc', 'marketplace_request_release_v1')),
    jsonb_build_object('key', 'marketplace.reopen', 'label', 'Reopen request', 'capability', 'marketplace_requests.write', 'execution', jsonb_build_object('type', 'rpc', 'rpc', 'marketplace_request_reopen_v1')),
    jsonb_build_object('key', 'marketplace.expire', 'label', 'Expire request', 'capability', 'marketplace_requests.write', 'execution', jsonb_build_object('type', 'rpc', 'rpc', 'marketplace_request_expire_v1')),
    jsonb_build_object('key', 'marketplace.accept_award', 'label', 'Accept award', 'capability', 'marketplace_awards.write', 'execution', jsonb_build_object('type', 'rpc', 'rpc', 'marketplace_award_respond_v1')),
    jsonb_build_object('key', 'marketplace.complete_work', 'label', 'Complete work package', 'capability', 'marketplace_work_packages.write', 'execution', jsonb_build_object('type', 'rpc', 'rpc', 'marketplace_work_package_complete_v1')),
    jsonb_build_object('key', 'marketplace.finalize_settlement', 'label', 'Finalize settlement', 'capability', 'marketplace_contracts.write', 'execution', jsonb_build_object('type', 'rpc', 'rpc', 'marketplace_settlement_finalize_v1')),
    jsonb_build_object('key', 'marketplace.reverse_settlement', 'label', 'Reverse settlement', 'capability', 'marketplace_contracts.write', 'execution', jsonb_build_object('type', 'rpc', 'rpc', 'marketplace_settlement_reverse_v1'))
  );
BEGIN
  SELECT sv.value
    INTO v_current
    FROM public.settings s
    JOIN public.settings_versions sv ON sv.id = s.settings_version_id
   WHERE s.category = 'ui_command_registry'
     AND s.scope_type = 'global'
     AND s.scope_id IS NULL
   LIMIT 1;

  IF v_current IS NULL THEN
    RAISE EXCEPTION 'ui_command_registry global settings missing';
  END IF;

  v_commands := COALESCE(v_current->'commands', '[]'::jsonb);
  FOR v_command IN SELECT * FROM jsonb_array_elements(v_new)
  LOOP
    IF EXISTS (
      SELECT 1
        FROM jsonb_array_elements(v_commands) item
       WHERE item->>'key' = v_command->>'key'
    ) THEN
      FOR v_item IN SELECT * FROM jsonb_array_elements(v_commands)
      LOOP
        IF v_item->>'key' = v_command->>'key' THEN
          v_updated := v_updated || jsonb_build_array(v_command);
        ELSE
          v_updated := v_updated || jsonb_build_array(v_item);
        END IF;
      END LOOP;
      v_commands := v_updated;
      v_updated := '[]'::jsonb;
    ELSE
      v_commands := v_commands || jsonb_build_array(v_command);
    END IF;
  END LOOP;

  UPDATE public.settings_versions sv
     SET value = jsonb_set(v_current, '{commands}', v_commands, TRUE),
         version = sv.version + 1,
         change_reason = 'Add product-complete marketplace commands to ui_command_registry',
         approved_at = now(),
         effective_from = now()
   WHERE sv.id = (
     SELECT s.settings_version_id
       FROM public.settings s
      WHERE s.category = 'ui_command_registry'
        AND s.scope_type = 'global'
        AND s.scope_id IS NULL
      LIMIT 1
   );

  UPDATE public.settings s
     SET cached_value = sv.value,
         last_updated = now()
    FROM public.settings_versions sv
   WHERE s.category = 'ui_command_registry'
     AND s.scope_type = 'global'
     AND s.scope_id IS NULL
     AND s.settings_version_id = sv.id;
END $$;

SELECT pg_advisory_unlock(hashtext('202603081270_marketplace_ui_product_complete_v1'));
COMMIT;
