BEGIN;

-- The lookup-column contract for decision_log is intentionally fail-closed.
-- Keep it aligned with canonical decision literals emitted by existing RPCs.
WITH categories(value, label, sort_order) AS (
  VALUES
    ('alerts.acknowledge', 'Alerts Acknowledge', 990),
    ('branches.capacity_window_set', 'Branch Capacity Window Set', 1000),
    ('branches.coverage_window_upsert', 'Branch Coverage Window Upsert', 1010),
    ('branches.create', 'Branch Create', 1020),
    ('branches.lifecycle', 'Branch Lifecycle', 1030),
    ('branches.member_add', 'Branch Member Add', 1040),
    ('branches.member_remove', 'Branch Member Remove', 1050),
    ('branches.update', 'Branch Update', 1060),
    ('branches.zone_assign', 'Branch Zone Assign', 1070),
    ('branches.zone_unassign', 'Branch Zone Unassign', 1080),
    ('support_case.assign', 'Support Case Assign', 1090),
    ('support_case.create', 'Support Case Create', 1100),
    ('support_case.message', 'Support Case Message', 1110),
    ('support_case.reopen', 'Support Case Reopen', 1120),
    ('support_case.resolve', 'Support Case Resolve', 1130),
    ('support_case.tag', 'Support Case Tag', 1140),
    ('support_case.update', 'Support Case Update', 1150),
    ('zones.create', 'Zone Create', 1160),
    ('zones.district_add', 'Zone District Add', 1170),
    ('zones.district_remove', 'Zone District Remove', 1180)
),
definition AS (
  SELECT id
    FROM public.lookup_definitions
   WHERE category = 'decision_category'
   LIMIT 1
)
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
  d.id,
  c.value,
  c.label,
  'Decision category emitted by canonical RPCs.',
  c.sort_order,
  FALSE,
  'active',
  jsonb_build_object('source', 'decision_lookup_literal_coverage_repair_v1')
FROM definition d
CROSS JOIN categories c
ON CONFLICT (lookup_definition_id, value) DO NOTHING;

WITH outcomes(value, label, sort_order) AS (
  VALUES
    ('acknowledged', 'Acknowledged', 990),
    ('accepted', 'Accepted', 1000),
    ('add', 'Add', 1005),
    ('already_sorted', 'Already Sorted', 1010),
    ('ambiguous', 'Ambiguous', 1020),
    ('async_pending', 'Async Pending', 1030),
    ('attempt_succeeded', 'Attempt Succeeded', 1040),
    ('breached', 'Breached', 1050),
    ('created', 'Created', 1060),
    ('disabled', 'Disabled', 1070),
    ('dispatched', 'Dispatched', 1080),
    ('duplicate_webhook', 'Duplicate Webhook', 1090),
    ('enqueued', 'Enqueued', 1100),
    ('enrolled', 'Enrolled', 1110),
    ('error', 'Error', 1120),
    ('exception', 'Exception', 1130),
    ('failed', 'Failed', 1140),
    ('failed_over', 'Failed Over', 1150),
    ('fallback_required', 'Fallback Required', 1160),
    ('invalid_canonical_status', 'Invalid Canonical Status', 1170),
    ('invalid_status', 'Invalid Status', 1180),
    ('manual_review_required', 'Manual Review Required', 1190),
    ('mapped', 'Mapped', 1200),
    ('marked_oos', 'Marked Out Of Service', 1210),
    ('matched', 'Matched', 1220),
    ('mismatch', 'Mismatch', 1230),
    ('missing', 'Missing', 1240),
    ('missing_campaign_key', 'Missing Campaign Key', 1250),
    ('missing_status', 'Missing Status', 1260),
    ('missing_tracking', 'Missing Tracking', 1270),
    ('permanently_failed', 'Permanently Failed', 1280),
    ('policy_disabled', 'Policy Disabled', 1290),
    ('published', 'Published', 1300),
    ('queued', 'Queued', 1310),
    ('rate_limited', 'Rate Limited', 1320),
    ('reassigned', 'Reassigned', 1330),
    ('recovered', 'Recovered', 1340),
    ('remove', 'Remove', 1345),
    ('render_failed', 'Render Failed', 1350),
    ('render_retry_scheduled', 'Render Retry Scheduled', 1360),
    ('render_succeeded', 'Render Succeeded', 1370),
    ('reopened', 'Reopened', 1380),
    ('requeued', 'Requeued', 1390),
    ('resolved', 'Resolved', 1400),
    ('resorted', 'Resorted', 1410),
    ('response_failed', 'Response Failed', 1420),
    ('response_replayed', 'Response Replayed', 1430),
    ('reused_existing_shipment', 'Reused Existing Shipment', 1440),
    ('sent', 'Sent', 1450),
    ('shipment_not_found', 'Shipment Not Found', 1460),
    ('skipped', 'Skipped', 1470),
    ('skipped_policy_invalid', 'Skipped Policy Invalid', 1480),
    ('skipped_policy_missing', 'Skipped Policy Missing', 1490),
    ('status_changed', 'Status Changed', 1500),
    ('succeeded', 'Succeeded', 1510),
    ('success', 'Success', 1520),
    ('unassigned', 'Unassigned', 1530),
    ('unmapped', 'Unmapped', 1540),
    ('unmapped_status', 'Unmapped Status', 1550),
    ('updated', 'Updated', 1560),
    ('workflow_enqueued', 'Workflow Enqueued', 1570),
    ('workflow_started', 'Workflow Started', 1580)
),
definition AS (
  SELECT id
    FROM public.lookup_definitions
   WHERE category = 'decision_outcome'
   LIMIT 1
)
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
  d.id,
  o.value,
  o.label,
  'Decision outcome emitted by canonical RPCs.',
  o.sort_order,
  FALSE,
  'active',
  jsonb_build_object('source', 'decision_lookup_literal_coverage_repair_v1')
FROM definition d
CROSS JOIN outcomes o
ON CONFLICT (lookup_definition_id, value) DO NOTHING;

COMMIT;
