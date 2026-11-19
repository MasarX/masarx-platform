// intake.js — webhook_sources, webhook_inbox, webhook_log, webhook_rules, marketing_demo_intake events, tenant_signup_requests
// Anchored: AGENTS.md line 28 (public/shared edge ingress fail-closed); marketing-lead-intake edge fn.
//
// webhook_sources mirrors public.webhook_sources from
//   supabase/migrations/202510110004_webhook_integration.sql:185-208
// (organization_id, source_identifier UNIQUE, name, provider_type, auth_token,
//  mapping_config_id, rate_limit_per_hour, enabled). RLS gated by
//  webhooks.read / webhooks.write per 202601071220:110.
//
// webhook_rules mirrors public.webhook_rules from the same migration L248+
// (webhook_source_id FK, event_type, name, priority, mapping_config_id,
//  workflow_template_id, domain_category, enabled). RLS gated by
//  webhooks.read / webhooks.write per 202601071220:113.
//
// Legacy demo fields (`sender_id`, `endpoint`, `hmac_required`, `polling_enabled`,
// `status`) are kept for backward compat with the existing intake monitor and
// webhook tester so we don't regress those modules; the canonical fields
// drive the new operator surfaces under /integrations/sources + /rules.

const now = new Date('2026-04-25T13:30:00Z').getTime();
const minutesAgo = (m) => new Date(now - m * 60000).toISOString();

export const webhook_sources = [
  {
    id: 'whs_exampleparcel_ksa',
    organization_id: 'org_rashed',
    source_identifier: 'exampleparcel-ksa-prod',
    name: 'Exampleparcel KSA — production',
    provider_type: 'shopify',
    auth_token: '••••••••••••AKIA9281',
    mapping_config_id: 'mc_examplemarket_ksa_v3_in',
    rate_limit_per_hour: 5000,
    enabled: true,
    // Legacy / display-only fields kept for the existing intake monitor.
    sender_id: 'snd_examplemarket_jed_warehouse',
    endpoint: '/v1/webhook/exampleparcel-ksa',
    hmac_required: true,
    polling_enabled: false,
    status: 'active',
    last_event_at: minutesAgo(5),
  },
  {
    id: 'whs_examplemart_ksa',
    organization_id: 'org_rashed',
    source_identifier: 'examplemart-ksa-prod',
    name: 'Examplemart KSA — production',
    provider_type: 'woocommerce',
    auth_token: '••••••••••••EXAMPLEMART4419',
    mapping_config_id: 'mc_examplemarket_ksa_v3_in',
    rate_limit_per_hour: 3000,
    enabled: true,
    sender_id: 'snd_examplemart_ruh_dc',
    endpoint: '/v1/webhook/examplemart-ksa',
    hmac_required: true,
    polling_enabled: false,
    status: 'active',
    last_event_at: minutesAgo(11),
  },
  {
    id: 'whs_exampleoutlet',
    organization_id: 'org_rashed',
    source_identifier: 'exampleoutlet-erp',
    name: 'Exampleoutlet ERP bridge',
    provider_type: 'custom_erp',
    auth_token: '••••••••••••JRR0091',
    mapping_config_id: 'mc_exampledepot_resp',
    rate_limit_per_hour: 1000,
    enabled: true,
    sender_id: 'snd_exampleoutlet_main',
    endpoint: '/v1/webhook/exampleoutlet',
    hmac_required: true,
    polling_enabled: false,
    status: 'active',
    last_event_at: minutesAgo(45),
  },
  {
    id: 'whs_exampledepot_carrier',
    organization_id: 'org_rashed',
    source_identifier: 'exampledepot-carrier-callback',
    name: 'Exampledepot carrier callbacks',
    provider_type: 'delivery_provider',
    auth_token: '••••••••••••NQL7711',
    mapping_config_id: 'mc_exampledepot_resp',
    rate_limit_per_hour: 2500,
    enabled: false,
    sender_id: null,
    endpoint: '/v1/webhook/exampledepot',
    hmac_required: true,
    polling_enabled: false,
    status: 'paused',
    last_event_at: null,
  },
];

// Routing rules — one per active webhook_source, plus a generic catch-all
// shipment.updated rule that routes to the amend/cancel template. Mirrors
// public.webhook_rules contract:
//   webhook_source_id FK -> webhook_sources.id
//   event_type        e.g. "shipment.created", "shipment.updated"
//   priority          int (lower = higher priority during dispatch)
//   workflow_template_id -> workflow_templates.id
//   domain_category   service domain ('shipping', 'finance', 'comms', ...)
//   enabled           bool
//
// W18-4 schema-drift closure (see __audit__/SCHEMA-DRIFT/INTEGRATIONS.md §2):
// Aligned to canonical `public.webhook_rules` columns
// (supabase/migrations/202510110004_webhook_integration.sql:248-259):
//   • RENAMED: updated_at -> created_at (canonical column; webhook_rules has
//     no `updated_at` column).
export const webhook_rules = [
  {
    id: 'wbr_exampleparcel_create',
    webhook_source_id: 'whs_exampleparcel_ksa',
    name: 'Exampleparcel — shipment.created → intake',
    event_type: 'shipment.created',
    priority: 10,
    mapping_config_id: 'mc_examplemarket_ksa_v3_in',
    workflow_template_id: 'tpl_intake_exampleparcel',
    domain_category: 'shipping',
    enabled: true,
    created_at: '2026-04-22T10:00:00Z',
  },
  {
    id: 'wbr_examplemart_create',
    webhook_source_id: 'whs_examplemart_ksa',
    name: 'Examplemart — shipment.created → intake',
    event_type: 'shipment.created',
    priority: 10,
    mapping_config_id: 'mc_examplemarket_ksa_v3_in',
    workflow_template_id: 'tpl_intake_exampleparcel',
    domain_category: 'shipping',
    enabled: true,
    created_at: '2026-04-21T08:00:00Z',
  },
  {
    id: 'wbr_exampleoutlet_create',
    webhook_source_id: 'whs_exampleoutlet',
    name: 'Exampleoutlet — shipment.created → intake',
    event_type: 'shipment.created',
    priority: 20,
    mapping_config_id: 'mc_exampledepot_resp',
    workflow_template_id: 'tpl_intake_exampleparcel',
    domain_category: 'shipping',
    enabled: true,
    created_at: '2026-04-15T09:30:00Z',
  },
  {
    id: 'wbr_exampleparcel_update',
    webhook_source_id: 'whs_exampleparcel_ksa',
    name: 'Exampleparcel — shipment.updated → amend/cancel',
    event_type: 'shipment.updated',
    priority: 30,
    mapping_config_id: 'mc_event_shp_created',
    workflow_template_id: 'tpl_amend_cancel',
    domain_category: 'shipping',
    enabled: true,
    created_at: '2026-04-19T16:30:00Z',
  },
  {
    id: 'wbr_exampledepot_status',
    webhook_source_id: 'whs_exampledepot_carrier',
    name: 'Exampledepot — carrier status → amend/cancel',
    event_type: 'shipment.updated',
    priority: 40,
    mapping_config_id: 'mc_exampledepot_resp',
    workflow_template_id: 'tpl_amend_cancel',
    domain_category: 'shipping',
    enabled: false,
    created_at: '2026-04-10T12:00:00Z',
  },
];

// Phase G1 schema-drift fix: aligned field names with public.webhook_inbox
// canonical columns. Renamed source_id -> webhook_source_id, received_at ->
// created_at, status -> processing_status, dedupe_key -> external_id, error
// -> error_message. payload_size and workflow_run_id are derived UI
// projections (computed server-side or via domain_events.correlation_id
// join) — populated here so the demo seam exposes the canonical row shape.
export const webhook_inbox = [
  { id: 'wbk_7741', organization_id: 'org_rashed', webhook_source_id: 'whs_exampleparcel_ksa', created_at: minutesAgo(5), processing_status: 'processed', event_type: 'shipment.created', payload_size: 2048, external_id: 'EXAMPLEMARKET-99281', workflow_run_id: 'wfr_3221' },
  { id: 'wbk_7740', organization_id: 'org_rashed', webhook_source_id: 'whs_exampleparcel_ksa', created_at: minutesAgo(7), processing_status: 'processed', event_type: 'shipment.created', payload_size: 1980, external_id: 'EXAMPLEMARKET-99280', workflow_run_id: 'wfr_3218' },
  { id: 'wbk_7739', organization_id: 'org_rashed', webhook_source_id: 'whs_exampleparcel_ksa', created_at: minutesAgo(7), processing_status: 'dead_letter', event_type: 'shipment.created', payload_size: 1840, external_id: 'EXAMPLEMARKET-99279', workflow_run_id: 'wfr_3217', error_message: 'schema_registry validation failed: address.country missing' },
  { id: 'wbk_7738', organization_id: 'org_rashed', webhook_source_id: 'whs_examplemart_ksa', created_at: minutesAgo(11), processing_status: 'processed', event_type: 'shipment.created', payload_size: 2210, external_id: 'EXAMPLEMART-44119', workflow_run_id: 'wfr_3215' },
  { id: 'wbk_7737', organization_id: 'org_rashed', webhook_source_id: 'whs_exampleparcel_ksa', created_at: minutesAgo(15), processing_status: 'processed', event_type: 'shipment.updated', payload_size: 980, external_id: 'EXAMPLEMARKET-99278' },
];

export const webhook_auth_rejections = [
  {
    id: 'iar_webhook_disabled_source',
    service: 'webhook_receiver',
    surface: 'webhook_receiver',
    credential_kind: 'source_token',
    failure_code: 'invalid_token',
    failure_message: 'Webhook source token was invalid or disabled.',
    http_status: 401,
    organization_id: 'org_rashed',
    source_id: 'whs_exampleparcel_ksa',
    webhook_source_id: 'whs_exampleparcel_ksa',
    source_label: 'Exampleparcel KSA',
    source_identifier: 'exampleparcel-ksa-prod',
    client_id: 'clt_exampleparcel',
    client_label: 'Exampleparcel KSA',
    sender_id: 'snd_exampleparcel_ksa',
    sender_label: 'Exampleparcel Fulfillment KSA',
    correlation_id: '5e5ee6f6-8f10-49f7-9f29-2c5cfc9d7b16',
    request_id: 'req_webhook_disabled_source',
    method: 'POST',
    path: '/functions/v1/webhook-receiver',
    token_fingerprint: 'sha256:4a6b9f2992db5ca1',
    request_headers: {
      authorization: 'REDACTED',
      'x-correlation-id': '5e5ee6f6-8f10-49f7-9f29-2c5cfc9d7b16',
    },
    metadata: {
      edge_stage: 'workflow_intake_webhook',
      response_outcome: 'response_failed',
    },
    occurred_at: minutesAgo(9),
    source_resolved: true,
    rejection_class: 'unauthorized',
  },
];

export const marketing_intake_events = [
  { id: 'mki_4421', received_at: minutesAgo(2), email: 'lead@example.com', company: 'Acme Logistics', volume: '10k-60k', role: 'Ops', source: '/#contact-sales', ip_hash: 'a7f9...', turnstile_status: 'verified', dedupe_status: 'new', rate_limit_status: 'ok', rate_limit_used: 22, rate_limit_max: 100, decision: 'accepted', task_id: 'TSK-8472', workflow_run_id: 'wfr_marketing_8472', dispatch_id: 'wbd_marketing_8472' },
  { id: 'mki_4420', received_at: minutesAgo(7), email: 'prospect@business.co', company: 'Prospect Fulfillment', volume: '60k+', role: 'Growth', source: '/#contact-sales', ip_hash: 'b2d4...', turnstile_status: 'verified', dedupe_status: 'duplicate', rate_limit_status: 'ok', decision: 'dedupe_dropped' },
  { id: 'mki_4419', received_at: minutesAgo(14), email: 'spam@bot.test', company: 'Unknown company', source: '/#contact-sales', ip_hash: 'c8e1...', turnstile_status: 'failed', dedupe_status: 'new', rate_limit_status: 'ok', decision: 'turnstile_failed' },
  { id: 'mki_4418', received_at: minutesAgo(28), email: 'flood@example.com', company: 'Flood Test', source: '/#contact-sales', ip_hash: 'a7f9...', turnstile_status: 'verified', dedupe_status: 'new', rate_limit_status: 'limited', rate_limit_used: 100, rate_limit_max: 100, decision: 'rate_limited' },
];

export const marketing_intake_metrics_24h = {
  total: 847,
  verified: 823,
  turnstile_failed: 12,
  rate_limited: 8,
  dedupe_dropped: 4,
};

// tenant_signup_requests mirrors public.tenant_signup_requests from
//   supabase/migrations/202602201010_tenant_signup_policy_requests_v1.sql:214-261
// Statuses follow the canonical CHECK constraint
//   `status IN ('pending', 'approved', 'rejected')` (L256).
// Canonical fields: organization_name/email/full_name (intake), marketing/metadata
// JSONB envelopes (attestations + intake context), reviewed_at/reviewed_by/
// review_reason/decision_metadata (decision history). The legacy demo aliases
// `org_name`, `industry`, `size`, `contact_email`, `received_at` are kept for
// the existing list table; the drawer reads canonical fields directly so the
// UI exercise mirrors the production payload shape.
export const tenant_signup_requests = [
  {
    id: 'tsr_221',
    // Legacy/demo aliases for the queue table.
    org_name: 'Riyadh Express LLC',
    industry: 'Last-mile logistics',
    size: '50-100 staff',
    contact_email: 'ops@riyadh-express.example',
    received_at: minutesAgo(120),
    status: 'pending',
    task_id: 'tsk_3003',
    // Canonical schema fields (drawer + RPC payload).
    organization_name: 'Riyadh Express LLC',
    organization_slug: 'riyadh-express',
    email: 'ops@riyadh-express.example',
    full_name: 'Layla Al-Otaibi',
    website_url: 'https://riyadh-express.example',
    phone: '+1 202 555 0187',
    notes: 'Operating across Riyadh metro; needs API access for label printing.',
    locale: 'ar-SA',
    page_url: 'https://www.masarx.sa/contact-sales',
    referrer: 'https://www.google.com/',
    origin: 'https://www.masarx.sa',
    marketing: {
      campaign: 'q2-launch',
      utm_source: 'linkedin',
      utm_medium: 'paid',
      consent: true,
      consent_at: minutesAgo(122),
    },
    metadata: {
      industry: 'Last-mile logistics',
      org_size: '50-100 staff',
      attestations: {
        terms_accepted: true,
        privacy_accepted: true,
        kyc_documents_provided: false,
        beneficial_owner_disclosed: true,
      },
      ip_hash: 'd7c2…9f1',
      turnstile_verified: true,
    },
    turnstile_verified: true,
    review_decision: null,
    decision_metadata: {},
  },
  {
    id: 'tsr_220',
    org_name: 'Jazira Couriers',
    industry: 'Same-day delivery',
    size: '10-50 staff',
    contact_email: 'admin@jazira-couriers.example',
    received_at: minutesAgo(420),
    status: 'pending',
    organization_name: 'Jazira Couriers',
    organization_slug: 'jazira-couriers',
    email: 'admin@jazira-couriers.example',
    full_name: 'Khalid Al-Ghamdi',
    website_url: 'https://jazira-couriers.example',
    phone: '+1 202 555 0188',
    notes: 'Awaiting legal sign-off before activation.',
    locale: 'en-SA',
    page_url: 'https://www.masarx.sa/pricing',
    referrer: 'https://www.masarx.sa/',
    origin: 'https://www.masarx.sa',
    marketing: {
      campaign: 'partner-referral',
      utm_source: 'partner',
      utm_medium: 'referral',
      consent: true,
      consent_at: minutesAgo(421),
    },
    metadata: {
      industry: 'Same-day delivery',
      org_size: '10-50 staff',
      attestations: {
        terms_accepted: true,
        privacy_accepted: true,
        kyc_documents_provided: true,
        beneficial_owner_disclosed: false,
      },
      ip_hash: 'a1b9…32d',
      turnstile_verified: true,
    },
    turnstile_verified: true,
    review_decision: null,
    decision_metadata: {},
  },
  {
    id: 'tsr_219',
    org_name: 'Tabuk Logistics',
    industry: 'Freight forwarder',
    size: '100-500 staff',
    contact_email: 'partnerships@tabuk-log.example',
    received_at: minutesAgo(1380),
    status: 'approved',
    approved_at: '2026-04-24T15:00:00Z',
    organization_name: 'Tabuk Logistics',
    organization_slug: 'tabuk-logistics',
    email: 'partnerships@tabuk-log.example',
    full_name: 'Reem Al-Harbi',
    website_url: 'https://tabuk-log.example',
    phone: '+1 202 555 0189',
    notes: 'Approved 2026-04-24; provisioning org + ops_admin role completed.',
    locale: 'en-SA',
    page_url: 'https://www.masarx.sa/partners',
    referrer: 'https://duckduckgo.com/',
    origin: 'https://www.masarx.sa',
    marketing: {
      campaign: 'enterprise-q1',
      utm_source: 'event',
      utm_medium: 'sponsorship',
      consent: true,
      consent_at: minutesAgo(1382),
    },
    metadata: {
      industry: 'Freight forwarder',
      org_size: '100-500 staff',
      attestations: {
        terms_accepted: true,
        privacy_accepted: true,
        kyc_documents_provided: true,
        beneficial_owner_disclosed: true,
      },
      ip_hash: '4e09…118',
      turnstile_verified: true,
    },
    turnstile_verified: true,
    review_decision: 'approved',
    reviewed_at: '2026-04-24T15:00:00Z',
    reviewed_by_label: 'fixture-contact-04@example.com',
    review_reason: 'KYC complete; approving as ops_admin tenant.',
    decision_metadata: {
      decision: 'approved',
      review_applied_at: '2026-04-24T15:00:00Z',
      reviewer_role: 'platform_admin',
    },
    approved_organization_id: 'org_tabuk_logistics',
    approved_user_id: 'usr_tabuk_admin',
    approved_auth_user_id: 'auth_tabuk_admin',
    invite_email_sent_at: '2026-04-24T15:01:00Z',
    invite_redirect_to: 'https://unjijvxjrwurjgsnokovrvom.example.invalid/onboarding',
  },
];

export const marketing_landing_clients = [
  { id: 'mlc_examplemarket', display_name: 'Exampleparcel KSA', logo_token: '◆', priority: 1 },
  { id: 'mlc_examplemart', display_name: 'Examplemart', logo_token: '⬢', priority: 2 },
  { id: 'mlc_exampleoutlet', display_name: 'Exampleoutlet', logo_token: '▲', priority: 3 },
  { id: 'mlc_exampleretail', display_name: 'eXampleretail', logo_token: '✱', priority: 4 },
];
