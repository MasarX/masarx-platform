-- Plan: PLAN-202601-schema-audit-improvements / Step: S95
-- Migration: Expand decision_category lookup values for decision_log writers
-- Purpose:
--   - Prevent runtime failures from lookup_column_contracts enforcement when code logs decisions
--     under categories that were not seeded into lookup_values.
--   - Keep decision taxonomy SSOT + row-driven (no per-table hardcoded CHECK enums).
-- Date: 2026-01-21

BEGIN;

SET search_path TO public, extensions, pg_temp;

-- Defensive: decision_category should already exist (seeded), but keep idempotent.
INSERT INTO public.lookup_definitions (category, description, owner_role, approval_policy, is_mutable)
VALUES ('decision_category', 'Business decision categories for decision_log', 'engineering', 'tier_1', FALSE)
ON CONFLICT (category) DO NOTHING;

INSERT INTO public.lookup_values (
  lookup_definition_id,
  value,
  label,
  description,
  sort_order,
  is_default,
  status
)
SELECT
  d.id,
  v.value,
  v.label,
  v.description,
  v.sort_order,
  FALSE,
  'active'
FROM public.lookup_definitions d
JOIN (
  VALUES
    ('outbound_call', 'Outbound Call', 'Outbound HTTP execution and polling decisions', 140),
    ('edge_dispatch', 'Edge Dispatch', 'Edge execution and dispatch decisions', 150),
    ('api_gateway_postprocess', 'API Gateway Postprocess', 'API gateway post-processing decisions', 160),
    ('webhook_http_response', 'Webhook HTTP Response', 'Webhook HTTP response emit/replay decisions', 170),
    ('http_response_emitted', 'HTTP Response Emitted', 'HTTP response emitted decisions (webhook ingress/ack)', 175),
    ('http_response_replayed', 'HTTP Response Replayed', 'HTTP response replay decisions', 176),
    ('provider_callback', 'Provider Callback', 'Provider callback handling decisions', 180),
    ('provider_usage_tracking', 'Provider Usage Tracking', 'Provider usage/budget tracking decisions', 190),
    ('shipment_create', 'Shipment Create', 'Shipment creation and SSOT projection decisions', 200),
    ('label_job', 'Label Job', 'Label generation and orchestration decisions', 210),
    ('label_print', 'Label Print', 'Label print/finalize decisions', 220),
    ('label_rendering', 'Label Rendering', 'Label rendering pipeline decisions', 230),
    ('label_render_slo', 'Label Render SLO', 'Label rendering SLO/latency decisions', 240),
    ('communication_reply', 'Communication Reply', 'Inbound communication reply processing decisions', 250),
    ('comms_whatsapp', 'Comms WhatsApp', 'WhatsApp channel outbound/response decisions', 260),
    ('domain_event', 'Domain Event', 'Domain event pipeline decisions', 270),
    ('workflow', 'Workflow', 'Workflow engine runtime decisions', 280),
    ('workflow_processing', 'Workflow Processing', 'Workflow processing/dispatch decisions', 290),
    ('alert_evaluation', 'Alert Evaluation', 'Alert rule evaluation decisions', 300),
    ('alert_dispatch', 'Alert Dispatch', 'Alert dispatch/routing decisions', 310),
    ('manual_review', 'Manual Review', 'Manual review lifecycle decisions', 320),
    ('address_resolution', 'Address Resolution', 'Address normalization and resolution decisions', 330),
    ('geocoding_attempt', 'Geocoding Attempt', 'Geocoding attempt logging decisions', 340),
    ('settings', 'Settings', 'Settings registry and governance decisions', 350),
    ('security', 'Security', 'Security/authorization decisions', 360),
    ('campaign_dispatch', 'Campaign Dispatch', 'Campaign dispatch decisions', 370)
) AS v(value, label, description, sort_order)
  ON d.category = 'decision_category'
ON CONFLICT (lookup_definition_id, value) DO NOTHING;

COMMIT;

