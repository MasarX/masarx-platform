-- Migration: Mobile V2 policy categories pack (foundation)
-- Date: 2026-05-10
-- Spec: FieldOps V2 production-readiness — register row-driven policy
--       categories required by the Claude Design handoff bundle so every
--       new mobile UX behavior resolves through the standard ladder
--       (Global < Tenant < Client < Sender < Source/Resource) with hub
--       overrides via `public.branches` and zero hardcoded reason/action
--       taxonomies in the client.
--
-- New categories registered:
--   1.  mobile_pre_shift_gate_policy   (KYC + cleaning + photo cadence gates)
--   2.  mobile_pod_policy              (POD methods + failed-delivery taxonomy)
--   3.  mobile_loader_policy           (loader scan modes + actions catalog)
--   4.  mobile_pickup_policy           (first-mile pickup rules)
--   5.  mobile_linehaul_policy         (line-haul trip stages + gate-in)
--   6.  mobile_sortation_policy        (cross-dock bay catalog + exception routing)
--   7.  mobile_cash_policy             (cash drop thresholds + variance approval)
--   8.  mobile_tasks_policy            (unified Tasks home defaults)
--   9.  mobile_returns_policy          (RTO desk + parcel-level confirm)
--  10.  mobile_eor_policy              (end-of-route hand-back)
--
-- All categories are additive. No tables changed. No data deleted. Idempotent.

BEGIN;
SELECT pg_advisory_lock(hashtext('202605101200_mobile_v2_policy_categories_pack_v1'));
SET search_path TO public, extensions, pg_temp;
SET LOCAL lock_timeout = '30s';

-------------------------------------------------------------------------------
-- 1) Category registry
-------------------------------------------------------------------------------

INSERT INTO public.settings_category_registry (
  category,
  description,
  requires_schema,
  requires_global_default,
  side_effecting,
  safe_missing_behavior,
  allowed_scopes,
  resource_scope_rel
)
VALUES
  (
    'mobile_pre_shift_gate_policy',
    'Mobile V2 pre-shift gate (KYC, vehicle photos, cleaning attestation, health) cadences and required documents resolved via ladder.',
    TRUE,
    TRUE,
    FALSE,
    'hard_fail',
    '["global","tenant","client","sender","source","resource"]'::jsonb,
    'public.branches'::regclass
  ),
  (
    'mobile_pod_policy',
    'Mobile V2 proof-of-delivery methods and failed-delivery reason taxonomy with per-reason gating flags resolved via ladder.',
    TRUE,
    TRUE,
    FALSE,
    'hard_fail',
    '["global","tenant","client","sender","source","resource"]'::jsonb,
    'public.branches'::regclass
  ),
  (
    'mobile_loader_policy',
    'Mobile V2 loader scan modes and per-hub enabled actions catalog resolved via ladder.',
    TRUE,
    TRUE,
    FALSE,
    'hard_fail',
    '["global","tenant","client","sender","source","resource"]'::jsonb,
    'public.branches'::regclass
  ),
  (
    'mobile_pickup_policy',
    'Mobile V2 first-mile pickup rules (seal requirement, scan-each-parcel, fail-reason taxonomy) resolved via ladder.',
    TRUE,
    TRUE,
    FALSE,
    'hard_fail',
    '["global","tenant","client","sender","source","resource"]'::jsonb,
    'public.branches'::regclass
  ),
  (
    'mobile_linehaul_policy',
    'Mobile V2 line-haul trip stages, gate-in needs, seal management, and reconcile flow resolved via ladder.',
    TRUE,
    TRUE,
    FALSE,
    'hard_fail',
    '["global","tenant","client","sender","source","resource"]'::jsonb,
    'public.branches'::regclass
  ),
  (
    'mobile_sortation_policy',
    'Mobile V2 cross-dock sortation bay catalog and exception/transfer routing resolved via ladder.',
    TRUE,
    TRUE,
    FALSE,
    'hard_fail',
    '["global","tenant","client","sender","source","resource"]'::jsonb,
    'public.branches'::regclass
  ),
  (
    'mobile_cash_policy',
    'Mobile V2 cash handling thresholds (drop, per-stop cap, variance approval, photo/sig requirements) resolved via ladder; hub overrides via public.branches.',
    TRUE,
    TRUE,
    FALSE,
    'hard_fail',
    '["global","tenant","client","sender","source","resource"]'::jsonb,
    'public.branches'::regclass
  ),
  (
    'mobile_tasks_policy',
    'Mobile V2 unified Tasks home defaults (default view/sort/group/density, max items, view catalog overlay) resolved via ladder.',
    TRUE,
    TRUE,
    FALSE,
    'hard_fail',
    '["global","tenant","client","sender","source","resource"]'::jsonb,
    'public.branches'::regclass
  ),
  (
    'mobile_returns_policy',
    'Mobile V2 returns/RTO rules (return desk hub mapping, parcel-level confirm, destruction audit) resolved via ladder.',
    TRUE,
    TRUE,
    FALSE,
    'hard_fail',
    '["global","tenant","client","sender","source","resource"]'::jsonb,
    'public.branches'::regclass
  ),
  (
    'mobile_eor_policy',
    'Mobile V2 end-of-route hand-back contract (cleaning prompt, photo refresh, cash settlement order) resolved via ladder.',
    TRUE,
    TRUE,
    FALSE,
    'hard_fail',
    '["global","tenant","client","sender","source","resource"]'::jsonb,
    'public.branches'::regclass
  )
ON CONFLICT (category) DO UPDATE
SET
  description = EXCLUDED.description,
  requires_schema = EXCLUDED.requires_schema,
  requires_global_default = EXCLUDED.requires_global_default,
  side_effecting = EXCLUDED.side_effecting,
  safe_missing_behavior = EXCLUDED.safe_missing_behavior,
  allowed_scopes = EXCLUDED.allowed_scopes,
  resource_scope_rel = EXCLUDED.resource_scope_rel,
  updated_at = now();

-------------------------------------------------------------------------------
-- 2) Schema registry — JSON Schema for each category
-------------------------------------------------------------------------------

INSERT INTO public.schema_registry (category, version, schema, description, examples, is_active)
VALUES
  (
    'mobile_pre_shift_gate_policy',
    1,
    jsonb_build_object(
      '$schema', 'http://json-schema.org/draft-07/schema#',
      'title', 'Mobile V2 Pre-Shift Gate Policy',
      'type', 'object',
      'additionalProperties', TRUE,
      'required', jsonb_build_array('version', 'photo_cadence_hours', 'cleaning_cadence_hours', 'require_photo_on_dirty', 'health_attestation', 'required_documents'),
      'properties', jsonb_build_object(
        'version', jsonb_build_object('type', 'integer', 'minimum', 1),
        'photo_cadence_hours', jsonb_build_object('type', 'integer', 'minimum', 1, 'maximum', 168),
        'cleaning_cadence_hours', jsonb_build_object('type', 'integer', 'minimum', 1, 'maximum', 168),
        'require_photo_on_dirty', jsonb_build_object('type', 'boolean'),
        'health_attestation', jsonb_build_object('type', 'boolean'),
        'required_documents', jsonb_build_object(
          'type', 'array',
          'items', jsonb_build_object('type', 'string', 'enum', jsonb_build_array('national_id', 'iqama', 'driving_licence', 'vehicle_registration', 'vehicle_photos'))
        ),
        'bag_seal_required', jsonb_build_object('type', 'boolean')
      )
    ),
    'Pre-shift gate cadences and required documents for FieldOps mobile V2.',
    jsonb_build_array(jsonb_build_object(
      'version', 1,
      'photo_cadence_hours', 24,
      'cleaning_cadence_hours', 24,
      'require_photo_on_dirty', TRUE,
      'health_attestation', TRUE,
      'required_documents', jsonb_build_array('national_id', 'driving_licence', 'vehicle_registration', 'vehicle_photos'),
      'bag_seal_required', FALSE
    )),
    TRUE
  ),
  (
    'mobile_pod_policy',
    1,
    jsonb_build_object(
      '$schema', 'http://json-schema.org/draft-07/schema#',
      'title', 'Mobile V2 POD Policy',
      'type', 'object',
      'additionalProperties', TRUE,
      'required', jsonb_build_array('version', 'methods', 'fail_reasons'),
      'properties', jsonb_build_object(
        'version', jsonb_build_object('type', 'integer', 'minimum', 1),
        'methods', jsonb_build_object(
          'type', 'array',
          'items', jsonb_build_object('type', 'string', 'enum', jsonb_build_array('scan', 'photo', 'sig', 'otp', 'id', 'cod'))
        ),
        'fail_reasons', jsonb_build_object(
          'type', 'array',
          'items', jsonb_build_object(
            'type', 'object',
            'required', jsonb_build_array('code', 'label'),
            'properties', jsonb_build_object(
              'code', jsonb_build_object('type', 'string'),
              'label', jsonb_build_object('type', 'string'),
              'reattempt', jsonb_build_object('type', 'boolean'),
              'photo', jsonb_build_object('type', 'boolean'),
              'note', jsonb_build_object('type', 'boolean'),
              'escalate', jsonb_build_object('type', 'boolean'),
              'cod_only', jsonb_build_object('type', 'boolean')
            )
          )
        ),
        'cod_currency', jsonb_build_object('type', 'string', 'default', 'SAR')
      )
    ),
    'POD methods and failed-delivery reason taxonomy with per-reason gating flags.',
    jsonb_build_array(jsonb_build_object(
      'version', 1,
      'methods', jsonb_build_array('scan', 'photo', 'sig'),
      'fail_reasons', jsonb_build_array(
        jsonb_build_object('code', 'recipient_unavailable', 'label', 'Recipient unavailable', 'reattempt', TRUE, 'photo', FALSE, 'note', TRUE, 'escalate', FALSE),
        jsonb_build_object('code', 'address_not_found', 'label', 'Address not found', 'reattempt', TRUE, 'photo', TRUE, 'note', TRUE, 'escalate', FALSE),
        jsonb_build_object('code', 'parcel_damaged', 'label', 'Parcel damaged', 'reattempt', FALSE, 'photo', TRUE, 'note', TRUE, 'escalate', TRUE),
        jsonb_build_object('code', 'cod_unpaid', 'label', 'COD not paid', 'reattempt', TRUE, 'photo', FALSE, 'note', TRUE, 'escalate', FALSE, 'cod_only', TRUE)
      ),
      'cod_currency', 'SAR'
    )),
    TRUE
  ),
  (
    'mobile_loader_policy',
    1,
    jsonb_build_object(
      '$schema', 'http://json-schema.org/draft-07/schema#',
      'title', 'Mobile V2 Loader Policy',
      'type', 'object',
      'additionalProperties', TRUE,
      'required', jsonb_build_array('version', 'scan_modes', 'default_mode', 'actions', 'enabled_actions', 'default_action'),
      'properties', jsonb_build_object(
        'version', jsonb_build_object('type', 'integer', 'minimum', 1),
        'scan_modes', jsonb_build_object(
          'type', 'array',
          'items', jsonb_build_object('type', 'string', 'enum', jsonb_build_array('single', 'bulk'))
        ),
        'default_mode', jsonb_build_object('type', 'string', 'enum', jsonb_build_array('single', 'bulk')),
        'actions', jsonb_build_object(
          'type', 'array',
          'items', jsonb_build_object(
            'type', 'object',
            'required', jsonb_build_array('key', 'label'),
            'properties', jsonb_build_object(
              'key', jsonb_build_object('type', 'string'),
              'label', jsonb_build_object('type', 'string'),
              'icon', jsonb_build_object('type', 'string')
            )
          )
        ),
        'enabled_actions', jsonb_build_object('type', 'array', 'items', jsonb_build_object('type', 'string')),
        'default_action', jsonb_build_object('type', 'string'),
        'context_chips', jsonb_build_object('type', 'array', 'items', jsonb_build_object('type', 'string')),
        'confirm_threshold', jsonb_build_object('type', 'integer', 'minimum', 0),
        'sound_enabled', jsonb_build_object('type', 'boolean'),
        'haptic_on_scan', jsonb_build_object('type', 'boolean')
      )
    ),
    'Loader scan modes and per-hub enabled actions catalog.',
    jsonb_build_array(jsonb_build_object(
      'version', 1,
      'scan_modes', jsonb_build_array('single', 'bulk'),
      'default_mode', 'single',
      'actions', jsonb_build_array(
        jsonb_build_object('key', 'load', 'label', 'Load', 'icon', 'truck'),
        jsonb_build_object('key', 'unload', 'label', 'Unload', 'icon', 'package'),
        jsonb_build_object('key', 'receive', 'label', 'Receive', 'icon', 'box'),
        jsonb_build_object('key', 'sort', 'label', 'Sort', 'icon', 'split'),
        jsonb_build_object('key', 'verify', 'label', 'Verify', 'icon', 'check-double'),
        jsonb_build_object('key', 'damage', 'label', 'Damage', 'icon', 'alert'),
        jsonb_build_object('key', 'shelve', 'label', 'Shelve', 'icon', 'layers'),
        jsonb_build_object('key', 'inter_hub_transfer', 'label', 'Transfer', 'icon', 'route')
      ),
      'enabled_actions', jsonb_build_array('load', 'unload', 'receive', 'sort'),
      'default_action', 'load',
      'context_chips', jsonb_build_array('route', 'bay'),
      'confirm_threshold', 25,
      'sound_enabled', TRUE,
      'haptic_on_scan', TRUE
    )),
    TRUE
  ),
  (
    'mobile_pickup_policy',
    1,
    jsonb_build_object(
      '$schema', 'http://json-schema.org/draft-07/schema#',
      'title', 'Mobile V2 Pickup Policy',
      'type', 'object',
      'additionalProperties', TRUE,
      'required', jsonb_build_array('version', 'seal_required', 'scan_required', 'fail_reasons'),
      'properties', jsonb_build_object(
        'version', jsonb_build_object('type', 'integer', 'minimum', 1),
        'seal_required', jsonb_build_object('type', 'boolean'),
        'scan_required', jsonb_build_object('type', 'boolean'),
        'expected_quantity_source', jsonb_build_object('type', 'string', 'enum', jsonb_build_array('manifest', 'merchant_input', 'dynamic')),
        'fail_reasons', jsonb_build_object(
          'type', 'array',
          'items', jsonb_build_object(
            'type', 'object',
            'required', jsonb_build_array('code', 'label'),
            'properties', jsonb_build_object(
              'code', jsonb_build_object('type', 'string'),
              'label', jsonb_build_object('type', 'string'),
              'reattempt', jsonb_build_object('type', 'boolean'),
              'note', jsonb_build_object('type', 'boolean')
            )
          )
        ),
        'photo_required', jsonb_build_object('type', 'boolean'),
        'signature_required', jsonb_build_object('type', 'boolean')
      )
    ),
    'First-mile pickup rules (seal, scan-each-parcel, failure taxonomy).',
    jsonb_build_array(jsonb_build_object(
      'version', 1,
      'seal_required', TRUE,
      'scan_required', TRUE,
      'expected_quantity_source', 'manifest',
      'fail_reasons', jsonb_build_array(
        jsonb_build_object('code', 'merchant_unavailable', 'label', 'Merchant unavailable', 'reattempt', TRUE, 'note', TRUE),
        jsonb_build_object('code', 'parcel_not_ready', 'label', 'Parcel not ready', 'reattempt', TRUE, 'note', TRUE),
        jsonb_build_object('code', 'address_invalid', 'label', 'Address invalid', 'reattempt', FALSE, 'note', TRUE)
      ),
      'photo_required', FALSE,
      'signature_required', TRUE
    )),
    TRUE
  ),
  (
    'mobile_linehaul_policy',
    1,
    jsonb_build_object(
      '$schema', 'http://json-schema.org/draft-07/schema#',
      'title', 'Mobile V2 Line-Haul Policy',
      'type', 'object',
      'additionalProperties', TRUE,
      'required', jsonb_build_array('version', 'stages', 'gate_in_required', 'seal_management'),
      'properties', jsonb_build_object(
        'version', jsonb_build_object('type', 'integer', 'minimum', 1),
        'stages', jsonb_build_object(
          'type', 'array',
          'items', jsonb_build_object('type', 'string', 'enum', jsonb_build_array('assigned', 'gate_in', 'loading', 'sealed', 'in_transit', 'arrived', 'gate_out', 'reconciled'))
        ),
        'gate_in_required', jsonb_build_object('type', 'boolean'),
        'seal_management', jsonb_build_object('type', 'boolean'),
        'arrival_scan_required', jsonb_build_object('type', 'boolean'),
        'reconcile_threshold_minutes', jsonb_build_object('type', 'integer', 'minimum', 0)
      )
    ),
    'Line-haul trip stage taxonomy and gate-in/seal flow.',
    jsonb_build_array(jsonb_build_object(
      'version', 1,
      'stages', jsonb_build_array('assigned', 'gate_in', 'loading', 'sealed', 'in_transit', 'arrived', 'gate_out', 'reconciled'),
      'gate_in_required', TRUE,
      'seal_management', TRUE,
      'arrival_scan_required', TRUE,
      'reconcile_threshold_minutes', 60
    )),
    TRUE
  ),
  (
    'mobile_sortation_policy',
    1,
    jsonb_build_object(
      '$schema', 'http://json-schema.org/draft-07/schema#',
      'title', 'Mobile V2 Sortation Policy',
      'type', 'object',
      'additionalProperties', TRUE,
      'required', jsonb_build_array('version', 'bay_resolution', 'exception_bay', 'transfer_bay'),
      'properties', jsonb_build_object(
        'version', jsonb_build_object('type', 'integer', 'minimum', 1),
        'bay_resolution', jsonb_build_object('type', 'string', 'enum', jsonb_build_array('per_route', 'per_destination_zone', 'per_hub_static')),
        'exception_bay', jsonb_build_object('type', 'string'),
        'transfer_bay', jsonb_build_object('type', 'string'),
        'throughput_window_minutes', jsonb_build_object('type', 'integer', 'minimum', 1, 'maximum', 60),
        'show_throughput_kpi', jsonb_build_object('type', 'boolean')
      )
    ),
    'Cross-dock sortation bay-resolution strategy and exception routing.',
    jsonb_build_array(jsonb_build_object(
      'version', 1,
      'bay_resolution', 'per_route',
      'exception_bay', 'EX',
      'transfer_bay', 'TX',
      'throughput_window_minutes', 5,
      'show_throughput_kpi', TRUE
    )),
    TRUE
  ),
  (
    'mobile_cash_policy',
    1,
    jsonb_build_object(
      '$schema', 'http://json-schema.org/draft-07/schema#',
      'title', 'Mobile V2 Cash Policy',
      'type', 'object',
      'additionalProperties', TRUE,
      'required', jsonb_build_array('version', 'currency', 'drop_threshold', 'per_stop_cap', 'require_photo', 'require_counter_sig', 'supervisor_approval_at_variance'),
      'properties', jsonb_build_object(
        'version', jsonb_build_object('type', 'integer', 'minimum', 1),
        'currency', jsonb_build_object('type', 'string', 'default', 'SAR'),
        'drop_threshold', jsonb_build_object('type', 'number', 'minimum', 0),
        'per_stop_cap', jsonb_build_object('type', 'number', 'minimum', 0),
        'require_photo', jsonb_build_object('type', 'boolean'),
        'require_counter_sig', jsonb_build_object('type', 'boolean'),
        'supervisor_approval_at_variance', jsonb_build_object('type', 'number', 'minimum', 0)
      )
    ),
    'Cash drop thresholds and variance approval flow; resolves Global<Tenant<Client<Sender<Source/Resource (hub) and supports per-driver via downstream resource scope extensions.',
    jsonb_build_array(jsonb_build_object(
      'version', 1,
      'currency', 'SAR',
      'drop_threshold', 2000,
      'per_stop_cap', 5000,
      'require_photo', TRUE,
      'require_counter_sig', TRUE,
      'supervisor_approval_at_variance', 100
    )),
    TRUE
  ),
  (
    'mobile_tasks_policy',
    1,
    jsonb_build_object(
      '$schema', 'http://json-schema.org/draft-07/schema#',
      'title', 'Mobile V2 Tasks Policy',
      'type', 'object',
      'additionalProperties', TRUE,
      'required', jsonb_build_array('version', 'default_view', 'default_sort', 'default_group', 'default_density', 'max_items_per_type'),
      'properties', jsonb_build_object(
        'version', jsonb_build_object('type', 'integer', 'minimum', 1),
        'default_view', jsonb_build_object('type', 'string', 'enum', jsonb_build_array('list', 'board', 'map')),
        'default_sort', jsonb_build_object('type', 'string'),
        'default_group', jsonb_build_object('type', 'string'),
        'default_density', jsonb_build_object('type', 'string', 'enum', jsonb_build_array('comfy', 'compact')),
        'max_items_per_type', jsonb_build_object('type', 'integer', 'minimum', 10, 'maximum', 1000),
        'show_recent_searches', jsonb_build_object('type', 'boolean'),
        'allow_custom_views', jsonb_build_object('type', 'boolean'),
        'bulk_actions', jsonb_build_object('type', 'array', 'items', jsonb_build_object('type', 'string'))
      )
    ),
    'Unified Tasks home defaults: view/sort/group/density, max items, allowed bulk actions.',
    jsonb_build_array(jsonb_build_object(
      'version', 1,
      'default_view', 'list',
      'default_sort', 'smart',
      'default_group', 'urgency',
      'default_density', 'comfy',
      'max_items_per_type', 200,
      'show_recent_searches', TRUE,
      'allow_custom_views', TRUE,
      'bulk_actions', jsonb_build_array('snooze', 'defer', 'escalate')
    )),
    TRUE
  ),
  (
    'mobile_returns_policy',
    1,
    jsonb_build_object(
      '$schema', 'http://json-schema.org/draft-07/schema#',
      'title', 'Mobile V2 Returns Policy',
      'type', 'object',
      'additionalProperties', TRUE,
      'required', jsonb_build_array('version', 'parcel_level_confirm_required', 'allow_destruction', 'destruction_requires_supervisor'),
      'properties', jsonb_build_object(
        'version', jsonb_build_object('type', 'integer', 'minimum', 1),
        'parcel_level_confirm_required', jsonb_build_object('type', 'boolean'),
        'allow_destruction', jsonb_build_object('type', 'boolean'),
        'destruction_requires_supervisor', jsonb_build_object('type', 'boolean'),
        'rto_reason_required', jsonb_build_object('type', 'boolean'),
        'photo_on_return', jsonb_build_object('type', 'boolean')
      )
    ),
    'Returns/RTO desk rules and destruction audit requirements.',
    jsonb_build_array(jsonb_build_object(
      'version', 1,
      'parcel_level_confirm_required', TRUE,
      'allow_destruction', FALSE,
      'destruction_requires_supervisor', TRUE,
      'rto_reason_required', TRUE,
      'photo_on_return', FALSE
    )),
    TRUE
  ),
  (
    'mobile_eor_policy',
    1,
    jsonb_build_object(
      '$schema', 'http://json-schema.org/draft-07/schema#',
      'title', 'Mobile V2 End-of-Route Policy',
      'type', 'object',
      'additionalProperties', TRUE,
      'required', jsonb_build_array('version', 'cleaning_prompt', 'photo_refresh_required', 'cash_settlement_order'),
      'properties', jsonb_build_object(
        'version', jsonb_build_object('type', 'integer', 'minimum', 1),
        'cleaning_prompt', jsonb_build_object('type', 'boolean'),
        'photo_refresh_required', jsonb_build_object('type', 'boolean'),
        'cash_settlement_order', jsonb_build_object(
          'type', 'array',
          'items', jsonb_build_object('type', 'string', 'enum', jsonb_build_array('cash_drop', 'cod_reconcile', 'parcel_reconcile', 'vehicle_photos', 'cleaning'))
        )
      )
    ),
    'End-of-route hand-back contract.',
    jsonb_build_array(jsonb_build_object(
      'version', 1,
      'cleaning_prompt', TRUE,
      'photo_refresh_required', TRUE,
      'cash_settlement_order', jsonb_build_array('cod_reconcile', 'cash_drop', 'parcel_reconcile', 'vehicle_photos', 'cleaning')
    )),
    TRUE
  )
ON CONFLICT (category, version) DO UPDATE
SET schema = EXCLUDED.schema,
    description = EXCLUDED.description,
    examples = EXCLUDED.examples,
    is_active = EXCLUDED.is_active;

-------------------------------------------------------------------------------
-- 3) Global default seeds (settings_versions + settings cache)
-------------------------------------------------------------------------------

WITH seeds AS (
  SELECT * FROM (VALUES
    ('mobile_pre_shift_gate_policy'::text,
     '20e3bef8-ab5c-45ed-81e8-3aee7be68033'::uuid,
     'c208726c-62a5-4cba-b289-848c70c5de64'::uuid,
     jsonb_build_object(
       'version', 1,
       'photo_cadence_hours', 24,
       'cleaning_cadence_hours', 24,
       'require_photo_on_dirty', TRUE,
       'health_attestation', TRUE,
       'required_documents', jsonb_build_array('national_id', 'driving_licence', 'vehicle_registration', 'vehicle_photos'),
       'bag_seal_required', FALSE
     )),
    ('mobile_pod_policy'::text,
     'f55134e6-5e2e-4cb1-9060-141f6fe61e79'::uuid,
     'ea88bf01-7b14-4d8f-a3e1-d802be88765f'::uuid,
     jsonb_build_object(
       'version', 1,
       'methods', jsonb_build_array('scan', 'photo', 'sig'),
       'fail_reasons', jsonb_build_array(
         jsonb_build_object('code', 'recipient_unavailable', 'label', 'Recipient unavailable', 'reattempt', TRUE, 'photo', FALSE, 'note', TRUE, 'escalate', FALSE),
         jsonb_build_object('code', 'address_not_found', 'label', 'Address not found', 'reattempt', TRUE, 'photo', TRUE, 'note', TRUE, 'escalate', FALSE),
         jsonb_build_object('code', 'parcel_damaged', 'label', 'Parcel damaged', 'reattempt', FALSE, 'photo', TRUE, 'note', TRUE, 'escalate', TRUE),
         jsonb_build_object('code', 'cod_unpaid', 'label', 'COD not paid', 'reattempt', TRUE, 'photo', FALSE, 'note', TRUE, 'escalate', FALSE, 'cod_only', TRUE)
       ),
       'cod_currency', 'SAR'
     )),
    ('mobile_loader_policy'::text,
     '2d6e489a-6f38-49f3-8225-a64da7a419e7'::uuid,
     '33e08205-7d89-4125-a0fa-8068a767efa6'::uuid,
     jsonb_build_object(
       'version', 1,
       'scan_modes', jsonb_build_array('single', 'bulk'),
       'default_mode', 'single',
       'actions', jsonb_build_array(
         jsonb_build_object('key', 'load', 'label', 'Load', 'icon', 'truck'),
         jsonb_build_object('key', 'unload', 'label', 'Unload', 'icon', 'package'),
         jsonb_build_object('key', 'receive', 'label', 'Receive', 'icon', 'box'),
         jsonb_build_object('key', 'sort', 'label', 'Sort', 'icon', 'split'),
         jsonb_build_object('key', 'verify', 'label', 'Verify', 'icon', 'check-double'),
         jsonb_build_object('key', 'damage', 'label', 'Damage', 'icon', 'alert'),
         jsonb_build_object('key', 'shelve', 'label', 'Shelve', 'icon', 'layers'),
         jsonb_build_object('key', 'inter_hub_transfer', 'label', 'Transfer', 'icon', 'route')
       ),
       'enabled_actions', jsonb_build_array('load', 'unload', 'receive', 'sort'),
       'default_action', 'load',
       'context_chips', jsonb_build_array('route', 'bay'),
       'confirm_threshold', 25,
       'sound_enabled', TRUE,
       'haptic_on_scan', TRUE
     )),
    ('mobile_pickup_policy'::text,
     '3d1879c4-0782-43fd-a860-8bec7b7b1ae6'::uuid,
     '6e30e0b2-3c3b-4737-9b08-5f2a7ecd2cca'::uuid,
     jsonb_build_object(
       'version', 1,
       'seal_required', TRUE,
       'scan_required', TRUE,
       'expected_quantity_source', 'manifest',
       'fail_reasons', jsonb_build_array(
         jsonb_build_object('code', 'merchant_unavailable', 'label', 'Merchant unavailable', 'reattempt', TRUE, 'note', TRUE),
         jsonb_build_object('code', 'parcel_not_ready', 'label', 'Parcel not ready', 'reattempt', TRUE, 'note', TRUE),
         jsonb_build_object('code', 'address_invalid', 'label', 'Address invalid', 'reattempt', FALSE, 'note', TRUE)
       ),
       'photo_required', FALSE,
       'signature_required', TRUE
     )),
    ('mobile_linehaul_policy'::text,
     '590bf46b-dc74-4cbf-993a-e05006c118ab'::uuid,
     '62125186-01f2-49ed-b2ea-eb8de793b1d6'::uuid,
     jsonb_build_object(
       'version', 1,
       'stages', jsonb_build_array('assigned', 'gate_in', 'loading', 'sealed', 'in_transit', 'arrived', 'gate_out', 'reconciled'),
       'gate_in_required', TRUE,
       'seal_management', TRUE,
       'arrival_scan_required', TRUE,
       'reconcile_threshold_minutes', 60
     )),
    ('mobile_sortation_policy'::text,
     '765ff197-423e-407c-9810-681c629fd87e'::uuid,
     'd17f2dab-17f6-483f-81c5-be983f84b72b'::uuid,
     jsonb_build_object(
       'version', 1,
       'bay_resolution', 'per_route',
       'exception_bay', 'EX',
       'transfer_bay', 'TX',
       'throughput_window_minutes', 5,
       'show_throughput_kpi', TRUE
     )),
    ('mobile_cash_policy'::text,
     'cf121f38-461a-4407-89f1-bd8e06a5ab78'::uuid,
     'a7b4d4f5-f1df-419d-9bd3-123861cd978e'::uuid,
     jsonb_build_object(
       'version', 1,
       'currency', 'SAR',
       'drop_threshold', 2000,
       'per_stop_cap', 5000,
       'require_photo', TRUE,
       'require_counter_sig', TRUE,
       'supervisor_approval_at_variance', 100
     )),
    ('mobile_tasks_policy'::text,
     'b302c8dd-0e64-4727-b5da-bb6008d23ddd'::uuid,
     'f04827cf-e9ec-43db-9334-2046ba8a749f'::uuid,
     jsonb_build_object(
       'version', 1,
       'default_view', 'list',
       'default_sort', 'smart',
       'default_group', 'urgency',
       'default_density', 'comfy',
       'max_items_per_type', 200,
       'show_recent_searches', TRUE,
       'allow_custom_views', TRUE,
       'bulk_actions', jsonb_build_array('snooze', 'defer', 'escalate')
     )),
    ('mobile_returns_policy'::text,
     '908f712d-5731-4bea-aa64-320109c49479'::uuid,
     '1f629885-1fef-4701-b100-8799bd53b9cd'::uuid,
     jsonb_build_object(
       'version', 1,
       'parcel_level_confirm_required', TRUE,
       'allow_destruction', FALSE,
       'destruction_requires_supervisor', TRUE,
       'rto_reason_required', TRUE,
       'photo_on_return', FALSE
     )),
    ('mobile_eor_policy'::text,
     'af838e7c-2d18-4165-9516-d28a9b8dc744'::uuid,
     '95bd9403-6060-4ce9-ae60-793d6470f3d3'::uuid,
     jsonb_build_object(
       'version', 1,
       'cleaning_prompt', TRUE,
       'photo_refresh_required', TRUE,
       'cash_settlement_order', jsonb_build_array('cod_reconcile', 'cash_drop', 'parcel_reconcile', 'vehicle_photos', 'cleaning')
     ))
  ) AS t(category, settings_version_id, settings_id, value)
),
upserted_versions AS (
  INSERT INTO public.settings_versions (
    id,
    category,
    scope_type,
    scope_id,
    scope_hash,
    version,
    value,
    schema_version,
    change_reason,
    approved_at,
    effective_from
  )
  SELECT
    s.settings_version_id,
    s.category,
    'global'::text,
    NULL::uuid,
    '00000000-0000-0000-0000-000000000000'::uuid,
    1,
    s.value,
    1,
    'Mobile V2 policy categories pack — initial global defaults',
    now(),
    now()
  FROM seeds s
  WHERE NOT EXISTS (
    SELECT 1 FROM public.settings_versions sv
    WHERE sv.category = s.category
      AND sv.scope_type = 'global'
      AND sv.scope_hash = '00000000-0000-0000-0000-000000000000'::uuid
      AND sv.effective_until IS NULL
      AND sv.approved_at IS NOT NULL
  )
  RETURNING id, category, value
),
all_versions AS (
  SELECT id, category, value FROM upserted_versions
  UNION ALL
  SELECT sv.id, sv.category, sv.value
  FROM public.settings_versions sv
  JOIN seeds s ON s.category = sv.category
  WHERE sv.scope_type = 'global'
    AND sv.scope_hash = '00000000-0000-0000-0000-000000000000'::uuid
    AND sv.effective_until IS NULL
    AND sv.approved_at IS NOT NULL
    AND NOT EXISTS (SELECT 1 FROM upserted_versions uv WHERE uv.category = sv.category)
)
INSERT INTO public.settings (
  id,
  category,
  scope_type,
  scope_id,
  scope_hash,
  settings_version_id,
  cached_value,
  last_updated
)
SELECT
  s.settings_id,
  av.category,
  'global'::text,
  NULL::uuid,
  '00000000-0000-0000-0000-000000000000'::uuid,
  av.id,
  av.value,
  now()
FROM all_versions av
JOIN seeds s ON s.category = av.category
ON CONFLICT (category, scope_type, scope_hash) DO UPDATE
SET settings_version_id = EXCLUDED.settings_version_id,
    cached_value = EXCLUDED.cached_value,
    last_updated = now();

SELECT pg_advisory_unlock(hashtext('202605101200_mobile_v2_policy_categories_pack_v1'));
COMMIT;
