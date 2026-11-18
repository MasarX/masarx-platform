-- F808 configuration tests; UNEXECUTED until admitted native qualification.
BEGIN;
SET LOCAL search_path TO public, extensions, pg_temp;
SELECT plan(8);

CREATE TEMP TABLE reporting_config_pair ON COMMIT DROP AS
SELECT s.cached_value, current_version.value AS current_value,
       current_version.schema_version, introduced.value,
       introduced.schema_version AS introduced_schema_version,
       corrected.value AS corrected_value,
       previous.value AS previous_value
FROM public.settings s
JOIN public.settings_versions current_version ON current_version.id = s.settings_version_id
 AND current_version.scope_hash = s.scope_hash AND current_version.category = s.category
 AND current_version.scope_type = s.scope_type AND current_version.scope_id IS NOT DISTINCT FROM s.scope_id
 AND current_version.effective_until IS NULL AND current_version.effective_from <= now()
 AND current_version.approved_at IS NOT NULL
JOIN public.schema_registry current_schema_row
 ON current_schema_row.category = current_version.category
 AND current_schema_row.version = current_version.schema_version
LEFT JOIN LATERAL (
  SELECT candidate.value, candidate.version, candidate.schema_version
  FROM public.settings_versions candidate
  WHERE candidate.category = s.category AND candidate.scope_hash = s.scope_hash
    AND candidate.scope_type = s.scope_type AND candidate.scope_id IS NOT DISTINCT FROM s.scope_id
    AND candidate.change_reason = 'Restore F808 reporting without overriding explicit dashboard policy'
  ORDER BY candidate.version DESC LIMIT 1
) introduced ON TRUE
LEFT JOIN LATERAL (
  SELECT candidate.value
  FROM public.settings_versions candidate
  WHERE candidate.category = s.category AND candidate.scope_hash = s.scope_hash
    AND candidate.scope_type = s.scope_type AND candidate.scope_id IS NOT DISTINCT FROM s.scope_id
    AND candidate.change_reason = 'Correct F808 reporting status keys to canonical shipment taxonomy'
  ORDER BY candidate.version DESC LIMIT 1
) corrected ON TRUE
LEFT JOIN LATERAL (
  SELECT candidate.value FROM public.settings_versions candidate
  WHERE candidate.category = s.category AND candidate.scope_hash = s.scope_hash
    AND candidate.scope_type = s.scope_type AND candidate.scope_id IS NOT DISTINCT FROM s.scope_id
    AND candidate.version < introduced.version
  ORDER BY candidate.version DESC LIMIT 1
) previous ON TRUE
WHERE s.category = 'ui_dashboard_config'
 AND s.scope_type = public.get_root_scope_type_key_v1() AND s.scope_id IS NULL;

SELECT is((SELECT count(*)::int FROM reporting_config_pair), 1, 'one valid canonical root dashboard pair');
SELECT ok((SELECT cached_value IS NOT DISTINCT FROM current_value FROM reporting_config_pair),
  'current dashboard pointer and cache agree independently of later policy changes');
SELECT ok((SELECT CASE WHEN value IS NULL THEN current_value ? 'shipment_reporting'
  ELSE previous_value IS NOT NULL END FROM reporting_config_pair),
  'introduced reporting has a predecessor or explicit current reporting explains the no-op');
SELECT ok((SELECT value IS NULL OR EXISTS(
  SELECT 1 FROM public.schema_registry schema_row
  WHERE schema_row.category = 'ui_dashboard_config'
    AND schema_row.version = pair.introduced_schema_version
    AND schema_row.schema#>'{properties,shipment_reporting}' IS NOT NULL)
  FROM reporting_config_pair pair), 'introduced version references its preserved reporting schema');
SELECT ok((SELECT value IS NULL OR value - 'shipment_reporting' = previous_value - 'shipment_reporting'
  FROM reporting_config_pair), 'migration-owned version preserved preceding unrelated policy');
SELECT ok((SELECT value IS NULL OR jsonb_array_length(value#>'{shipment_reporting,statuses}') = 7
  FROM reporting_config_pair), 'migration-owned defaults contain seven source statuses');
SELECT ok((SELECT corrected_value IS NULL OR (
  corrected_value#>'{shipment_reporting,active_status_keys}' = '["in_transit","out_for_delivery"]'::jsonb
  AND corrected_value#>>'{shipment_reporting,delivered_status_key}' = 'delivered'
  AND corrected_value#>>'{shipment_reporting,pending_status_key}' = 'pending'
  AND corrected_value#>>'{shipment_reporting,exception_status_key}' = 'delivery_failed'
  AND corrected_value#>'{shipment_reporting,statuses}' @>
    '[{"key":"delivery_failed","label_key":"exceptions"},{"key":"return_to_origin","label_key":"returned"}]'::jsonb)
  FROM reporting_config_pair), 'corrected named roles use canonical shipment status keys and preserve labels');
SELECT ok((SELECT value IS NULL OR (
  value#>>'{shipment_reporting,resource}' = 'shipments'
  AND value#>>'{shipment_reporting,status_filter}' = 'status'
  AND value#>'{shipment_reporting,app_keys}' = '["console"]'::jsonb)
  FROM reporting_config_pair), 'introduced reporting stays Console-only and registry-driven');

SELECT * FROM finish();
ROLLBACK;
