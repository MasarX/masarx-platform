-- Fixup: move late lifecycle enum checks to lookup_column_contracts.
-- Objective: enum-like values stay row-driven through lookup_definitions /
-- lookup_values instead of literal CHECK allowlists.

BEGIN;
SELECT pg_advisory_lock(hashtext('202605031470_lifecycle_lookup_contracts_no_literal_checks_v1'));
SET search_path TO public, extensions, pg_temp;
SET LOCAL lock_timeout = '30s';

INSERT INTO public.lookup_definitions (category, description, owner_role, approval_policy, is_mutable)
VALUES
  ('support_case_tag_action', 'Support case tag action taxonomy', 'support', 'tier_1', false),
  ('ops_alert_event_type', 'Operations alert event taxonomy', 'operations', 'tier_1', false),
  ('feature_flag_kill_event_type', 'Feature flag kill event taxonomy', 'engineering', 'tier_1', false),
  ('capability_grant_status', 'Capability grant request lifecycle status', 'operations', 'tier_1', false),
  ('lookup_value_revision_action', 'Lookup value revision action taxonomy', 'operations', 'tier_1', false),
  ('webhook_inbox_replay_action', 'Webhook inbox replay action taxonomy', 'engineering', 'tier_1', false),
  ('bank_recon_match_status', 'Bank reconciliation match lifecycle status', 'finance', 'tier_1', false)
ON CONFLICT (category) DO UPDATE
SET description = EXCLUDED.description,
    owner_role = EXCLUDED.owner_role,
    approval_policy = EXCLUDED.approval_policy,
    is_mutable = EXCLUDED.is_mutable,
    updated_at = now();

INSERT INTO public.lookup_values (lookup_definition_id, value, label, sort_order, is_default, status)
SELECT ld.id, v.value, v.label, v.sort_order, v.is_default, 'active'
FROM public.lookup_definitions ld
JOIN (VALUES
  ('scope_type', 'platform', 'Platform', 15, false),

  ('support_case_tag_action', 'add', 'Add', 10, true),
  ('support_case_tag_action', 'remove', 'Remove', 20, false),

  ('ops_alert_event_type', 'acknowledged', 'Acknowledged', 10, false),
  ('ops_alert_event_type', 'resolved', 'Resolved', 20, false),
  ('ops_alert_event_type', 'reopened', 'Reopened', 30, false),
  ('ops_alert_event_type', 'escalated', 'Escalated', 40, false),

  ('feature_flag_kill_event_type', 'engaged', 'Engaged', 10, false),
  ('feature_flag_kill_event_type', 'released', 'Released', 20, false),
  ('feature_flag_kill_event_type', 'rollout_changed', 'Rollout changed', 30, false),
  ('feature_flag_kill_event_type', 'toggled', 'Toggled', 40, false),

  ('capability_grant_status', 'pending', 'Pending', 10, true),
  ('capability_grant_status', 'approved', 'Approved', 20, false),
  ('capability_grant_status', 'denied', 'Denied', 30, false),
  ('capability_grant_status', 'cancelled', 'Cancelled', 40, false),

  ('lookup_value_revision_action', 'create', 'Create', 10, false),
  ('lookup_value_revision_action', 'update', 'Update', 20, false),
  ('lookup_value_revision_action', 'archive', 'Archive', 30, false),
  ('lookup_value_revision_action', 'promote', 'Promote', 40, false),

  ('webhook_inbox_replay_action', 'replay', 'Replay', 10, true),
  ('webhook_inbox_replay_action', 'force_status', 'Force status', 20, false),

  ('job_status', 'pending', 'Pending', 10, true),
  ('job_status', 'processing', 'Processing', 20, false),
  ('job_status', 'completed', 'Completed', 30, false),
  ('job_status', 'failed', 'Failed', 40, false),

  ('bank_recon_match_status', 'matched', 'Matched', 10, true),
  ('bank_recon_match_status', 'unmatched', 'Unmatched', 20, false),

  ('import_job_source', 'file_upload', 'File upload', 10, true),
  ('import_job_source', 'api', 'API', 20, false),
  ('import_job_source', 'manual', 'Manual', 30, false),

  ('import_job_status', 'queued', 'Queued', 10, true),
  ('import_job_status', 'running', 'Running', 20, false),
  ('import_job_status', 'completed', 'Completed', 30, false),
  ('import_job_status', 'failed', 'Failed', 40, false),
  ('import_job_status', 'cancelled', 'Cancelled', 50, false)
) AS v(category, value, label, sort_order, is_default)
  ON v.category = ld.category
ON CONFLICT (lookup_definition_id, value) DO UPDATE
SET label = EXCLUDED.label,
    sort_order = EXCLUDED.sort_order,
    is_default = EXCLUDED.is_default,
    status = 'active',
    retired_at = NULL,
    updated_at = now();

INSERT INTO public.lookup_column_contracts (
  table_schema,
  table_name,
  column_name,
  lookup_category,
  allowed_values
)
VALUES
  ('public', 'lookup_definitions', 'scope_type', 'scope_type', ARRAY['global','tenant']),
  ('public', 'support_case_tags', 'action', 'support_case_tag_action', ARRAY['add','remove']),
  ('public', 'ops_alert_events', 'event_type', 'ops_alert_event_type', ARRAY['acknowledged','resolved','reopened','escalated']),
  ('public', 'feature_flag_kill_events', 'event_type', 'feature_flag_kill_event_type', ARRAY['engaged','released','rollout_changed','toggled']),
  ('public', 'capability_grant_requests', 'scope_type', 'scope_type', ARRAY['global','platform','tenant','client','sender','source']),
  ('public', 'capability_grant_requests', 'status', 'capability_grant_status', ARRAY['pending','approved','denied','cancelled']),
  ('public', 'lookup_value_revisions', 'action', 'lookup_value_revision_action', ARRAY['create','update','archive','promote']),
  ('public', 'webhook_inbox_replays', 'action', 'webhook_inbox_replay_action', ARRAY['replay','force_status']),
  ('public', 'revocation_audit', 'status', 'job_status', ARRAY['pending','processing','completed','failed']),
  ('public', 'workflow_binding_registrations', 'scope_type', 'scope_type', ARRAY['global','tenant','client','sender']),
  ('public', 'bank_recon_matches', 'status', 'bank_recon_match_status', ARRAY['matched','unmatched']),
  ('public', 'workflow_binding_simulations', 'scope_type', 'scope_type', ARRAY['global','tenant','client','sender']),
  ('public', 'password_reset_intents', 'status', 'job_status', ARRAY['pending','processing','completed','failed']),
  ('public', 'import_jobs', 'source', 'import_job_source', ARRAY['file_upload','api','manual']),
  ('public', 'import_jobs', 'status', 'import_job_status', ARRAY['queued','running','completed','failed','cancelled'])
ON CONFLICT ON CONSTRAINT lookup_column_contracts_unique DO UPDATE
SET lookup_category = EXCLUDED.lookup_category,
    allowed_values = EXCLUDED.allowed_values,
    allow_inactive = false,
    updated_at = now();

SELECT public.apply_lookup_column_contracts('public');

ALTER TABLE public.lookup_definitions
  DROP CONSTRAINT IF EXISTS lookup_definitions_scope_type_ck;
ALTER TABLE public.support_case_tags
  DROP CONSTRAINT IF EXISTS support_case_tags_action_ck;
ALTER TABLE public.ops_alert_events
  DROP CONSTRAINT IF EXISTS ops_alert_events_event_type_ck;
ALTER TABLE public.feature_flag_kill_events
  DROP CONSTRAINT IF EXISTS feature_flag_kill_events_event_type_ck;
ALTER TABLE public.capability_grant_requests
  DROP CONSTRAINT IF EXISTS capability_grant_requests_scope_type_ck,
  DROP CONSTRAINT IF EXISTS capability_grant_requests_status_ck;
ALTER TABLE public.lookup_value_revisions
  DROP CONSTRAINT IF EXISTS lookup_value_revisions_action_ck;
ALTER TABLE public.webhook_inbox_replays
  DROP CONSTRAINT IF EXISTS webhook_inbox_replays_action_ck;
ALTER TABLE public.revocation_audit
  DROP CONSTRAINT IF EXISTS revocation_audit_status_ck;
ALTER TABLE public.workflow_binding_registrations
  DROP CONSTRAINT IF EXISTS workflow_binding_registrations_scope_ck;
ALTER TABLE public.bank_recon_matches
  DROP CONSTRAINT IF EXISTS bank_recon_matches_status_ck;
ALTER TABLE public.workflow_binding_simulations
  DROP CONSTRAINT IF EXISTS workflow_binding_simulations_scope_ck;
ALTER TABLE public.password_reset_intents
  DROP CONSTRAINT IF EXISTS password_reset_intents_status_ck;
ALTER TABLE public.import_jobs
  DROP CONSTRAINT IF EXISTS import_jobs_source_ck,
  DROP CONSTRAINT IF EXISTS import_jobs_status_ck;

SELECT pg_advisory_unlock(hashtext('202605031470_lifecycle_lookup_contracts_no_literal_checks_v1'));
COMMIT;
