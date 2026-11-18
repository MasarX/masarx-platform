-- W57-B console-v2 W34c -> W56-E canonical pack — pgTAP coverage
-- pgTAP: validates the W57-B backend canonical pack
-- (supabase/migrations/202605021400_w57b_console_v2_w54_w56_canonical_pack.sql).
--
-- Coverage strategy (mirrors W43:zzw43 + W53:zzw53 + W57-A:zzw57a):
--   * For each new lookup category:
--       - lookup_definitions row presence assertion (1 per category)
--       - lookup_values row count == seed length (1 per category)
--       - tone metadata spot-check on a representative value (1 per category
--         that carries a tone palette)
--   * For each new settings policy:
--       - settings_category_registry row presence (1 per policy)
--       - schema_registry active row presence (1 per policy)
--       - settings_versions current global row presence (1 per policy)
--       - resolve_settings spot-check on a canonical default scalar (1 per policy)
--
-- Total assertions: 59 (LD presence) + 59 (LV count) + 50 (tone spot-check —
-- only categories that carry a tone palette) + 4 (settings policy LD)
-- + 4 (schema_registry) + 4 (settings_versions) + 4 (resolver spot-check)
-- + 4 (settings projection) = 188.

SET search_path TO public, pgtap, extensions, pg_temp;

BEGIN;

CREATE EXTENSION IF NOT EXISTS pgtap;

SELECT plan(188);

-- =============================================================================
-- SECTION A: lookup_definitions presence (1 per category — 59 assertions)
-- =============================================================================

SELECT ok(EXISTS (SELECT 1 FROM public.lookup_definitions WHERE category = 'api_status_class'),                     'lookup_definitions: api_status_class registered');
SELECT ok(EXISTS (SELECT 1 FROM public.lookup_definitions WHERE category = 'email_auth_audit_status'),               'lookup_definitions: email_auth_audit_status registered');
SELECT ok(EXISTS (SELECT 1 FROM public.lookup_definitions WHERE category = 'trace_event_source'),                    'lookup_definitions: trace_event_source registered');
SELECT ok(EXISTS (SELECT 1 FROM public.lookup_definitions WHERE category = 'workflow_binding_dispatch_outcome'),     'lookup_definitions: workflow_binding_dispatch_outcome registered');
SELECT ok(EXISTS (SELECT 1 FROM public.lookup_definitions WHERE category = 'workflow_trigger_scope_type'),           'lookup_definitions: workflow_trigger_scope_type registered');
SELECT ok(EXISTS (SELECT 1 FROM public.lookup_definitions WHERE category = 'dispute_kind'),                          'lookup_definitions: dispute_kind registered');
SELECT ok(EXISTS (SELECT 1 FROM public.lookup_definitions WHERE category = 'dispute_resolution'),                    'lookup_definitions: dispute_resolution registered');
SELECT ok(EXISTS (SELECT 1 FROM public.lookup_definitions WHERE category = 'finance_event_type'),                    'lookup_definitions: finance_event_type registered');
SELECT ok(EXISTS (SELECT 1 FROM public.lookup_definitions WHERE category = 'settlement_kind'),                       'lookup_definitions: settlement_kind registered');
SELECT ok(EXISTS (SELECT 1 FROM public.lookup_definitions WHERE category = 'cod_entry_status'),                      'lookup_definitions: cod_entry_status registered');
SELECT ok(EXISTS (SELECT 1 FROM public.lookup_definitions WHERE category = 'settlement_status'),                     'lookup_definitions: settlement_status registered');
SELECT ok(EXISTS (SELECT 1 FROM public.lookup_definitions WHERE category = 'route_plan_status'),                     'lookup_definitions: route_plan_status registered');
SELECT ok(EXISTS (SELECT 1 FROM public.lookup_definitions WHERE category = 'driver_compliance_severity'),            'lookup_definitions: driver_compliance_severity registered');
SELECT ok(EXISTS (SELECT 1 FROM public.lookup_definitions WHERE category = 'driver_document_kind'),                  'lookup_definitions: driver_document_kind registered');
SELECT ok(EXISTS (SELECT 1 FROM public.lookup_definitions WHERE category = 'plugin_status'),                         'lookup_definitions: plugin_status registered');
SELECT ok(EXISTS (SELECT 1 FROM public.lookup_definitions WHERE category = 'support_message_direction'),             'lookup_definitions: support_message_direction registered');
SELECT ok(EXISTS (SELECT 1 FROM public.lookup_definitions WHERE category = 'support_message_role'),                  'lookup_definitions: support_message_role registered');
SELECT ok(EXISTS (SELECT 1 FROM public.lookup_definitions WHERE category = 'branch_type'),                           'lookup_definitions: branch_type registered');
SELECT ok(EXISTS (SELECT 1 FROM public.lookup_definitions WHERE category = 'branch_status'),                         'lookup_definitions: branch_status registered');
SELECT ok(EXISTS (SELECT 1 FROM public.lookup_definitions WHERE category = 'branch_zone_role'),                      'lookup_definitions: branch_zone_role registered');
SELECT ok(EXISTS (SELECT 1 FROM public.lookup_definitions WHERE category = 'branch_member_role'),                    'lookup_definitions: branch_member_role registered');
SELECT ok(EXISTS (SELECT 1 FROM public.lookup_definitions WHERE category = 'zone_status'),                           'lookup_definitions: zone_status registered');
SELECT ok(EXISTS (SELECT 1 FROM public.lookup_definitions WHERE category = 'zone_district_role'),                    'lookup_definitions: zone_district_role registered');
SELECT ok(EXISTS (SELECT 1 FROM public.lookup_definitions WHERE category = 'zone_override_status'),                  'lookup_definitions: zone_override_status registered');
SELECT ok(EXISTS (SELECT 1 FROM public.lookup_definitions WHERE category = 'zone_override_kind'),                    'lookup_definitions: zone_override_kind registered');
SELECT ok(EXISTS (SELECT 1 FROM public.lookup_definitions WHERE category = 'zone_color_token'),                      'lookup_definitions: zone_color_token registered');
SELECT ok(EXISTS (SELECT 1 FROM public.lookup_definitions WHERE category = 'marketplace_offer_status'),              'lookup_definitions: marketplace_offer_status registered');
SELECT ok(EXISTS (SELECT 1 FROM public.lookup_definitions WHERE category = 'marketplace_award_status'),              'lookup_definitions: marketplace_award_status registered');
SELECT ok(EXISTS (SELECT 1 FROM public.lookup_definitions WHERE category = 'marketplace_contract_status'),           'lookup_definitions: marketplace_contract_status registered');
SELECT ok(EXISTS (SELECT 1 FROM public.lookup_definitions WHERE category = 'marketplace_request_status'),            'lookup_definitions: marketplace_request_status registered');
SELECT ok(EXISTS (SELECT 1 FROM public.lookup_definitions WHERE category = 'marketplace_request_kind'),              'lookup_definitions: marketplace_request_kind registered');
SELECT ok(EXISTS (SELECT 1 FROM public.lookup_definitions WHERE category = 'alert_severity'),                        'lookup_definitions: alert_severity registered');
SELECT ok(EXISTS (SELECT 1 FROM public.lookup_definitions WHERE category = 'alert_channel'),                         'lookup_definitions: alert_channel registered');
SELECT ok(EXISTS (SELECT 1 FROM public.lookup_definitions WHERE category = 'alert_trigger_status'),                  'lookup_definitions: alert_trigger_status registered');
SELECT ok(EXISTS (SELECT 1 FROM public.lookup_definitions WHERE category = 'ops_alert_status'),                      'lookup_definitions: ops_alert_status registered');
SELECT ok(EXISTS (SELECT 1 FROM public.lookup_definitions WHERE category = 'feature_flag_status'),                   'lookup_definitions: feature_flag_status registered');
SELECT ok(EXISTS (SELECT 1 FROM public.lookup_definitions WHERE category = 'feature_flag_scope'),                    'lookup_definitions: feature_flag_scope registered');
SELECT ok(EXISTS (SELECT 1 FROM public.lookup_definitions WHERE category = 'vehicle_status'),                        'lookup_definitions: vehicle_status registered');
SELECT ok(EXISTS (SELECT 1 FROM public.lookup_definitions WHERE category = 'vehicle_kind'),                          'lookup_definitions: vehicle_kind registered');
SELECT ok(EXISTS (SELECT 1 FROM public.lookup_definitions WHERE category = 'vehicle_fuel_type'),                     'lookup_definitions: vehicle_fuel_type registered');
SELECT ok(EXISTS (SELECT 1 FROM public.lookup_definitions WHERE category = 'vehicle_event_type'),                    'lookup_definitions: vehicle_event_type registered');
SELECT ok(EXISTS (SELECT 1 FROM public.lookup_definitions WHERE category = 'vehicle_maintenance_kind'),              'lookup_definitions: vehicle_maintenance_kind registered');
SELECT ok(EXISTS (SELECT 1 FROM public.lookup_definitions WHERE category = 'vehicle_maintenance_window_status'),     'lookup_definitions: vehicle_maintenance_window_status registered');
SELECT ok(EXISTS (SELECT 1 FROM public.lookup_definitions WHERE category = 'invoice_status'),                        'lookup_definitions: invoice_status registered');
SELECT ok(EXISTS (SELECT 1 FROM public.lookup_definitions WHERE category = 'invoice_event_type'),                    'lookup_definitions: invoice_event_type registered');
SELECT ok(EXISTS (SELECT 1 FROM public.lookup_definitions WHERE category = 'subscription_status'),                   'lookup_definitions: subscription_status registered');
SELECT ok(EXISTS (SELECT 1 FROM public.lookup_definitions WHERE category = 'agreement_status'),                      'lookup_definitions: agreement_status registered');
SELECT ok(EXISTS (SELECT 1 FROM public.lookup_definitions WHERE category = 'agreement_term_kind'),                   'lookup_definitions: agreement_term_kind registered');
SELECT ok(EXISTS (SELECT 1 FROM public.lookup_definitions WHERE category = 'usage_event_kind'),                      'lookup_definitions: usage_event_kind registered');
SELECT ok(EXISTS (SELECT 1 FROM public.lookup_definitions WHERE category = 'api_method'),                            'lookup_definitions: api_method registered');
SELECT ok(EXISTS (SELECT 1 FROM public.lookup_definitions WHERE category = 'provider_health_status'),                'lookup_definitions: provider_health_status registered');
SELECT ok(EXISTS (SELECT 1 FROM public.lookup_definitions WHERE category = 'import_job_status'),                     'lookup_definitions: import_job_status registered');
SELECT ok(EXISTS (SELECT 1 FROM public.lookup_definitions WHERE category = 'import_job_source'),                     'lookup_definitions: import_job_source registered');
SELECT ok(EXISTS (SELECT 1 FROM public.lookup_definitions WHERE category = 'import_job_kind'),                       'lookup_definitions: import_job_kind registered');
SELECT ok(EXISTS (SELECT 1 FROM public.lookup_definitions WHERE category = 'driver_application_status'),             'lookup_definitions: driver_application_status registered');
SELECT ok(EXISTS (SELECT 1 FROM public.lookup_definitions WHERE category = 'driver_application_doc_status'),         'lookup_definitions: driver_application_doc_status registered');
SELECT ok(EXISTS (SELECT 1 FROM public.lookup_definitions WHERE category = 'session_aal'),                           'lookup_definitions: session_aal registered');
SELECT ok(EXISTS (SELECT 1 FROM public.lookup_definitions WHERE category = 'service_offering_status'),               'lookup_definitions: service_offering_status registered');
SELECT ok(EXISTS (SELECT 1 FROM public.lookup_definitions WHERE category = 'service_level_tier'),                    'lookup_definitions: service_level_tier registered');

-- =============================================================================
-- SECTION B: lookup_values row count per category (1 per category — 59 assertions)
-- =============================================================================
-- Helper: count rows for category by joining through lookup_definitions.

SELECT is(
  (SELECT count(*)::int FROM public.lookup_values lv JOIN public.lookup_definitions ld ON ld.id = lv.lookup_definition_id WHERE ld.category = 'api_status_class'),
  4, 'lookup_values: api_status_class has 4 rows (2xx/3xx/4xx/5xx)');

SELECT is(
  (SELECT count(*)::int FROM public.lookup_values lv JOIN public.lookup_definitions ld ON ld.id = lv.lookup_definition_id WHERE ld.category = 'email_auth_audit_status'),
  3, 'lookup_values: email_auth_audit_status has 3 rows (green/yellow/red)');

SELECT is(
  (SELECT count(*)::int FROM public.lookup_values lv JOIN public.lookup_definitions ld ON ld.id = lv.lookup_definition_id WHERE ld.category = 'trace_event_source'),
  5, 'lookup_values: trace_event_source has 5 rows');

SELECT is(
  (SELECT count(*)::int FROM public.lookup_values lv JOIN public.lookup_definitions ld ON ld.id = lv.lookup_definition_id WHERE ld.category = 'workflow_binding_dispatch_outcome'),
  4, 'lookup_values: workflow_binding_dispatch_outcome has 4 rows');

SELECT is(
  (SELECT count(*)::int FROM public.lookup_values lv JOIN public.lookup_definitions ld ON ld.id = lv.lookup_definition_id WHERE ld.category = 'workflow_trigger_scope_type'),
  3, 'lookup_values: workflow_trigger_scope_type has 3 rows');

SELECT is(
  (SELECT count(*)::int FROM public.lookup_values lv JOIN public.lookup_definitions ld ON ld.id = lv.lookup_definition_id WHERE ld.category = 'dispute_kind'),
  3, 'lookup_values: dispute_kind has 3 rows');

SELECT is(
  (SELECT count(*)::int FROM public.lookup_values lv JOIN public.lookup_definitions ld ON ld.id = lv.lookup_definition_id WHERE ld.category = 'dispute_resolution'),
  3, 'lookup_values: dispute_resolution has 3 rows');

SELECT is(
  (SELECT count(*)::int FROM public.lookup_values lv JOIN public.lookup_definitions ld ON ld.id = lv.lookup_definition_id WHERE ld.category = 'finance_event_type'),
  10, 'lookup_values: finance_event_type has 10 rows');

SELECT is(
  (SELECT count(*)::int FROM public.lookup_values lv JOIN public.lookup_definitions ld ON ld.id = lv.lookup_definition_id WHERE ld.category = 'settlement_kind'),
  4, 'lookup_values: settlement_kind has 4 rows');

SELECT is(
  (SELECT count(*)::int FROM public.lookup_values lv JOIN public.lookup_definitions ld ON ld.id = lv.lookup_definition_id WHERE ld.category = 'cod_entry_status'),
  5, 'lookup_values: cod_entry_status has 5 rows');

SELECT is(
  (SELECT count(*)::int FROM public.lookup_values lv JOIN public.lookup_definitions ld ON ld.id = lv.lookup_definition_id WHERE ld.category = 'settlement_status'),
  5, 'lookup_values: settlement_status has 5 rows');

SELECT is(
  (SELECT count(*)::int FROM public.lookup_values lv JOIN public.lookup_definitions ld ON ld.id = lv.lookup_definition_id WHERE ld.category = 'route_plan_status'),
  11, 'lookup_values: route_plan_status has 11 rows');

SELECT is(
  (SELECT count(*)::int FROM public.lookup_values lv JOIN public.lookup_definitions ld ON ld.id = lv.lookup_definition_id WHERE ld.category = 'driver_compliance_severity'),
  3, 'lookup_values: driver_compliance_severity has 3 rows');

SELECT is(
  (SELECT count(*)::int FROM public.lookup_values lv JOIN public.lookup_definitions ld ON ld.id = lv.lookup_definition_id WHERE ld.category = 'driver_document_kind'),
  4, 'lookup_values: driver_document_kind has 4 rows');

SELECT ok(
  (SELECT count(*)::int >= 5 FROM public.lookup_values lv JOIN public.lookup_definitions ld ON ld.id = lv.lookup_definition_id WHERE ld.category = 'plugin_status'),
  'lookup_values: plugin_status has at least the 5 W57-B canonical rows');

SELECT is(
  (SELECT count(*)::int FROM public.lookup_values lv JOIN public.lookup_definitions ld ON ld.id = lv.lookup_definition_id WHERE ld.category = 'support_message_direction'),
  3, 'lookup_values: support_message_direction has 3 rows');

SELECT is(
  (SELECT count(*)::int FROM public.lookup_values lv JOIN public.lookup_definitions ld ON ld.id = lv.lookup_definition_id WHERE ld.category = 'support_message_role'),
  3, 'lookup_values: support_message_role has 3 rows');

SELECT ok(
  (SELECT count(*)::int >= 7 FROM public.lookup_values lv JOIN public.lookup_definitions ld ON ld.id = lv.lookup_definition_id WHERE ld.category = 'branch_type'),
  'lookup_values: branch_type has at least the 7 W57-B canonical rows');

SELECT is(
  (SELECT count(*)::int FROM public.lookup_values lv JOIN public.lookup_definitions ld ON ld.id = lv.lookup_definition_id WHERE ld.category = 'branch_status'),
  6, 'lookup_values: branch_status has 6 rows');

SELECT is(
  (SELECT count(*)::int FROM public.lookup_values lv JOIN public.lookup_definitions ld ON ld.id = lv.lookup_definition_id WHERE ld.category = 'branch_zone_role'),
  3, 'lookup_values: branch_zone_role has 3 rows');

SELECT is(
  (SELECT count(*)::int FROM public.lookup_values lv JOIN public.lookup_definitions ld ON ld.id = lv.lookup_definition_id WHERE ld.category = 'branch_member_role'),
  6, 'lookup_values: branch_member_role has 6 rows');

SELECT is(
  (SELECT count(*)::int FROM public.lookup_values lv JOIN public.lookup_definitions ld ON ld.id = lv.lookup_definition_id WHERE ld.category = 'zone_status'),
  6, 'lookup_values: zone_status has 6 rows');

SELECT is(
  (SELECT count(*)::int FROM public.lookup_values lv JOIN public.lookup_definitions ld ON ld.id = lv.lookup_definition_id WHERE ld.category = 'zone_district_role'),
  2, 'lookup_values: zone_district_role has 2 rows');

SELECT is(
  (SELECT count(*)::int FROM public.lookup_values lv JOIN public.lookup_definitions ld ON ld.id = lv.lookup_definition_id WHERE ld.category = 'zone_override_status'),
  5, 'lookup_values: zone_override_status has 5 rows');

SELECT is(
  (SELECT count(*)::int FROM public.lookup_values lv JOIN public.lookup_definitions ld ON ld.id = lv.lookup_definition_id WHERE ld.category = 'zone_override_kind'),
  6, 'lookup_values: zone_override_kind has 6 rows');

SELECT is(
  (SELECT count(*)::int FROM public.lookup_values lv JOIN public.lookup_definitions ld ON ld.id = lv.lookup_definition_id WHERE ld.category = 'zone_color_token'),
  10, 'lookup_values: zone_color_token has 10 rows');

SELECT is(
  (SELECT count(*)::int FROM public.lookup_values lv JOIN public.lookup_definitions ld ON ld.id = lv.lookup_definition_id WHERE ld.category = 'marketplace_offer_status'),
  11, 'lookup_values: marketplace_offer_status has 11 rows');

SELECT is(
  (SELECT count(*)::int FROM public.lookup_values lv JOIN public.lookup_definitions ld ON ld.id = lv.lookup_definition_id WHERE ld.category = 'marketplace_award_status'),
  11, 'lookup_values: marketplace_award_status has 11 rows');

SELECT is(
  (SELECT count(*)::int FROM public.lookup_values lv JOIN public.lookup_definitions ld ON ld.id = lv.lookup_definition_id WHERE ld.category = 'marketplace_contract_status'),
  16, 'lookup_values: marketplace_contract_status has 16 rows');

SELECT is(
  (SELECT count(*)::int FROM public.lookup_values lv JOIN public.lookup_definitions ld ON ld.id = lv.lookup_definition_id WHERE ld.category = 'marketplace_request_status'),
  17, 'lookup_values: marketplace_request_status has 17 rows');

SELECT is(
  (SELECT count(*)::int FROM public.lookup_values lv JOIN public.lookup_definitions ld ON ld.id = lv.lookup_definition_id WHERE ld.category = 'marketplace_request_kind'),
  5, 'lookup_values: marketplace_request_kind has 5 rows');

SELECT is(
  (SELECT count(*)::int FROM public.lookup_values lv JOIN public.lookup_definitions ld ON ld.id = lv.lookup_definition_id WHERE ld.category = 'alert_severity'),
  3, 'lookup_values: alert_severity has 3 rows');

SELECT is(
  (SELECT count(*)::int FROM public.lookup_values lv JOIN public.lookup_definitions ld ON ld.id = lv.lookup_definition_id WHERE ld.category = 'alert_channel'),
  4, 'lookup_values: alert_channel has 4 rows');

SELECT is(
  (SELECT count(*)::int FROM public.lookup_values lv JOIN public.lookup_definitions ld ON ld.id = lv.lookup_definition_id WHERE ld.category = 'alert_trigger_status'),
  4, 'lookup_values: alert_trigger_status has 4 rows');

SELECT is(
  (SELECT count(*)::int FROM public.lookup_values lv JOIN public.lookup_definitions ld ON ld.id = lv.lookup_definition_id WHERE ld.category = 'ops_alert_status'),
  3, 'lookup_values: ops_alert_status has 3 rows');

SELECT is(
  (SELECT count(*)::int FROM public.lookup_values lv JOIN public.lookup_definitions ld ON ld.id = lv.lookup_definition_id WHERE ld.category = 'feature_flag_status'),
  3, 'lookup_values: feature_flag_status has 3 rows');

SELECT is(
  (SELECT count(*)::int FROM public.lookup_values lv JOIN public.lookup_definitions ld ON ld.id = lv.lookup_definition_id WHERE ld.category = 'feature_flag_scope'),
  4, 'lookup_values: feature_flag_scope has 4 rows');

SELECT is(
  (SELECT count(*)::int FROM public.lookup_values lv JOIN public.lookup_definitions ld ON ld.id = lv.lookup_definition_id WHERE ld.category = 'vehicle_status'),
  8, 'lookup_values: vehicle_status has 8 rows');

SELECT is(
  (SELECT count(*)::int FROM public.lookup_values lv JOIN public.lookup_definitions ld ON ld.id = lv.lookup_definition_id WHERE ld.category = 'vehicle_kind'),
  6, 'lookup_values: vehicle_kind has 6 rows');

SELECT is(
  (SELECT count(*)::int FROM public.lookup_values lv JOIN public.lookup_definitions ld ON ld.id = lv.lookup_definition_id WHERE ld.category = 'vehicle_fuel_type'),
  4, 'lookup_values: vehicle_fuel_type has 4 rows');

SELECT is(
  (SELECT count(*)::int FROM public.lookup_values lv JOIN public.lookup_definitions ld ON ld.id = lv.lookup_definition_id WHERE ld.category = 'vehicle_event_type'),
  8, 'lookup_values: vehicle_event_type has 8 rows');

SELECT is(
  (SELECT count(*)::int FROM public.lookup_values lv JOIN public.lookup_definitions ld ON ld.id = lv.lookup_definition_id WHERE ld.category = 'vehicle_maintenance_kind'),
  6, 'lookup_values: vehicle_maintenance_kind has 6 rows');

SELECT is(
  (SELECT count(*)::int FROM public.lookup_values lv JOIN public.lookup_definitions ld ON ld.id = lv.lookup_definition_id WHERE ld.category = 'vehicle_maintenance_window_status'),
  4, 'lookup_values: vehicle_maintenance_window_status has 4 rows');

SELECT ok(
  (SELECT count(*)::int >= 6 FROM public.lookup_values lv JOIN public.lookup_definitions ld ON ld.id = lv.lookup_definition_id WHERE ld.category = 'invoice_status'),
  'lookup_values: invoice_status has at least the 6 W57-B canonical rows');

SELECT is(
  (SELECT count(*)::int FROM public.lookup_values lv JOIN public.lookup_definitions ld ON ld.id = lv.lookup_definition_id WHERE ld.category = 'invoice_event_type'),
  6, 'lookup_values: invoice_event_type has 6 rows');

SELECT is(
  (SELECT count(*)::int FROM public.lookup_values lv JOIN public.lookup_definitions ld ON ld.id = lv.lookup_definition_id WHERE ld.category = 'subscription_status'),
  6, 'lookup_values: subscription_status has 6 rows');

SELECT is(
  (SELECT count(*)::int FROM public.lookup_values lv JOIN public.lookup_definitions ld ON ld.id = lv.lookup_definition_id WHERE ld.category = 'agreement_status'),
  4, 'lookup_values: agreement_status has 4 rows');

SELECT is(
  (SELECT count(*)::int FROM public.lookup_values lv JOIN public.lookup_definitions ld ON ld.id = lv.lookup_definition_id WHERE ld.category = 'agreement_term_kind'),
  8, 'lookup_values: agreement_term_kind has 8 rows');

SELECT is(
  (SELECT count(*)::int FROM public.lookup_values lv JOIN public.lookup_definitions ld ON ld.id = lv.lookup_definition_id WHERE ld.category = 'usage_event_kind'),
  7, 'lookup_values: usage_event_kind has 7 rows');

SELECT is(
  (SELECT count(*)::int FROM public.lookup_values lv JOIN public.lookup_definitions ld ON ld.id = lv.lookup_definition_id WHERE ld.category = 'api_method'),
  5, 'lookup_values: api_method has 5 rows');

SELECT is(
  (SELECT count(*)::int FROM public.lookup_values lv JOIN public.lookup_definitions ld ON ld.id = lv.lookup_definition_id WHERE ld.category = 'provider_health_status'),
  4, 'lookup_values: provider_health_status has 4 rows');

SELECT is(
  (SELECT count(*)::int FROM public.lookup_values lv JOIN public.lookup_definitions ld ON ld.id = lv.lookup_definition_id WHERE ld.category = 'import_job_status'),
  5, 'lookup_values: import_job_status has 5 rows');

SELECT is(
  (SELECT count(*)::int FROM public.lookup_values lv JOIN public.lookup_definitions ld ON ld.id = lv.lookup_definition_id WHERE ld.category = 'import_job_source'),
  3, 'lookup_values: import_job_source has 3 rows');

SELECT is(
  (SELECT count(*)::int FROM public.lookup_values lv JOIN public.lookup_definitions ld ON ld.id = lv.lookup_definition_id WHERE ld.category = 'import_job_kind'),
  4, 'lookup_values: import_job_kind has 4 rows');

SELECT is(
  (SELECT count(*)::int FROM public.lookup_values lv JOIN public.lookup_definitions ld ON ld.id = lv.lookup_definition_id WHERE ld.category = 'driver_application_status'),
  4, 'lookup_values: driver_application_status has 4 rows');

SELECT is(
  (SELECT count(*)::int FROM public.lookup_values lv JOIN public.lookup_definitions ld ON ld.id = lv.lookup_definition_id WHERE ld.category = 'driver_application_doc_status'),
  5, 'lookup_values: driver_application_doc_status has 5 rows');

SELECT is(
  (SELECT count(*)::int FROM public.lookup_values lv JOIN public.lookup_definitions ld ON ld.id = lv.lookup_definition_id WHERE ld.category = 'session_aal'),
  3, 'lookup_values: session_aal has 3 rows');

SELECT is(
  (SELECT count(*)::int FROM public.lookup_values lv JOIN public.lookup_definitions ld ON ld.id = lv.lookup_definition_id WHERE ld.category = 'service_offering_status'),
  3, 'lookup_values: service_offering_status has 3 rows');

SELECT is(
  (SELECT count(*)::int FROM public.lookup_values lv JOIN public.lookup_definitions ld ON ld.id = lv.lookup_definition_id WHERE ld.category = 'service_level_tier'),
  5, 'lookup_values: service_level_tier has 5 rows');

-- =============================================================================
-- SECTION C: tone metadata spot-check (1 representative value per category
--             that carries a tone palette — 50 assertions)
-- =============================================================================

SELECT is(
  (SELECT (lv.metadata ->> 'tone') FROM public.lookup_values lv JOIN public.lookup_definitions ld ON ld.id = lv.lookup_definition_id WHERE ld.category = 'api_status_class' AND lv.value = '5xx'),
  'danger', 'tone: api_status_class.5xx = danger');

SELECT is(
  (SELECT (lv.metadata ->> 'tone') FROM public.lookup_values lv JOIN public.lookup_definitions ld ON ld.id = lv.lookup_definition_id WHERE ld.category = 'email_auth_audit_status' AND lv.value = 'red'),
  'danger', 'tone: email_auth_audit_status.red = danger');

SELECT is(
  (SELECT (lv.metadata ->> 'tone') FROM public.lookup_values lv JOIN public.lookup_definitions ld ON ld.id = lv.lookup_definition_id WHERE ld.category = 'trace_event_source' AND lv.value = 'error_log'),
  'danger', 'tone: trace_event_source.error_log = danger');

SELECT is(
  (SELECT (lv.metadata ->> 'tone') FROM public.lookup_values lv JOIN public.lookup_definitions ld ON ld.id = lv.lookup_definition_id WHERE ld.category = 'workflow_binding_dispatch_outcome' AND lv.value = 'failed'),
  'danger', 'tone: workflow_binding_dispatch_outcome.failed = danger');

SELECT is(
  (SELECT (lv.metadata ->> 'tone') FROM public.lookup_values lv JOIN public.lookup_definitions ld ON ld.id = lv.lookup_definition_id WHERE ld.category = 'workflow_trigger_scope_type' AND lv.value = 'tenant'),
  'info', 'tone: workflow_trigger_scope_type.tenant = info');

SELECT is(
  (SELECT (lv.metadata ->> 'tone') FROM public.lookup_values lv JOIN public.lookup_definitions ld ON ld.id = lv.lookup_definition_id WHERE ld.category = 'cod_entry_status' AND lv.value = 'shortfall'),
  'danger', 'tone: cod_entry_status.shortfall = danger');

SELECT is(
  (SELECT (lv.metadata ->> 'tone') FROM public.lookup_values lv JOIN public.lookup_definitions ld ON ld.id = lv.lookup_definition_id WHERE ld.category = 'settlement_status' AND lv.value = 'posted'),
  'good', 'tone: settlement_status.posted = good');

SELECT is(
  (SELECT (lv.metadata ->> 'tone') FROM public.lookup_values lv JOIN public.lookup_definitions ld ON ld.id = lv.lookup_definition_id WHERE ld.category = 'route_plan_status' AND lv.value = 'published'),
  'good', 'tone: route_plan_status.published = good');

SELECT is(
  (SELECT (lv.metadata ->> 'tone') FROM public.lookup_values lv JOIN public.lookup_definitions ld ON ld.id = lv.lookup_definition_id WHERE ld.category = 'driver_compliance_severity' AND lv.value = 'critical'),
  'danger', 'tone: driver_compliance_severity.critical = danger');

SELECT is(
  (SELECT (lv.metadata ->> 'tone') FROM public.lookup_values lv JOIN public.lookup_definitions ld ON ld.id = lv.lookup_definition_id WHERE ld.category = 'driver_document_kind' AND lv.value = 'license'),
  'info', 'tone: driver_document_kind.license = info');

SELECT is(
  (SELECT (lv.metadata ->> 'tone') FROM public.lookup_values lv JOIN public.lookup_definitions ld ON ld.id = lv.lookup_definition_id WHERE ld.category = 'plugin_status' AND lv.value = 'rollback'),
  'danger', 'tone: plugin_status.rollback = danger');

SELECT is(
  (SELECT (lv.metadata ->> 'tone') FROM public.lookup_values lv JOIN public.lookup_definitions ld ON ld.id = lv.lookup_definition_id WHERE ld.category = 'support_message_direction' AND lv.value = 'outbound'),
  'good', 'tone: support_message_direction.outbound = good');

SELECT is(
  (SELECT (lv.metadata ->> 'tone') FROM public.lookup_values lv JOIN public.lookup_definitions ld ON ld.id = lv.lookup_definition_id WHERE ld.category = 'support_message_role' AND lv.value = 'operator'),
  'good', 'tone: support_message_role.operator = good');

SELECT is(
  (SELECT (lv.metadata ->> 'tone') FROM public.lookup_values lv JOIN public.lookup_definitions ld ON ld.id = lv.lookup_definition_id WHERE ld.category = 'branch_type' AND lv.value = 'hub'),
  'info', 'tone: branch_type.hub = info');

SELECT is(
  (SELECT (lv.metadata ->> 'tone') FROM public.lookup_values lv JOIN public.lookup_definitions ld ON ld.id = lv.lookup_definition_id WHERE ld.category = 'branch_status' AND lv.value = 'out_of_service'),
  'danger', 'tone: branch_status.out_of_service = danger');

SELECT is(
  (SELECT (lv.metadata ->> 'tone') FROM public.lookup_values lv JOIN public.lookup_definitions ld ON ld.id = lv.lookup_definition_id WHERE ld.category = 'branch_zone_role' AND lv.value = 'fallback'),
  'warn', 'tone: branch_zone_role.fallback = warn');

SELECT is(
  (SELECT (lv.metadata ->> 'tone') FROM public.lookup_values lv JOIN public.lookup_definitions ld ON ld.id = lv.lookup_definition_id WHERE ld.category = 'branch_member_role' AND lv.value = 'manager'),
  'good', 'tone: branch_member_role.manager = good');

SELECT is(
  (SELECT (lv.metadata ->> 'tone') FROM public.lookup_values lv JOIN public.lookup_definitions ld ON ld.id = lv.lookup_definition_id WHERE ld.category = 'zone_status' AND lv.value = 'suspended'),
  'warn', 'tone: zone_status.suspended = warn');

SELECT is(
  (SELECT (lv.metadata ->> 'tone') FROM public.lookup_values lv JOIN public.lookup_definitions ld ON ld.id = lv.lookup_definition_id WHERE ld.category = 'zone_district_role' AND lv.value = 'primary'),
  'good', 'tone: zone_district_role.primary = good');

SELECT is(
  (SELECT (lv.metadata ->> 'tone') FROM public.lookup_values lv JOIN public.lookup_definitions ld ON ld.id = lv.lookup_definition_id WHERE ld.category = 'zone_override_status' AND lv.value = 'denied'),
  'danger', 'tone: zone_override_status.denied = danger');

SELECT is(
  (SELECT (lv.metadata ->> 'tone') FROM public.lookup_values lv JOIN public.lookup_definitions ld ON ld.id = lv.lookup_definition_id WHERE ld.category = 'zone_override_kind' AND lv.value = 'restore_zone'),
  'good', 'tone: zone_override_kind.restore_zone = good');

SELECT is(
  (SELECT (lv.metadata ->> 'tone') FROM public.lookup_values lv JOIN public.lookup_definitions ld ON ld.id = lv.lookup_definition_id WHERE ld.category = 'zone_color_token' AND lv.value = 'danger'),
  'danger', 'tone: zone_color_token.danger = danger');

SELECT is(
  (SELECT (lv.metadata ->> 'tone') FROM public.lookup_values lv JOIN public.lookup_definitions ld ON ld.id = lv.lookup_definition_id WHERE ld.category = 'marketplace_offer_status' AND lv.value = 'awarded'),
  'good', 'tone: marketplace_offer_status.awarded = good');

SELECT is(
  (SELECT (lv.metadata ->> 'tone') FROM public.lookup_values lv JOIN public.lookup_definitions ld ON ld.id = lv.lookup_definition_id WHERE ld.category = 'marketplace_award_status' AND lv.value = 'cancelled'),
  'danger', 'tone: marketplace_award_status.cancelled = danger');

SELECT is(
  (SELECT (lv.metadata ->> 'tone') FROM public.lookup_values lv JOIN public.lookup_definitions ld ON ld.id = lv.lookup_definition_id WHERE ld.category = 'marketplace_contract_status' AND lv.value = 'expiring_soon'),
  'warn', 'tone: marketplace_contract_status.expiring_soon = warn');

SELECT is(
  (SELECT (lv.metadata ->> 'tone') FROM public.lookup_values lv JOIN public.lookup_definitions ld ON ld.id = lv.lookup_definition_id WHERE ld.category = 'marketplace_request_status' AND lv.value = 'cancelled'),
  'danger', 'tone: marketplace_request_status.cancelled = danger');

SELECT is(
  (SELECT (lv.metadata ->> 'tone') FROM public.lookup_values lv JOIN public.lookup_definitions ld ON ld.id = lv.lookup_definition_id WHERE ld.category = 'marketplace_request_kind' AND lv.value = 'hazmat'),
  'warn', 'tone: marketplace_request_kind.hazmat = warn');

SELECT is(
  (SELECT (lv.metadata ->> 'tone') FROM public.lookup_values lv JOIN public.lookup_definitions ld ON ld.id = lv.lookup_definition_id WHERE ld.category = 'alert_severity' AND lv.value = 'critical'),
  'danger', 'tone: alert_severity.critical = danger');

SELECT is(
  (SELECT (lv.metadata ->> 'tone') FROM public.lookup_values lv JOIN public.lookup_definitions ld ON ld.id = lv.lookup_definition_id WHERE ld.category = 'alert_channel' AND lv.value = 'pagerduty'),
  'danger', 'tone: alert_channel.pagerduty = danger');

SELECT is(
  (SELECT (lv.metadata ->> 'tone') FROM public.lookup_values lv JOIN public.lookup_definitions ld ON ld.id = lv.lookup_definition_id WHERE ld.category = 'alert_trigger_status' AND lv.value = 'fired'),
  'danger', 'tone: alert_trigger_status.fired = danger (W27-cycle-D §4)');

SELECT is(
  (SELECT (lv.metadata ->> 'tone') FROM public.lookup_values lv JOIN public.lookup_definitions ld ON ld.id = lv.lookup_definition_id WHERE ld.category = 'ops_alert_status' AND lv.value = 'resolved'),
  'good', 'tone: ops_alert_status.resolved = good');

SELECT is(
  (SELECT (lv.metadata ->> 'tone') FROM public.lookup_values lv JOIN public.lookup_definitions ld ON ld.id = lv.lookup_definition_id WHERE ld.category = 'feature_flag_status' AND lv.value = 'on'),
  'good', 'tone: feature_flag_status.on = good');

SELECT is(
  (SELECT (lv.metadata ->> 'tone') FROM public.lookup_values lv JOIN public.lookup_definitions ld ON ld.id = lv.lookup_definition_id WHERE ld.category = 'feature_flag_scope' AND lv.value = 'tenant'),
  'info', 'tone: feature_flag_scope.tenant = info');

SELECT is(
  (SELECT (lv.metadata ->> 'tone') FROM public.lookup_values lv JOIN public.lookup_definitions ld ON ld.id = lv.lookup_definition_id WHERE ld.category = 'vehicle_status' AND lv.value = 'oos'),
  'danger', 'tone: vehicle_status.oos = danger (W35b canonical)');

SELECT is(
  (SELECT (lv.metadata ->> 'tone') FROM public.lookup_values lv JOIN public.lookup_definitions ld ON ld.id = lv.lookup_definition_id WHERE ld.category = 'vehicle_kind' AND lv.value = 'refrigerated'),
  'good', 'tone: vehicle_kind.refrigerated = good');

SELECT is(
  (SELECT (lv.metadata ->> 'tone') FROM public.lookup_values lv JOIN public.lookup_definitions ld ON ld.id = lv.lookup_definition_id WHERE ld.category = 'vehicle_fuel_type' AND lv.value = 'electric'),
  'good', 'tone: vehicle_fuel_type.electric = good');

SELECT is(
  (SELECT (lv.metadata ->> 'tone') FROM public.lookup_values lv JOIN public.lookup_definitions ld ON ld.id = lv.lookup_definition_id WHERE ld.category = 'vehicle_event_type' AND lv.value = 'incident'),
  'danger', 'tone: vehicle_event_type.incident = danger');

SELECT is(
  (SELECT (lv.metadata ->> 'tone') FROM public.lookup_values lv JOIN public.lookup_definitions ld ON ld.id = lv.lookup_definition_id WHERE ld.category = 'vehicle_maintenance_kind' AND lv.value = 'major_repair'),
  'danger', 'tone: vehicle_maintenance_kind.major_repair = danger');

SELECT is(
  (SELECT (lv.metadata ->> 'tone') FROM public.lookup_values lv JOIN public.lookup_definitions ld ON ld.id = lv.lookup_definition_id WHERE ld.category = 'vehicle_maintenance_window_status' AND lv.value = 'completed'),
  'good', 'tone: vehicle_maintenance_window_status.completed = good');

SELECT is(
  (SELECT (lv.metadata ->> 'tone') FROM public.lookup_values lv JOIN public.lookup_definitions ld ON ld.id = lv.lookup_definition_id WHERE ld.category = 'invoice_status' AND lv.value = 'overdue'),
  'danger', 'tone: invoice_status.overdue = danger');

SELECT is(
  (SELECT (lv.metadata ->> 'tone') FROM public.lookup_values lv JOIN public.lookup_definitions ld ON ld.id = lv.lookup_definition_id WHERE ld.category = 'invoice_event_type' AND lv.value = 'voided'),
  'danger', 'tone: invoice_event_type.voided = danger');

SELECT is(
  (SELECT (lv.metadata ->> 'tone') FROM public.lookup_values lv JOIN public.lookup_definitions ld ON ld.id = lv.lookup_definition_id WHERE ld.category = 'subscription_status' AND lv.value = 'paused'),
  'warn', 'tone: subscription_status.paused = warn');

SELECT is(
  (SELECT (lv.metadata ->> 'tone') FROM public.lookup_values lv JOIN public.lookup_definitions ld ON ld.id = lv.lookup_definition_id WHERE ld.category = 'agreement_status' AND lv.value = 'expired'),
  'danger', 'tone: agreement_status.expired = danger');

SELECT is(
  (SELECT (lv.metadata ->> 'tone') FROM public.lookup_values lv JOIN public.lookup_definitions ld ON ld.id = lv.lookup_definition_id WHERE ld.category = 'api_method' AND lv.value = 'DELETE'),
  'danger', 'tone: api_method.DELETE = danger');

SELECT is(
  (SELECT (lv.metadata ->> 'tone') FROM public.lookup_values lv JOIN public.lookup_definitions ld ON ld.id = lv.lookup_definition_id WHERE ld.category = 'provider_health_status' AND lv.value = 'critical'),
  'danger', 'tone: provider_health_status.critical = danger');

SELECT is(
  (SELECT (lv.metadata ->> 'tone') FROM public.lookup_values lv JOIN public.lookup_definitions ld ON ld.id = lv.lookup_definition_id WHERE ld.category = 'import_job_status' AND lv.value = 'failed'),
  'danger', 'tone: import_job_status.failed = danger');

SELECT is(
  (SELECT (lv.metadata ->> 'tone') FROM public.lookup_values lv JOIN public.lookup_definitions ld ON ld.id = lv.lookup_definition_id WHERE ld.category = 'import_job_source' AND lv.value = 'file_upload'),
  'info', 'tone: import_job_source.file_upload = info');

SELECT is(
  (SELECT (lv.metadata ->> 'tone') FROM public.lookup_values lv JOIN public.lookup_definitions ld ON ld.id = lv.lookup_definition_id WHERE ld.category = 'driver_application_status' AND lv.value = 'rejected'),
  'danger', 'tone: driver_application_status.rejected = danger');

SELECT is(
  (SELECT (lv.metadata ->> 'tone') FROM public.lookup_values lv JOIN public.lookup_definitions ld ON ld.id = lv.lookup_definition_id WHERE ld.category = 'driver_application_doc_status' AND lv.value = 'expired'),
  'warn', 'tone: driver_application_doc_status.expired = warn');

SELECT is(
  (SELECT (lv.metadata ->> 'tone') FROM public.lookup_values lv JOIN public.lookup_definitions ld ON ld.id = lv.lookup_definition_id WHERE ld.category = 'service_level_tier' AND lv.value = 'white_glove'),
  'danger', 'tone: service_level_tier.white_glove = danger (W51 alignment)');

-- =============================================================================
-- SECTION D: settings policies — settings_category_registry presence (4 assertions)
-- =============================================================================

SELECT ok(
  EXISTS (SELECT 1 FROM public.settings_category_registry
          WHERE category = 'provider_credential_policy'
            AND requires_schema = TRUE AND requires_global_default = TRUE),
  'settings_category_registry: provider_credential_policy registered (W54-B)');

SELECT ok(
  EXISTS (SELECT 1 FROM public.settings_category_registry
          WHERE category = 'api_gateway_thresholds'
            AND requires_schema = TRUE AND requires_global_default = TRUE),
  'settings_category_registry: api_gateway_thresholds registered (W27-cycle-D)');

SELECT ok(
  EXISTS (SELECT 1 FROM public.settings_category_registry
          WHERE category = 'delivery_slot_policy'
            AND requires_schema = TRUE AND requires_global_default = TRUE),
  'settings_category_registry: delivery_slot_policy registered (W54-C)');

SELECT ok(
  EXISTS (SELECT 1 FROM public.settings_category_registry
          WHERE category = 'geocoding_policy'
            AND requires_schema = TRUE AND requires_global_default = TRUE),
  'settings_category_registry: geocoding_policy registered (W55-Network)');

-- =============================================================================
-- SECTION E: schema_registry active rows (4 assertions)
-- =============================================================================

SELECT ok(
  EXISTS (SELECT 1 FROM public.schema_registry
          WHERE category = 'provider_credential_policy' AND version = 1 AND is_active = TRUE),
  'schema_registry: provider_credential_policy v1 active');

SELECT ok(
  EXISTS (SELECT 1 FROM public.schema_registry
          WHERE category = 'api_gateway_thresholds' AND version = 1 AND is_active = TRUE),
  'schema_registry: api_gateway_thresholds v1 active');

SELECT ok(
  EXISTS (SELECT 1 FROM public.schema_registry
          WHERE category = 'delivery_slot_policy' AND version = 1 AND is_active = TRUE),
  'schema_registry: delivery_slot_policy v1 active');

SELECT ok(
  EXISTS (SELECT 1 FROM public.schema_registry
          WHERE category = 'geocoding_policy' AND version >= 1 AND is_active = TRUE),
  'schema_registry: geocoding_policy active');

-- =============================================================================
-- SECTION F: settings_versions current global rows (4 assertions)
-- =============================================================================

SELECT ok(
  EXISTS (SELECT 1 FROM public.settings_versions
          WHERE category = 'provider_credential_policy'
            AND scope_type = 'global' AND scope_id IS NULL
            AND version = 1
            AND effective_until IS NULL AND approved_at IS NOT NULL),
  'settings_versions: provider_credential_policy global v1 active');

SELECT ok(
  EXISTS (SELECT 1 FROM public.settings_versions
          WHERE category = 'api_gateway_thresholds'
            AND scope_type = 'global' AND scope_id IS NULL
            AND version >= 1
            AND effective_until IS NULL AND approved_at IS NOT NULL),
  'settings_versions: api_gateway_thresholds global active');

SELECT ok(
  EXISTS (SELECT 1 FROM public.settings_versions
          WHERE category = 'delivery_slot_policy'
            AND scope_type = 'global' AND scope_id IS NULL
            AND version = 1
            AND effective_until IS NULL AND approved_at IS NOT NULL),
  'settings_versions: delivery_slot_policy global v1 active');

SELECT ok(
  EXISTS (SELECT 1 FROM public.settings_versions
          WHERE category = 'geocoding_policy'
            AND scope_type = 'global' AND scope_id IS NULL
            AND version >= 1
            AND effective_until IS NULL AND approved_at IS NOT NULL),
  'settings_versions: geocoding_policy global active');

-- =============================================================================
-- SECTION G: settings projection rows (4 assertions)
-- =============================================================================

SELECT ok(
  EXISTS (SELECT 1 FROM public.settings
          WHERE category = 'provider_credential_policy'
            AND scope_type = 'global' AND scope_id IS NULL),
  'settings: provider_credential_policy global projection row exists');

SELECT ok(
  EXISTS (SELECT 1 FROM public.settings
          WHERE category = 'api_gateway_thresholds'
            AND scope_type = 'global' AND scope_id IS NULL),
  'settings: api_gateway_thresholds global projection row exists');

SELECT ok(
  EXISTS (SELECT 1 FROM public.settings
          WHERE category = 'delivery_slot_policy'
            AND scope_type = 'global' AND scope_id IS NULL),
  'settings: delivery_slot_policy global projection row exists');

SELECT ok(
  EXISTS (SELECT 1 FROM public.settings
          WHERE category = 'geocoding_policy'
            AND scope_type = 'global' AND scope_id IS NULL),
  'settings: geocoding_policy global projection row exists');

-- =============================================================================
-- SECTION H: resolve_settings spot-checks on canonical defaults (4 assertions)
-- =============================================================================

SELECT is(
  ((public.resolve_settings('provider_credential_policy', NULL, NULL))->>'expiring_days_threshold')::int,
  30,
  'resolve_settings(provider_credential_policy).expiring_days_threshold = 30 (W54-B canonical)');

SELECT is(
  ((public.resolve_settings('api_gateway_thresholds', NULL, NULL))->>'latency_band_good_boundary_ms')::int,
  300,
  'resolve_settings(api_gateway_thresholds).latency_band_good_boundary_ms = 300 (W27-cycle-D canonical)');

SELECT ok(
  ((public.resolve_settings('delivery_slot_policy', NULL, NULL))->'default_reschedule_offsets') @> '["P1D"]'::jsonb,
  'resolve_settings(delivery_slot_policy).default_reschedule_offsets contains "P1D" (W54-C canonical)');

SELECT is(
  ((public.resolve_settings('geocoding_policy', NULL, NULL))->>'confidence_threshold')::numeric,
  0.85::numeric,
  'resolve_settings(geocoding_policy).confidence_threshold = 0.85 (W55-Network canonical)');

SELECT * FROM finish();

ROLLBACK;
