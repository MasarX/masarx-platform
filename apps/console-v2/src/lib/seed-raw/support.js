// support.js — CLAIM-SUPPORT-CASES (Wave 3, Phase C) seed.
//
// Mirrors the canonical support projection contract from
// supabase/migrations/202601311720_support_cases_foundation_v1.sql:
//   • support_cases               (projection)
//   • support_messages            (immutable ledger)
//   • support_case_events         (immutable status/lifecycle ledger)
//
// Notes on field naming:
//   Children rows expose `support_case_id` (canonical column per migration).
//   Phase G1 schema-drift fix removed the legacy `case_id` alias — the FE
//   row interfaces and useMemo filters consume canonical names only.
//
// Status lookup (`support_case_status`):
//   open / in_progress / resolved / closed / canceled
// Priority lookup (`support_case_priority`):
//   urgent / high / medium / low
// Channel lookup (`support_message_channel`):
//   in_app / whatsapp / sms / email / phone / internal
// Direction lookup (`support_message_direction`):
//   inbound / outbound / internal
//
// The brief asks for 12-15 cases, 50-60 messages, 20-25 events, and
// channel mix [email/chat/whatsapp/api]. We map "chat" to canonical
// `in_app`, and add an `api` channel value to cover programmatic ingest
// from partner integrations (matches the `webhook_*` ingress lineage).
// All channel values stay row-driven (lookup chips render their canonical
// label/tone via the `support_message_channel` lookup).
//
// Reference time anchor: 2026-04-26 (matches the rest of the demo seed).

import { lookups } from './lookups.js';

// ---------------------------------------------------------------------------
// Lookups (additive Object.assign; do not override existing keys)
// ---------------------------------------------------------------------------
Object.assign(lookups, {
  // Mirrors public.lookup_values for support_case_status (migration L37-44).
  // Wave 5 RE-AUDIT (SUPPORT.md §8 D3): canonical lookup excludes `pending`.
  // The "Pending reply" UX is re-derived in cases.tsx as
  // `status='open' AND last_message_direction='outbound'` per the B3
  // schema-extension migration mandate.
  support_case_status: [
    { value: 'open',        label: 'Open',         tone: 'info',    rank: 10, lifecycle: 'open' },
    { value: 'in_progress', label: 'In progress',  tone: 'warn',    rank: 20, lifecycle: 'open' },
    { value: 'resolved',    label: 'Resolved',     tone: 'good',    rank: 30, lifecycle: 'resolved' },
    { value: 'closed',      label: 'Closed',       tone: 'neutral', rank: 40, lifecycle: 'resolved' },
    { value: 'canceled',    label: 'Canceled',     tone: 'neutral', rank: 90, lifecycle: 'canceled' },
  ],

  // Mirrors public.lookup_values for support_case_priority (migration L60-67).
  // Tones follow the `priority chip` brief — urgent=danger, high=warn,
  // medium=info, low=neutral — so the queue list reads at a glance.
  support_case_priority: [
    { value: 'urgent', label: 'Urgent', tone: 'danger',  rank: 10 },
    { value: 'high',   label: 'High',   tone: 'warn',    rank: 20 },
    { value: 'medium', label: 'Medium', tone: 'info',    rank: 30 },
    { value: 'low',    label: 'Low',    tone: 'neutral', rank: 40 },
  ],

  // Mirrors public.lookup_values for support_message_channel (migration L106-113)
  // plus the `api` value used for programmatic / webhook-relayed ingest.
  support_message_channel: [
    { value: 'in_app',   label: 'In-app',   tone: 'info',    rank: 10 },
    { value: 'whatsapp', label: 'WhatsApp', tone: 'good',    rank: 20 },
    { value: 'sms',      label: 'SMS',      tone: 'neutral', rank: 30 },
    { value: 'email',    label: 'Email',    tone: 'info',    rank: 40 },
    { value: 'phone',    label: 'Phone',    tone: 'neutral', rank: 50 },
    { value: 'api',      label: 'API',      tone: 'neutral', rank: 60 },
    { value: 'internal', label: 'Internal', tone: 'neutral', rank: 90 },
  ],

  // Mirrors public.lookup_values for support_message_direction (migration L83-89).
  // W71-Support (Cycle F-R-11) closure: `metadata.is_pending_reply_trigger`
  // flags the `outbound` row so the `caseHasPendingReply` helper in
  // modules/support/cases.tsx resolves via canonical SSOT instead of
  // comparing against an inline `'outbound'` literal. Mirrors the
  // disputeLifecycle metadata pattern used in lookups.js. AGENTS.md §2
  // (ZERO HARDCODING) + §4 (SSOT) + §6 (row-driven by configuration).
  support_message_direction: [
    { value: 'inbound',  label: 'Inbound',  tone: 'neutral', rank: 10, metadata: { is_pending_reply_trigger: false } },
    { value: 'outbound', label: 'Outbound', tone: 'good',    rank: 20, metadata: { is_pending_reply_trigger: true  } },
    { value: 'internal', label: 'Internal', tone: 'info',    rank: 30, metadata: { is_pending_reply_trigger: false } },
  ],

  // Author role — derived from message direction + actor in the projection;
  // surfaced as a helper lookup so MessageThread can resolve its bubble tone
  // (operator → right-aligned, customer → left-aligned, system → centered).
  support_message_role: [
    { value: 'operator', label: 'Operator', tone: 'good',    rank: 10 },
    { value: 'customer', label: 'Customer', tone: 'neutral', rank: 20 },
    { value: 'system',   label: 'System',   tone: 'info',    rank: 30 },
  ],

  // Event type — the ledger covers status changes + assignment + tagging +
  // attachment + escalation. Tones drive the TimelineLog bullet color in the
  // detail drawer so a glance reveals "what just happened".
  support_case_event_type: [
    { value: 'opened',          label: 'Case opened',         tone: 'info',    rank: 10 },
    { value: 'assigned',        label: 'Assigned',            tone: 'info',    rank: 20 },
    { value: 'status_changed',  label: 'Status changed',      tone: 'neutral', rank: 30, metadata: { summary_format: 'transition' } },
    { value: 'message_received',label: 'Message received',    tone: 'neutral', rank: 40 },
    { value: 'message_sent',    label: 'Operator replied',    tone: 'good',    rank: 50 },
    { value: 'escalated',       label: 'Escalated',           tone: 'warn',    rank: 60 },
    { value: 'sla_breached',    label: 'SLA breached',        tone: 'danger',  rank: 70 },
    { value: 'tag_added',       label: 'Tag added',           tone: 'neutral', rank: 80 },
    { value: 'attachment_added',label: 'Attachment uploaded', tone: 'neutral', rank: 81 },
    { value: 'resolved',        label: 'Resolved',            tone: 'good',    rank: 90 },
    { value: 'closed',          label: 'Closed',              tone: 'neutral', rank: 95 },
    { value: 'reopened',        label: 'Reopened',            tone: 'warn',    rank: 96 },
  ],
});

// ---------------------------------------------------------------------------
// Operator user roster (cross-references seed.current_user / dev_roles).
// Used by the assignee picker in the middle pane. Keep in sync with seed.users
// when present.
//
// W19-4 — dropped fictional `initials` column per
// __audit__/SCHEMA-DRIFT/SUPPORT.md §4 (no canonical column; computed from
// `name` via `initialsOf(name)` in cases.tsx). Production resolution path
// (deferred): either ship a `support_users_v1` projection view filtered by
// `public.users.user_type` / `rbac_user_role_assignments`, or migrate the
// consumer to `useResourceList('users')` with a server-side role filter.
// ---------------------------------------------------------------------------
export const support_users = [
  { id: 'usr_admin_rashed',  name: 'Rashed Al-Otaibi',  role: 'super_admin'    },
  { id: 'usr_ops_layla',     name: 'Layla Al-Saud',     role: 'ops_admin'      },
  { id: 'usr_ops_omar',      name: 'Omar Al-Qahtani',   role: 'ops_admin'      },
  { id: 'usr_acct_hessa',    name: 'Hessa Al-Dossari',  role: 'account_manager'},
  { id: 'usr_acct_khalid',   name: 'Khalid Al-Mutairi', role: 'account_manager'},
];

// ---------------------------------------------------------------------------
// support_cases — 14 cases distributed across status × priority × channel.
//
// Distribution rationale:
//   • Statuses: open × 7, in_progress × 3, resolved × 3, closed × 1
//     (Wave 5 RE-AUDIT — `pending` removed; "Pending reply" derived from last
//     outbound message direction; the 2 prior pending rows became `open`.)
//   • Priorities: urgent × 2, high × 4, medium × 5, low × 3
//   • Channels: email × 4, in_app × 4, whatsapp × 3, api × 2, phone × 1
//   • Cross-client coverage: Exampleparcel × 5, Examplemart × 3, Exampleoutlet × 3, eXampleretail × 3
//   • Some cases linked to shipments via related_shipment_id
//   • Mix of assigned + unassigned + sla_breached
//
// `opened_at`, `closed_at`, and `sla_due_at` are deterministic against the
// 2026-04-26 reference time so SLA chips and aging buckets render
// reproducibly.
// ---------------------------------------------------------------------------
const NOW = '2026-04-26T10:00:00Z';

export const support_cases = [
  {
    id: 'case_examplemarket_001',
    organization_id: 'org_rashed',
    client_id: 'cl_exampleparcel_ksa',
    sender_id: 'snd_examplemarket_jed_warehouse',
    recipient_id: 'rcp_1000',
    related_shipment_id: 'shp_9381200',
    subject: 'Package marked delivered but not received',
    status: 'open',
    priority: 'urgent',
    channel: 'whatsapp',
    assigned_to: 'usr_ops_layla',
    opened_at: '2026-04-26T08:42:00Z',
    closed_at: null,
    sla_due_at: '2026-04-26T12:42:00Z',
    sla_breached: false,
    last_message_at: '2026-04-26T09:55:00Z',
    message_count: 6,
    tags: ['delivery_dispute', 'p1'],
    metadata: { source: 'whatsapp_business' },
  },
  {
    id: 'case_examplemarket_002',
    organization_id: 'org_rashed',
    client_id: 'cl_exampleparcel_ksa',
    sender_id: 'snd_examplemarket_ruh_warehouse',
    recipient_id: 'rcp_1004',
    related_shipment_id: 'shp_9381204',
    subject: 'COD amount disputed by recipient',
    status: 'in_progress',
    priority: 'high',
    channel: 'email',
    assigned_to: 'usr_admin_rashed',
    opened_at: '2026-04-25T14:20:00Z',
    closed_at: null,
    sla_due_at: '2026-04-26T08:20:00Z',
    sla_breached: true,
    last_message_at: '2026-04-26T09:12:00Z',
    message_count: 9,
    tags: ['cod_dispute', 'finance_review'],
    metadata: {},
  },
  {
    // Wave 5 RE-AUDIT (SUPPORT.md §8 D3): converted from removed `pending`
    // status to canonical `open`; "Pending reply" UX is now derived from the
    // last message direction (outbound). Final operator message msg_003e
    // makes the last direction outbound -> surfaces under "Pending reply".
    id: 'case_examplemarket_003',
    organization_id: 'org_rashed',
    client_id: 'cl_exampleparcel_ksa',
    sender_id: 'snd_examplemarket_jed_warehouse',
    recipient_id: 'rcp_1008',
    related_shipment_id: null,
    subject: 'Bulk import preview failing for SKU mapping',
    status: 'open',
    priority: 'medium',
    channel: 'api',
    assigned_to: 'usr_ops_omar',
    opened_at: '2026-04-24T11:00:00Z',
    closed_at: null,
    sla_due_at: '2026-04-26T11:00:00Z',
    sla_breached: false,
    last_message_at: '2026-04-25T17:30:00Z',
    message_count: 5,
    tags: ['integration', 'mapping_studio'],
    metadata: { mapping_config_id: 'mc_examplemarket_v3' },
  },
  {
    id: 'case_examplemarket_004',
    organization_id: 'org_rashed',
    client_id: 'cl_exampleparcel_ksa',
    sender_id: 'snd_examplemarket_ruh_warehouse',
    recipient_id: 'rcp_1002',
    related_shipment_id: 'shp_9381208',
    subject: 'Failed attempt — recipient unreachable',
    status: 'resolved',
    priority: 'high',
    channel: 'phone',
    assigned_to: 'usr_acct_hessa',
    opened_at: '2026-04-23T09:15:00Z',
    closed_at: null,
    sla_due_at: '2026-04-23T17:15:00Z',
    sla_breached: false,
    last_message_at: '2026-04-25T10:00:00Z',
    message_count: 5,
    tags: ['ndr', 'recovered'],
    metadata: {},
  },
  {
    id: 'case_examplemart_001',
    organization_id: 'org_rashed',
    client_id: 'cl_examplemart_ksa',
    sender_id: 'snd_examplemart_ruh_dc',
    recipient_id: 'rcp_1003',
    related_shipment_id: 'shp_9381212',
    subject: 'Wrong address — needs correction',
    status: 'in_progress',
    priority: 'medium',
    channel: 'in_app',
    assigned_to: 'usr_ops_layla',
    opened_at: '2026-04-26T07:30:00Z',
    closed_at: null,
    sla_due_at: '2026-04-26T15:30:00Z',
    sla_breached: false,
    last_message_at: '2026-04-26T08:45:00Z',
    message_count: 3,
    tags: ['address_correction'],
    metadata: {},
  },
  {
    id: 'case_examplemart_002',
    organization_id: 'org_rashed',
    client_id: 'cl_examplemart_ksa',
    sender_id: 'snd_examplemart_ruh_dc',
    recipient_id: 'rcp_1006',
    related_shipment_id: null,
    subject: 'Operator portal — cannot mark batch as remitted',
    status: 'open',
    priority: 'high',
    channel: 'email',
    assigned_to: null,
    opened_at: '2026-04-26T06:10:00Z',
    closed_at: null,
    sla_due_at: '2026-04-26T14:10:00Z',
    sla_breached: false,
    last_message_at: '2026-04-26T06:10:00Z',
    message_count: 1,
    tags: ['portal_bug', 'settlements'],
    metadata: {},
  },
  {
    id: 'case_examplemart_003',
    organization_id: 'org_rashed',
    client_id: 'cl_examplemart_ksa',
    sender_id: 'snd_examplemart_ruh_dc',
    recipient_id: 'rcp_1009',
    related_shipment_id: 'shp_9381216',
    subject: 'Customer reports damaged box on arrival',
    status: 'resolved',
    priority: 'medium',
    channel: 'whatsapp',
    assigned_to: 'usr_acct_khalid',
    opened_at: '2026-04-22T13:00:00Z',
    closed_at: null,
    sla_due_at: '2026-04-22T21:00:00Z',
    sla_breached: false,
    last_message_at: '2026-04-23T11:45:00Z',
    message_count: 4,
    tags: ['damage_claim', 'compensated'],
    metadata: {},
  },
  {
    id: 'case_exampleoutlet_001',
    organization_id: 'org_rashed',
    client_id: 'cl_exampleoutlet',
    sender_id: 'snd_exampleoutlet_main',
    recipient_id: 'rcp_1001',
    related_shipment_id: 'shp_9381220',
    subject: 'Package missing — driver claims delivered',
    status: 'open',
    priority: 'urgent',
    channel: 'email',
    assigned_to: 'usr_ops_omar',
    opened_at: '2026-04-26T05:00:00Z',
    closed_at: null,
    sla_due_at: '2026-04-26T09:00:00Z',
    sla_breached: true,
    last_message_at: '2026-04-26T09:30:00Z',
    message_count: 5,
    tags: ['delivery_dispute', 'investigation'],
    metadata: {},
  },
  {
    id: 'case_exampleoutlet_002',
    organization_id: 'org_rashed',
    client_id: 'cl_exampleoutlet',
    sender_id: 'snd_exampleoutlet_main',
    recipient_id: 'rcp_1005',
    related_shipment_id: null,
    subject: 'Question about service offering pricing',
    status: 'open',
    priority: 'low',
    channel: 'in_app',
    assigned_to: null,
    opened_at: '2026-04-26T03:30:00Z',
    closed_at: null,
    sla_due_at: '2026-04-27T03:30:00Z',
    sla_breached: false,
    last_message_at: '2026-04-26T03:30:00Z',
    message_count: 1,
    tags: ['pricing_question'],
    metadata: {},
  },
  {
    // Wave 5 RE-AUDIT (SUPPORT.md §8 D3): converted from removed `pending`
    // status to canonical `open`; "Pending reply" UX is now derived from the
    // last message direction (outbound). Final operator message msg_010e
    // makes the last direction outbound -> surfaces under "Pending reply".
    id: 'case_exampleoutlet_003',
    organization_id: 'org_rashed',
    client_id: 'cl_exampleoutlet',
    sender_id: 'snd_exampleoutlet_main',
    recipient_id: 'rcp_1007',
    related_shipment_id: 'shp_9381224',
    subject: 'Re-attempt scheduled but never picked up',
    status: 'open',
    priority: 'medium',
    channel: 'sms',
    assigned_to: 'usr_acct_hessa',
    opened_at: '2026-04-25T17:00:00Z',
    closed_at: null,
    sla_due_at: '2026-04-26T17:00:00Z',
    sla_breached: false,
    last_message_at: '2026-04-26T08:15:00Z',
    message_count: 5,
    tags: ['ndr', 'reattempt'],
    metadata: {},
  },
  {
    id: 'case_extra_001',
    organization_id: 'org_rashed',
    client_id: 'cl_exampleretail',
    sender_id: null,
    recipient_id: null,
    related_shipment_id: null,
    subject: 'Webhook ingest paused — credentials rotation',
    status: 'in_progress',
    priority: 'high',
    channel: 'api',
    assigned_to: 'usr_ops_omar',
    opened_at: '2026-04-25T22:00:00Z',
    closed_at: null,
    sla_due_at: '2026-04-26T22:00:00Z',
    sla_breached: false,
    last_message_at: '2026-04-26T07:15:00Z',
    message_count: 6,
    tags: ['integration', 'credentials'],
    metadata: { provider: 'extra_in_house' },
  },
  {
    id: 'case_extra_002',
    organization_id: 'org_rashed',
    client_id: 'cl_exampleretail',
    sender_id: null,
    recipient_id: 'rcp_1002',
    related_shipment_id: 'shp_9381228',
    subject: 'Driver wait-time fee billed twice',
    status: 'resolved',
    priority: 'medium',
    channel: 'email',
    assigned_to: 'usr_acct_khalid',
    opened_at: '2026-04-21T10:00:00Z',
    closed_at: null,
    sla_due_at: '2026-04-22T10:00:00Z',
    sla_breached: false,
    last_message_at: '2026-04-22T15:30:00Z',
    message_count: 5,
    tags: ['billing_dispute', 'credit_issued'],
    metadata: {},
  },
  {
    id: 'case_extra_003',
    organization_id: 'org_rashed',
    client_id: 'cl_exampleretail',
    sender_id: null,
    recipient_id: 'rcp_1004',
    related_shipment_id: null,
    subject: 'Request to add new sender warehouse',
    status: 'closed',
    priority: 'low',
    channel: 'in_app',
    assigned_to: 'usr_admin_rashed',
    opened_at: '2026-04-15T11:00:00Z',
    closed_at: '2026-04-18T16:30:00Z',
    sla_due_at: '2026-04-17T11:00:00Z',
    sla_breached: false,
    last_message_at: '2026-04-18T16:30:00Z',
    message_count: 4,
    tags: ['onboarding', 'completed'],
    metadata: {},
  },
  {
    id: 'case_examplemarket_005',
    organization_id: 'org_rashed',
    client_id: 'cl_exampleparcel_ksa',
    sender_id: 'snd_examplemarket_jed_warehouse',
    recipient_id: 'rcp_1001',
    related_shipment_id: null,
    subject: 'Reporting export missing partner column',
    status: 'open',
    priority: 'low',
    channel: 'in_app',
    assigned_to: null,
    opened_at: '2026-04-26T02:15:00Z',
    closed_at: null,
    sla_due_at: '2026-04-27T02:15:00Z',
    sla_breached: false,
    last_message_at: '2026-04-26T02:15:00Z',
    message_count: 1,
    tags: ['reporting', 'enhancement'],
    metadata: {},
  },
];

// ---------------------------------------------------------------------------
// support_messages — 56 messages distributed across cases.
//
// Author roles cycle operator/customer/system to drive MessageThread tone
// rendering. Phase G1 schema-drift fix: dropped the legacy `case_id` alias —
// canonical column is `support_case_id` per public.support_messages.
//
// `attachments` is an array of {id, name, href?} objects matching the
// MessageThread.MessageAttachment contract (derived UI projection — backend
// uses single artifact_id FK + artifact_links join).
// ---------------------------------------------------------------------------

function makeMessage({
  id, caseId, at, role, name, body, channel = 'in_app', attachments = [],
}) {
  return {
    id,
    support_case_id: caseId,
    sent_at: at,
    direction: role === 'operator' ? 'outbound' : role === 'customer' ? 'inbound' : 'internal',
    channel,
    author_user_id: role === 'operator'
      ? 'usr_admin_rashed'
      : role === 'system'
        ? null
        : null,
    author_role: role,
    author_name: name,
    body,
    attachments,
  };
}

export const support_messages = [
  // case_examplemarket_001 — 6 messages (urgent delivery dispute)
  makeMessage({ id: 'msg_001a', caseId: 'case_examplemarket_001', at: '2026-04-26T08:42:00Z', role: 'customer', name: 'Layla Al-Saud',     channel: 'whatsapp', body: 'My order shows delivered but I never received it. Tracking: SHP-9381200' }),
  makeMessage({ id: 'msg_001b', caseId: 'case_examplemarket_001', at: '2026-04-26T08:48:00Z', role: 'system',   name: 'Auto-router',        channel: 'internal', body: 'Auto-assigned to Layla Al-Otaibi (urgent · whatsapp).' }),
  makeMessage({ id: 'msg_001c', caseId: 'case_examplemarket_001', at: '2026-04-26T08:55:00Z', role: 'operator', name: 'Layla Al-Otaibi',    channel: 'whatsapp', body: 'Hi, very sorry about that. I am pulling the GPS trace and POD photo for the driver — one moment.' }),
  makeMessage({ id: 'msg_001d', caseId: 'case_examplemarket_001', at: '2026-04-26T09:30:00Z', role: 'operator', name: 'Layla Al-Otaibi',    channel: 'whatsapp', body: 'POD shows delivered to a neighbor. Sharing the photo for confirmation.', attachments: [{ id: 'att_pod_001', name: 'pod_shp_9381200.jpg' }] }),
  makeMessage({ id: 'msg_001e', caseId: 'case_examplemarket_001', at: '2026-04-26T09:42:00Z', role: 'customer', name: 'Layla Al-Saud',     channel: 'whatsapp', body: 'That is not my building. The package is missing.' }),
  makeMessage({ id: 'msg_001f', caseId: 'case_examplemarket_001', at: '2026-04-26T09:55:00Z', role: 'operator', name: 'Layla Al-Otaibi',    channel: 'whatsapp', body: 'Understood — escalating to claims and dispatching a recovery driver. Reference: CLAIM-2026-04-001.' }),

  // case_examplemarket_002 — 9 messages (COD dispute, SLA breached)
  makeMessage({ id: 'msg_002a', caseId: 'case_examplemarket_002', at: '2026-04-25T14:20:00Z', role: 'customer', name: 'Reem Al-Harbi',      channel: 'email',    body: 'Driver collected 580 SAR but our shipment shows 450 SAR cash on delivery. Please advise.' }),
  makeMessage({ id: 'msg_002b', caseId: 'case_examplemarket_002', at: '2026-04-25T15:10:00Z', role: 'operator', name: 'Rashed Al-Otaibi',   channel: 'email',    body: 'Thanks for flagging. Pulling the driver log + COD batch reconciliation now.' }),
  makeMessage({ id: 'msg_002c', caseId: 'case_examplemarket_002', at: '2026-04-25T16:45:00Z', role: 'system',   name: 'Workflow',           channel: 'internal', body: 'Linked to settlement_batch_2026_04_25_evening (cod_collection_workflow_v3).' }),
  makeMessage({ id: 'msg_002d', caseId: 'case_examplemarket_002', at: '2026-04-25T17:20:00Z', role: 'operator', name: 'Rashed Al-Otaibi',   channel: 'email',    body: 'Confirmed: driver entered 580 SAR but the shipment row says 450. Investigating overage cause.' }),
  makeMessage({ id: 'msg_002e', caseId: 'case_examplemarket_002', at: '2026-04-25T18:00:00Z', role: 'customer', name: 'Reem Al-Harbi',      channel: 'email',    body: 'We need this resolved before tomorrow. The recipient is asking for a refund.' }),
  makeMessage({ id: 'msg_002f', caseId: 'case_examplemarket_002', at: '2026-04-26T07:30:00Z', role: 'operator', name: 'Rashed Al-Otaibi',   channel: 'email',    body: 'Confirmed overage. Issuing 130 SAR refund directly to recipient via the linked invoice.' }),
  makeMessage({ id: 'msg_002g', caseId: 'case_examplemarket_002', at: '2026-04-26T08:20:00Z', role: 'system',   name: 'SLA monitor',        channel: 'internal', body: 'SLA breached — sla_due_at exceeded by 0m. Auto-escalation triggered.' }),
  makeMessage({ id: 'msg_002h', caseId: 'case_examplemarket_002', at: '2026-04-26T08:55:00Z', role: 'operator', name: 'Rashed Al-Otaibi',   channel: 'email',    body: 'Refund processed — invoice INV-2026-0303 reissued. Closing pending customer confirmation.' }),
  makeMessage({ id: 'msg_002i', caseId: 'case_examplemarket_002', at: '2026-04-26T09:12:00Z', role: 'customer', name: 'Reem Al-Harbi',      channel: 'email',    body: 'Received the refund. Thanks for the quick turnaround.' }),

  // case_examplemarket_003 — 5 messages (mapping studio integration awaiting customer
  // validation). Wave 5 RE-AUDIT (SUPPORT.md §8 D3): final operator follow-up
  // makes the last direction outbound -> surfaces under "Pending reply".
  makeMessage({ id: 'msg_003a', caseId: 'case_examplemarket_003', at: '2026-04-24T11:00:00Z', role: 'customer', name: 'Hessa (integrations)', channel: 'api',     body: 'Bulk import preview failing for SKU mapping. Attached the failing sample.', attachments: [{ id: 'att_csv_003', name: 'sample_failure.csv' }] }),
  makeMessage({ id: 'msg_003b', caseId: 'case_examplemarket_003', at: '2026-04-24T11:30:00Z', role: 'operator', name: 'Omar Al-Qahtani',     channel: 'in_app',   body: 'Looking — your mapping (mc_examplemarket_v3) does not declare a source column for `client_sku`. Suggesting v4 with that column added.' }),
  makeMessage({ id: 'msg_003c', caseId: 'case_examplemarket_003', at: '2026-04-25T14:15:00Z', role: 'operator', name: 'Omar Al-Qahtani',     channel: 'in_app',   body: 'Pushed mc_examplemarket_v4 to the staging environment for your review.' }),
  makeMessage({ id: 'msg_003d', caseId: 'case_examplemarket_003', at: '2026-04-25T16:30:00Z', role: 'customer', name: 'Hessa (integrations)', channel: 'in_app',   body: 'Trying it now. Will report back.' }),
  makeMessage({ id: 'msg_003e', caseId: 'case_examplemarket_003', at: '2026-04-25T17:30:00Z', role: 'operator', name: 'Omar Al-Qahtani',     channel: 'in_app',   body: 'Confirm whether the staged mapping resolves the SKU import — happy to ship to prod once you sign off.' }),

  // case_examplemarket_004 — 5 messages (failed attempt resolved)
  makeMessage({ id: 'msg_004a', caseId: 'case_examplemarket_004', at: '2026-04-23T09:15:00Z', role: 'customer', name: 'Saud Al-Ghamdi',      channel: 'phone',    body: 'Recipient called — wants the parcel held at branch for pickup tomorrow.' }),
  makeMessage({ id: 'msg_004b', caseId: 'case_examplemarket_004', at: '2026-04-23T09:45:00Z', role: 'operator', name: 'Hessa Al-Dossari',    channel: 'in_app',   body: 'Updated dispatch task → hold at branch. Customer notified via WhatsApp.' }),
  makeMessage({ id: 'msg_004c', caseId: 'case_examplemarket_004', at: '2026-04-24T10:00:00Z', role: 'system',   name: 'Workflow',            channel: 'internal', body: 'Pickup task created (task_pickup_branch_001). Branch staff notified.' }),
  makeMessage({ id: 'msg_004d', caseId: 'case_examplemarket_004', at: '2026-04-24T16:30:00Z', role: 'customer', name: 'Saud Al-Ghamdi',      channel: 'whatsapp', body: 'Picked up. Closing.' }),
  makeMessage({ id: 'msg_004e', caseId: 'case_examplemarket_004', at: '2026-04-25T10:00:00Z', role: 'operator', name: 'Hessa Al-Dossari',    channel: 'in_app',   body: 'Marked resolved. Thanks for the update.' }),

  // case_examplemart_001 — 3 messages (address correction)
  makeMessage({ id: 'msg_005a', caseId: 'case_examplemart_001', at: '2026-04-26T07:30:00Z', role: 'customer', name: 'Bandar Al-Anazi',     channel: 'in_app',   body: 'My address is wrong — should be Building 5, not 50.' }),
  makeMessage({ id: 'msg_005b', caseId: 'case_examplemart_001', at: '2026-04-26T07:50:00Z', role: 'operator', name: 'Layla Al-Otaibi',     channel: 'in_app',   body: 'Updating now and re-triggering geocoding. Driver will be re-routed if still in transit.' }),
  makeMessage({ id: 'msg_005c', caseId: 'case_examplemart_001', at: '2026-04-26T08:45:00Z', role: 'system',   name: 'Geocoder',            channel: 'internal', body: 'New address geocoded with confidence 0.94. Re-route triggered.' }),

  // case_examplemart_002 — 1 message (unassigned new portal bug)
  makeMessage({ id: 'msg_006a', caseId: 'case_examplemart_002', at: '2026-04-26T06:10:00Z', role: 'customer', name: 'Noor Bahaa',          channel: 'email',    body: 'Hi team, the "Mark batch remitted" button on the operator portal returns a 500 for batch SBT-2026-04-25-EVE. Logs attached.', attachments: [{ id: 'att_log_006', name: 'browser_console.log' }] }),

  // case_examplemart_003 — 4 messages (damage claim, resolved)
  makeMessage({ id: 'msg_007a', caseId: 'case_examplemart_003', at: '2026-04-22T13:00:00Z', role: 'customer', name: 'Noura Al-Shehri',     channel: 'whatsapp', body: 'Box arrived crushed. Photos attached.', attachments: [{ id: 'att_dmg_007a', name: 'damage_1.jpg' }, { id: 'att_dmg_007b', name: 'damage_2.jpg' }] }),
  makeMessage({ id: 'msg_007b', caseId: 'case_examplemart_003', at: '2026-04-22T13:25:00Z', role: 'operator', name: 'Khalid Al-Mutairi',   channel: 'whatsapp', body: 'Sorry to see this — opening a damage claim now. We will issue a replacement shipment at no charge.' }),
  makeMessage({ id: 'msg_007c', caseId: 'case_examplemart_003', at: '2026-04-23T08:00:00Z', role: 'system',   name: 'Workflow',            channel: 'internal', body: 'Replacement shipment shp_9381999 created and picked up.' }),
  makeMessage({ id: 'msg_007d', caseId: 'case_examplemart_003', at: '2026-04-23T11:45:00Z', role: 'customer', name: 'Noura Al-Shehri',     channel: 'whatsapp', body: 'Replacement received in good condition. Thank you.' }),

  // case_exampleoutlet_001 — 5 messages (urgent delivery dispute, SLA breached)
  makeMessage({ id: 'msg_008a', caseId: 'case_exampleoutlet_001', at: '2026-04-26T05:00:00Z', role: 'customer', name: 'Omar Al-Qahtani',    channel: 'email',    body: 'Tracking SHP-9381220 says delivered last night, but my doorman has no record.' }),
  makeMessage({ id: 'msg_008b', caseId: 'case_exampleoutlet_001', at: '2026-04-26T07:00:00Z', role: 'operator', name: 'Omar Al-Qahtani',    channel: 'email',    body: 'Looking into it. Pulling driver scan + GPS now.' }),
  makeMessage({ id: 'msg_008c', caseId: 'case_exampleoutlet_001', at: '2026-04-26T08:30:00Z', role: 'system',   name: 'SLA monitor',        channel: 'internal', body: 'SLA breached — sla_due_at exceeded. Escalation level 2.' }),
  makeMessage({ id: 'msg_008d', caseId: 'case_exampleoutlet_001', at: '2026-04-26T09:00:00Z', role: 'operator', name: 'Omar Al-Qahtani',    channel: 'email',    body: 'GPS shows driver was 200m away at time of scan. Investigating.' }),
  makeMessage({ id: 'msg_008e', caseId: 'case_exampleoutlet_001', at: '2026-04-26T09:30:00Z', role: 'operator', name: 'Omar Al-Qahtani',    channel: 'email',    body: 'Driver suspended pending review. Recovery dispatched to your address now.' }),

  // case_exampleoutlet_002 — 1 message (low priority, unassigned)
  makeMessage({ id: 'msg_009a', caseId: 'case_exampleoutlet_002', at: '2026-04-26T03:30:00Z', role: 'customer', name: 'Reem Al-Harbi',      channel: 'in_app',   body: 'What is the price difference between Standard Metro and Express Kingdom for shipments under 5kg?' }),

  // case_exampleoutlet_003 — 5 messages (re-attempt awaiting customer confirmation).
  // Wave 5 RE-AUDIT (SUPPORT.md §8 D3): final outbound operator message so
  // this row surfaces under the derived "Pending reply" filter
  // (status='open' AND last_message_direction='outbound').
  makeMessage({ id: 'msg_010a', caseId: 'case_exampleoutlet_003', at: '2026-04-25T17:00:00Z', role: 'customer', name: 'Fatima Al-Zahrani',  channel: 'sms',      body: 'Driver did not show up for re-attempt window 14:00-16:00.' }),
  makeMessage({ id: 'msg_010b', caseId: 'case_exampleoutlet_003', at: '2026-04-25T17:30:00Z', role: 'operator', name: 'Hessa Al-Dossari',   channel: 'sms',      body: 'Apologies — driver missed the slot. Booking a new attempt for tomorrow morning.' }),
  makeMessage({ id: 'msg_010c', caseId: 'case_exampleoutlet_003', at: '2026-04-25T17:45:00Z', role: 'system',   name: 'Workflow',           channel: 'internal', body: 'Re-attempt task created (task_reattempt_018) for tomorrow 09:00.' }),
  makeMessage({ id: 'msg_010d', caseId: 'case_exampleoutlet_003', at: '2026-04-26T08:00:00Z', role: 'customer', name: 'Fatima Al-Zahrani',  channel: 'sms',      body: 'Awaiting driver.' }),
  makeMessage({ id: 'msg_010e', caseId: 'case_exampleoutlet_003', at: '2026-04-26T08:15:00Z', role: 'operator', name: 'Hessa Al-Dossari',   channel: 'sms',      body: 'Driver dispatched — ETA ~25 minutes. Confirm receipt when delivered, please.' }),

  // case_extra_001 — 6 messages (webhook ingest paused)
  makeMessage({ id: 'msg_011a', caseId: 'case_extra_001', at: '2026-04-25T22:00:00Z', role: 'system',   name: 'Webhook ingest',     channel: 'internal', body: 'Webhook source extra_in_house received 401 Unauthorized — ingestion paused after 3 retries.' }),
  makeMessage({ id: 'msg_011b', caseId: 'case_extra_001', at: '2026-04-25T22:15:00Z', role: 'customer', name: 'Khalid Al-Mutairi',  channel: 'api',      body: 'We rotated the webhook secret on our side. Please update yours.' }),
  makeMessage({ id: 'msg_011c', caseId: 'case_extra_001', at: '2026-04-25T22:30:00Z', role: 'operator', name: 'Omar Al-Qahtani',    channel: 'api',      body: 'Got it. Rotating the credential record now and re-enabling ingest.' }),
  makeMessage({ id: 'msg_011d', caseId: 'case_extra_001', at: '2026-04-25T23:00:00Z', role: 'system',   name: 'Webhook ingest',     channel: 'internal', body: 'Credential updated. Resuming ingest. Backlog of 142 events queued for replay.' }),
  makeMessage({ id: 'msg_011e', caseId: 'case_extra_001', at: '2026-04-26T06:30:00Z', role: 'system',   name: 'Webhook ingest',     channel: 'internal', body: 'Backlog drained. Ingest healthy.' }),
  makeMessage({ id: 'msg_011f', caseId: 'case_extra_001', at: '2026-04-26T07:15:00Z', role: 'operator', name: 'Omar Al-Qahtani',    channel: 'api',      body: 'All caught up. Marking in progress until you confirm everything looks right on your dashboard.' }),

  // case_extra_002 — 5 messages (billing dispute, resolved)
  makeMessage({ id: 'msg_012a', caseId: 'case_extra_002', at: '2026-04-21T10:00:00Z', role: 'customer', name: 'Bandar Al-Anazi',    channel: 'email',    body: 'INV-2026-0301 has the wait-time fee twice on lines 4 and 7.' }),
  makeMessage({ id: 'msg_012b', caseId: 'case_extra_002', at: '2026-04-21T11:30:00Z', role: 'operator', name: 'Khalid Al-Mutairi',  channel: 'email',    body: 'Confirmed — Line 7 is a duplicate from a stuck event. Issuing a credit note.' }),
  makeMessage({ id: 'msg_012c', caseId: 'case_extra_002', at: '2026-04-22T09:00:00Z', role: 'system',   name: 'Workflow',           channel: 'internal', body: 'Credit note CRD-2026-0042 issued (-95 SAR).' }),
  makeMessage({ id: 'msg_012d', caseId: 'case_extra_002', at: '2026-04-22T14:00:00Z', role: 'operator', name: 'Khalid Al-Mutairi',  channel: 'email',    body: 'Credit note sent: CRD-2026-0042 (-95 SAR).' }),
  makeMessage({ id: 'msg_012e', caseId: 'case_extra_002', at: '2026-04-22T15:30:00Z', role: 'customer', name: 'Bandar Al-Anazi',    channel: 'email',    body: 'Confirmed — applied to next month. Closing.' }),

  // case_extra_003 — 4 messages (closed)
  makeMessage({ id: 'msg_013a', caseId: 'case_extra_003', at: '2026-04-15T11:00:00Z', role: 'customer', name: 'Khalid Al-Mutairi',  channel: 'in_app',   body: 'We are opening a new fulfilment hub in Dammam. Please add it as a sender.' }),
  makeMessage({ id: 'msg_013b', caseId: 'case_extra_003', at: '2026-04-16T09:00:00Z', role: 'operator', name: 'Rashed Al-Otaibi',   channel: 'in_app',   body: 'Created snd_extra_dmm_dc — sharing API credentials separately.' }),
  makeMessage({ id: 'msg_013c', caseId: 'case_extra_003', at: '2026-04-17T10:00:00Z', role: 'customer', name: 'Khalid Al-Mutairi',  channel: 'in_app',   body: 'Confirmed onboarded. Test shipments arriving tomorrow.' }),
  makeMessage({ id: 'msg_013d', caseId: 'case_extra_003', at: '2026-04-18T16:30:00Z', role: 'operator', name: 'Rashed Al-Otaibi',   channel: 'in_app',   body: 'All test shipments delivered. Closing the case.' }),

  // case_examplemarket_005 — 1 message (low, unassigned, reporting enhancement)
  makeMessage({ id: 'msg_014a', caseId: 'case_examplemarket_005', at: '2026-04-26T02:15:00Z', role: 'customer', name: 'Hessa (integrations)', channel: 'in_app',   body: 'The CSV export from Reporting > Daily SLA omits the partner column for cross-handed shipments. Could you add it?' }),
];

// ---------------------------------------------------------------------------
// support_case_events — 24 events distributed across cases.
//
// W18-4 schema-drift closure (see __audit__/SCHEMA-DRIFT/SUPPORT.md §3):
// Aligned to canonical `public.support_case_events` columns
// (supabase/migrations/202601311720_support_cases_foundation_v1.sql:272-295):
//   • RENAMED: occurred_at -> created_at (canonical column).
//
// Each row mirrors the canonical contract: support_case_id (canonical) +
// event_type (lookup) + created_at + actor_user_id + payload jsonb. Phase
// G1 schema-drift fix (prior): dropped the legacy `case_id` alias.
// Tones derive from the `support_case_event_type` lookup so TimelineLog
// renders consistently.
// ---------------------------------------------------------------------------
function makeEvent({ id, caseId, type, at, actor, fromStatus, toStatus, payload = {} }) {
  return {
    id,
    support_case_id: caseId,
    event_type: type,
    created_at: at,
    actor_user_id: actor,
    from_status: fromStatus ?? null,
    to_status: toStatus ?? null,
    payload,
  };
}

export const support_case_events = [
  // case_examplemarket_001
  makeEvent({ id: 'evt_001a', caseId: 'case_examplemarket_001', type: 'opened',         at: '2026-04-26T08:42:00Z', actor: null,                payload: { channel: 'whatsapp' } }),
  makeEvent({ id: 'evt_001b', caseId: 'case_examplemarket_001', type: 'assigned',       at: '2026-04-26T08:48:00Z', actor: null,                payload: { assignee: 'usr_ops_layla', auto: true } }),
  makeEvent({ id: 'evt_001c', caseId: 'case_examplemarket_001', type: 'escalated',      at: '2026-04-26T09:55:00Z', actor: 'usr_ops_layla',     payload: { reason: 'package missing — recovery dispatched' } }),

  // case_examplemarket_002
  makeEvent({ id: 'evt_002a', caseId: 'case_examplemarket_002', type: 'opened',         at: '2026-04-25T14:20:00Z', actor: null }),
  makeEvent({ id: 'evt_002b', caseId: 'case_examplemarket_002', type: 'assigned',       at: '2026-04-25T15:00:00Z', actor: 'usr_admin_rashed',  payload: { assignee: 'usr_admin_rashed' } }),
  makeEvent({ id: 'evt_002c', caseId: 'case_examplemarket_002', type: 'sla_breached',   at: '2026-04-26T08:20:00Z', actor: null,                payload: { sla_due_at: '2026-04-26T08:20:00Z' } }),
  makeEvent({ id: 'evt_002d', caseId: 'case_examplemarket_002', type: 'status_changed', at: '2026-04-26T09:12:00Z', actor: 'usr_admin_rashed',  fromStatus: 'open', toStatus: 'in_progress' }),

  // case_examplemarket_003
  makeEvent({ id: 'evt_003a', caseId: 'case_examplemarket_003', type: 'opened',         at: '2026-04-24T11:00:00Z', actor: null }),
  makeEvent({ id: 'evt_003b', caseId: 'case_examplemarket_003', type: 'tag_added',      at: '2026-04-24T11:05:00Z', actor: 'usr_ops_omar',      payload: { tag: 'mapping_studio' } }),
  // Wave 5 RE-AUDIT (SUPPORT.md §8 D3): toStatus migrated from removed
  // `pending` to canonical `open` (matches case_examplemarket_003 row update above).
  makeEvent({ id: 'evt_003c', caseId: 'case_examplemarket_003', type: 'status_changed', at: '2026-04-25T16:30:00Z', actor: 'usr_ops_omar',      fromStatus: 'in_progress', toStatus: 'open' }),

  // case_examplemarket_004
  makeEvent({ id: 'evt_004a', caseId: 'case_examplemarket_004', type: 'opened',         at: '2026-04-23T09:15:00Z', actor: null }),
  makeEvent({ id: 'evt_004b', caseId: 'case_examplemarket_004', type: 'resolved',       at: '2026-04-25T10:00:00Z', actor: 'usr_acct_hessa',    fromStatus: 'in_progress', toStatus: 'resolved' }),

  // case_examplemart_001
  makeEvent({ id: 'evt_005a', caseId: 'case_examplemart_001', type: 'opened',         at: '2026-04-26T07:30:00Z', actor: null }),
  makeEvent({ id: 'evt_005b', caseId: 'case_examplemart_001', type: 'attachment_added',at: '2026-04-26T08:45:00Z', actor: null,               payload: { source: 'system', kind: 'geocoder_response' } }),

  // case_examplemart_002
  makeEvent({ id: 'evt_006a', caseId: 'case_examplemart_002', type: 'opened',         at: '2026-04-26T06:10:00Z', actor: null,                payload: { channel: 'email' } }),

  // case_examplemart_003
  makeEvent({ id: 'evt_007a', caseId: 'case_examplemart_003', type: 'opened',         at: '2026-04-22T13:00:00Z', actor: null }),
  makeEvent({ id: 'evt_007b', caseId: 'case_examplemart_003', type: 'attachment_added',at: '2026-04-22T13:00:00Z', actor: null,               payload: { count: 2 } }),
  makeEvent({ id: 'evt_007c', caseId: 'case_examplemart_003', type: 'resolved',       at: '2026-04-23T11:45:00Z', actor: 'usr_acct_khalid',   fromStatus: 'in_progress', toStatus: 'resolved' }),

  // case_exampleoutlet_001
  makeEvent({ id: 'evt_008a', caseId: 'case_exampleoutlet_001', type: 'opened',         at: '2026-04-26T05:00:00Z', actor: null }),
  makeEvent({ id: 'evt_008b', caseId: 'case_exampleoutlet_001', type: 'sla_breached',   at: '2026-04-26T08:30:00Z', actor: null }),
  makeEvent({ id: 'evt_008c', caseId: 'case_exampleoutlet_001', type: 'escalated',      at: '2026-04-26T09:30:00Z', actor: 'usr_ops_omar',     payload: { reason: 'driver suspended' } }),

  // case_exampleoutlet_003
  makeEvent({ id: 'evt_010a', caseId: 'case_exampleoutlet_003', type: 'opened',         at: '2026-04-25T17:00:00Z', actor: null }),

  // case_extra_001
  makeEvent({ id: 'evt_011a', caseId: 'case_extra_001', type: 'opened',         at: '2026-04-25T22:00:00Z', actor: null,               payload: { source: 'webhook_monitor' } }),
  makeEvent({ id: 'evt_011b', caseId: 'case_extra_001', type: 'status_changed', at: '2026-04-26T07:15:00Z', actor: 'usr_ops_omar',     fromStatus: 'open', toStatus: 'in_progress' }),

  // case_extra_003
  makeEvent({ id: 'evt_013a', caseId: 'case_extra_003', type: 'closed',         at: '2026-04-18T16:30:00Z', actor: 'usr_admin_rashed', fromStatus: 'resolved', toStatus: 'closed' }),
];
