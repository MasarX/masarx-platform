-- Fixup: register fleet maintenance decision log lookup values.
-- Scope: schedule/complete/cancel maintenance RPCs write decision_log rows through
-- lookup-enforced decision_category and decision_outcome contracts.

BEGIN;
SELECT pg_advisory_lock(hashtext('202605031450_fleet_maintenance_decision_lookup_fixup_v1'));
SET search_path TO public, extensions, pg_temp;
SET LOCAL lock_timeout = '30s';

INSERT INTO public.lookup_values (
  lookup_definition_id,
  value,
  label,
  description,
  sort_order,
  is_default,
  status,
  metadata
)
SELECT
  ld.id,
  v.value,
  v.label,
  v.description,
  v.sort_order,
  FALSE,
  'active',
  v.metadata::jsonb
FROM public.lookup_definitions ld
CROSS JOIN (VALUES
  (
    'fleet.driver_assigned',
    'Fleet Driver Assigned',
    'Vehicle driver assignment decisions',
    640,
    '{"domain":"fleet","resource_type":"vehicle_assignment","operation":"assign"}'
  ),
  (
    'fleet.driver_unassigned',
    'Fleet Driver Unassigned',
    'Vehicle driver unassignment decisions',
    650,
    '{"domain":"fleet","resource_type":"vehicle_assignment","operation":"unassign"}'
  ),
  (
    'fleet.vehicle_oos_marked',
    'Fleet Vehicle OOS Marked',
    'Vehicle out-of-service marking decisions',
    660,
    '{"domain":"fleet","resource_type":"vehicle","operation":"mark_oos"}'
  ),
  (
    'fleet.vehicle_oos_restored',
    'Fleet Vehicle OOS Restored',
    'Vehicle out-of-service restore decisions',
    670,
    '{"domain":"fleet","resource_type":"vehicle","operation":"restore"}'
  ),
  (
    'fleet.vehicle_event_recorded',
    'Fleet Vehicle Event Recorded',
    'Vehicle event recording decisions',
    680,
    '{"domain":"fleet","resource_type":"vehicle_event","operation":"record"}'
  ),
  (
    'fleet.maintenance_scheduled',
    'Fleet Maintenance Scheduled',
    'Vehicle maintenance window scheduling decisions',
    700,
    '{"domain":"fleet","resource_type":"vehicle_maintenance_window","operation":"schedule"}'
  ),
  (
    'fleet.maintenance_completed',
    'Fleet Maintenance Completed',
    'Vehicle maintenance window completion decisions',
    710,
    '{"domain":"fleet","resource_type":"vehicle_maintenance_window","operation":"complete"}'
  ),
  (
    'fleet.maintenance_cancelled',
    'Fleet Maintenance Cancelled',
    'Vehicle maintenance window cancellation decisions',
    720,
    '{"domain":"fleet","resource_type":"vehicle_maintenance_window","operation":"cancel"}'
  ),
  (
    'fleet.driver_suspended',
    'Fleet Driver Suspended',
    'Driver suspension decisions',
    730,
    '{"domain":"fleet","resource_type":"driver_profile","operation":"suspend"}'
  ),
  (
    'fleet.driver_restored',
    'Fleet Driver Restored',
    'Driver restoration decisions',
    740,
    '{"domain":"fleet","resource_type":"driver_profile","operation":"restore"}'
  ),
  (
    'fleet.hours_of_service_recorded',
    'Fleet Hours Of Service Recorded',
    'Driver hours-of-service recording decisions',
    750,
    '{"domain":"fleet","resource_type":"driver_hours_of_service","operation":"record"}'
  ),
  (
    'compliance.driver_document_verified',
    'Compliance Driver Document Verified',
    'Driver document verification decisions',
    760,
    '{"domain":"compliance","resource_type":"driver_document","operation":"verify"}'
  ),
  (
    'compliance.driver_document_rejected',
    'Compliance Driver Document Rejected',
    'Driver document rejection decisions',
    770,
    '{"domain":"compliance","resource_type":"driver_document","operation":"reject"}'
  ),
  (
    'compliance.driver_event_recorded',
    'Compliance Driver Event Recorded',
    'Driver compliance event recording decisions',
    780,
    '{"domain":"compliance","resource_type":"driver_compliance_event","operation":"record"}'
  )
) AS v(value, label, description, sort_order, metadata)
WHERE ld.category = 'decision_category'
ON CONFLICT (lookup_definition_id, value) DO UPDATE
SET label = EXCLUDED.label,
    description = EXCLUDED.description,
    sort_order = EXCLUDED.sort_order,
    status = 'active',
    retired_at = NULL,
    metadata = EXCLUDED.metadata,
    updated_at = now();

INSERT INTO public.lookup_values (
  lookup_definition_id,
  value,
  label,
  description,
  sort_order,
  is_default,
  status,
  metadata
)
SELECT
  ld.id,
  v.value,
  v.label,
  v.description,
  v.sort_order,
  FALSE,
  'active',
  v.metadata::jsonb
FROM public.lookup_definitions ld
CROSS JOIN (VALUES
  (
    'assigned',
    'Assigned',
    'Fleet assignment completed',
    560,
    '{"domain":"fleet"}'
  ),
  (
    'closed',
    'Closed',
    'Open fleet assignment closed',
    570,
    '{"domain":"fleet"}'
  ),
  (
    'noop',
    'No-op',
    'No state change required',
    580,
    '{"domain":"fleet"}'
  ),
  (
    'oos',
    'Out Of Service',
    'Vehicle marked out of service',
    590,
    '{"domain":"fleet"}'
  ),
  (
    'restored',
    'Restored',
    'Fleet resource restored',
    600,
    '{"domain":"fleet"}'
  ),
  (
    'recorded',
    'Recorded',
    'Operational record appended',
    605,
    '{"domain":"operations"}'
  ),
  (
    'scheduled',
    'Scheduled',
    'Maintenance window scheduled',
    610,
    '{"domain":"fleet","resource_type":"vehicle_maintenance_window"}'
  ),
  (
    'completed',
    'Completed',
    'Maintenance window completed',
    620,
    '{"domain":"fleet","resource_type":"vehicle_maintenance_window"}'
  ),
  (
    'cancelled',
    'Cancelled',
    'Maintenance window cancelled',
    630,
    '{"domain":"fleet","resource_type":"vehicle_maintenance_window"}'
  ),
  (
    'verified',
    'Verified',
    'Driver document verified',
    640,
    '{"domain":"compliance","resource_type":"driver_document"}'
  ),
  (
    'rejected',
    'Rejected',
    'Driver document rejected',
    650,
    '{"domain":"compliance","resource_type":"driver_document"}'
  ),
  (
    'suspended',
    'Suspended',
    'Driver suspended',
    660,
    '{"domain":"fleet","resource_type":"driver_profile"}'
  )
) AS v(value, label, description, sort_order, metadata)
WHERE ld.category = 'decision_outcome'
ON CONFLICT (lookup_definition_id, value) DO UPDATE
SET label = EXCLUDED.label,
    description = EXCLUDED.description,
    sort_order = EXCLUDED.sort_order,
    status = 'active',
    retired_at = NULL,
    metadata = EXCLUDED.metadata,
    updated_at = now();

SELECT pg_advisory_unlock(hashtext('202605031450_fleet_maintenance_decision_lookup_fixup_v1'));
COMMIT;
