// driver-applications.js — Phase D / D1 driver-signup intake review surface
// seed.
//
// Mirrors the canonical persistence shape that the
// `supabase/functions/driver-signup-intake/index.ts` edge function writes via
// `marketplace_participant_request_create_v1`. The backing table is
// `public.marketplace_participant_requests` (column contract from
// `supabase/migrations/202603071100_marketplace_network_foundation_v1.sql:598-641`):
//   • id UUID
//   • created_at / updated_at TIMESTAMPTZ
//   • status TEXT  ∈ {pending, approved, rejected, withdrawn}
//   • review_decision TEXT  ∈ {approved, rejected, NULL}
//   • requested_participant_type_key TEXT (always `freelancer_driver` for the
//     driver-signup-intake fn)
//   • email / full_name / organization_name / organization_slug / phone /
//     website_url / locale / page_url / referrer / origin / experience_summary
//   • capabilities_requested JSONB (array of capability keys the applicant
//     requests at intake time — e.g. `cold_chain`, `hazmat`)
//   • verification_documents JSONB (array of `{type, ref, expires_at, status}`
//     attestation pointers — Phase D drawer surfaces these in Documents tab)
//   • marketing JSONB (utm/source attribution from landing intake)
//   • metadata JSONB (always `{ source: 'driver-signup-intake', ... }`)
//   • ip_hash TEXT (salted hash, for rate-limiting; never displayed in UI)
//   • turnstile_verified BOOLEAN
//   • reviewed_at / reviewed_by / review_reason / decision_metadata
//   • approved_organization_id / approved_user_id / approved_auth_user_id
//   • approved_participant_profile_id
//   • invite_email_sent_at / invite_redirect_to
//   • last_error_code / last_error_message / last_error_at
//
// Naming convention: the canonical relation is
// `public.marketplace_participant_requests` (mixed-tenancy participant intake),
// but operators reviewing the freelancer_driver subset want a focused surface.
// The seed key `driver_applications` projects the freelancer_driver-typed rows
// from that table — same rows, narrower lens. Backend swap is a one-line edit
// in the data-source seam (filter `WHERE requested_participant_type_key =
// 'freelancer_driver'`).
//
// Lookup additions are injected via Object.assign(seed.lookups, ...) at import
// time so DataTable lookup chips for the `status` column resolve consistently.
// Mirrors the canonical participant-request status enum from
// `supabase/migrations/202603071100_marketplace_network_foundation_v1.sql:638`
// (CHECK constraint on `status` ∈ {pending, approved, rejected, withdrawn}).
//
// The reference time anchor is **2026-04-26** (matches the seeded shipments /
// route_plans cohort).

import { lookups } from './lookups.js';

Object.assign(lookups, {
  // Mirrors `marketplace_participant_requests.status` enum +
  // `review_decision` enum (NULL when status is pending/withdrawn). The
  // operator surface treats `withdrawn` as a terminal informational state
  // (applicant rescinded; no review action available).
  // W71-Operate (Cycle F-R-11) closure: each row carries
  //   • `metadata.is_pending`  — true on `pending`
  //   • `metadata.is_approved` — true on `approved`
  //   • `metadata.is_rejected` — true on `rejected`
  // Replaces inline `a.status === 'pending'|'approved'|'rejected'` literal
  // compares in modules/operate/fleet/driver-applications.tsx KPI
  // derivation. AGENTS.md §2 (ZERO HARDCODING) + §4 (SSOT) + §6
  // (row-driven by configuration).
  driver_application_status: [
    { value: 'pending', label: 'Pending review', tone: 'info', rank: 10, is_default: true, metadata: { is_pending: true,  is_approved: false, is_rejected: false } },
    { value: 'approved', label: 'Approved', tone: 'good', rank: 20, metadata: { is_pending: false, is_approved: true,  is_rejected: false } },
    { value: 'rejected', label: 'Rejected', tone: 'danger', rank: 30, metadata: { is_pending: false, is_approved: false, is_rejected: true  } },
    { value: 'withdrawn', label: 'Withdrawn', tone: 'neutral', rank: 40, metadata: { is_pending: false, is_approved: false, is_rejected: false } },
  ],
  // Per-document attestation status — used by the Documents drawer tab to
  // colour each verification entry. Mirrors the document-side status flow
  // documented by the marketplace verification policy in
  // `supabase/migrations/202603071100_marketplace_network_foundation_v1.sql:672`
  // (`marketplace_verification_records.status` CHECK).
  driver_application_doc_status: [
    { value: 'submitted', label: 'Submitted', tone: 'info', rank: 10 },
    { value: 'approved', label: 'Approved', tone: 'good', rank: 20 },
    { value: 'rejected', label: 'Rejected', tone: 'danger', rank: 30 },
    { value: 'expired', label: 'Expired', tone: 'warn', rank: 40 },
    { value: 'missing', label: 'Missing', tone: 'warn', rank: 50 },
  ],
});

export const driver_applications = [
  // 1) Pending — fresh submission, attestations partial. Two days old.
  //    Demonstrates the "Approve / Reject / Request docs" decision tree.
  {
    id: 'mpr_drv_4421',
    created_at: '2026-04-24T08:14:00Z',
    updated_at: '2026-04-24T08:14:00Z',
    status: 'pending',
    review_decision: null,
    requested_participant_type_key: 'freelancer_driver',
    email: 'fadi.hijazi@example.com',
    full_name: 'Fadi Hijazi',
    organization_name: 'Fadi Hijazi (sole proprietor)',
    organization_slug: 'fadi-hijazi',
    phone: '+447 70 090 0110',
    website_url: null,
    locale: 'ar-SA',
    page_url: 'https://landing.example.com/become-a-driver',
    referrer: 'https://www.google.com/',
    origin: 'https://landing.example.com',
    experience_summary:
      '6 years freight + last-mile delivery in Riyadh metro; previous fleet at Exampledepot.',
    capabilities_requested: ['last_mile', 'temperature_controlled'],
    verification_documents: [
      {
        type: 'license',
        ref: 'doc_drv4421_license',
        issued_at: '2024-08-01',
        expires_at: '2027-08-01',
        status: 'submitted',
      },
      {
        type: 'national_id',
        ref: 'doc_drv4421_nid',
        issued_at: '2022-11-12',
        expires_at: '2032-11-12',
        status: 'submitted',
      },
      {
        type: 'medical',
        ref: null,
        issued_at: null,
        expires_at: null,
        status: 'missing',
      },
    ],
    marketing: { utm_source: 'google', utm_campaign: 'driver_recruit_2026q2' },
    metadata: { source: 'driver-signup-intake', ip_country: 'SA' },
    turnstile_verified: true,
  },

  // 2) Pending — same-day submission with full attestations (cleanest path
  //    to approval; KPI demonstrates "ready to approve" tone).
  {
    id: 'mpr_drv_4420',
    created_at: '2026-04-26T05:32:00Z',
    updated_at: '2026-04-26T05:32:00Z',
    status: 'pending',
    review_decision: null,
    requested_participant_type_key: 'freelancer_driver',
    email: 'tariq.ammar@example.com',
    full_name: 'Tariq Ammar',
    organization_name: 'Tariq Ammar (sole proprietor)',
    organization_slug: 'tariq-ammar',
    phone: '+447 70 090 0102',
    website_url: null,
    locale: 'en-US',
    page_url: 'https://landing.example.com/become-a-driver',
    referrer: 'https://www.linkedin.com/',
    origin: 'https://landing.example.com',
    experience_summary:
      '3 years owner-operator with refrigerated van; clean compliance record.',
    capabilities_requested: ['cold_chain', 'last_mile'],
    verification_documents: [
      {
        type: 'license',
        ref: 'doc_drv4420_license',
        issued_at: '2024-02-14',
        expires_at: '2029-02-14',
        status: 'submitted',
      },
      {
        type: 'national_id',
        ref: 'doc_drv4420_nid',
        issued_at: '2023-04-02',
        expires_at: '2033-04-02',
        status: 'submitted',
      },
      {
        type: 'medical',
        ref: 'doc_drv4420_medical',
        issued_at: '2025-12-10',
        expires_at: '2026-12-10',
        status: 'submitted',
      },
      {
        type: 'vehicle_inspection',
        ref: 'doc_drv4420_vehinspect',
        issued_at: '2026-01-22',
        expires_at: '2027-01-22',
        status: 'submitted',
      },
    ],
    marketing: { utm_source: 'linkedin', utm_campaign: 'driver_recruit_2026q2' },
    metadata: { source: 'driver-signup-intake', ip_country: 'SA' },
    turnstile_verified: true,
  },

  // 3) Pending — older submission, awaiting reviewer for 12 days
  //    (demonstrates SLA-breach color / KPI delta).
  {
    id: 'mpr_drv_4404',
    created_at: '2026-04-14T11:08:00Z',
    updated_at: '2026-04-14T11:08:00Z',
    status: 'pending',
    review_decision: null,
    requested_participant_type_key: 'freelancer_driver',
    email: 'aisha.naser@example.com',
    full_name: 'Aisha Naser',
    organization_name: 'Aisha Naser (sole proprietor)',
    organization_slug: 'aisha-naser',
    phone: '+447 70 090 0123',
    website_url: null,
    locale: 'ar-SA',
    page_url: 'https://landing.example.com/become-a-driver',
    referrer: null,
    origin: 'https://landing.example.com',
    experience_summary: 'New driver — 8 months delivery experience.',
    capabilities_requested: ['last_mile'],
    verification_documents: [
      {
        type: 'license',
        ref: 'doc_drv4404_license',
        issued_at: '2025-08-12',
        expires_at: '2030-08-12',
        status: 'submitted',
      },
      {
        type: 'national_id',
        ref: 'doc_drv4404_nid',
        issued_at: '2024-03-18',
        expires_at: '2034-03-18',
        status: 'submitted',
      },
    ],
    marketing: { utm_source: 'organic' },
    metadata: { source: 'driver-signup-intake', ip_country: 'SA' },
    turnstile_verified: true,
  },

  // 4) Approved — already onboarded; demonstrates the "decided" branch in the
  //    Decisions tab with `decision_metadata` + reviewer + redirect_to.
  {
    id: 'mpr_drv_4391',
    created_at: '2026-04-08T09:00:00Z',
    updated_at: '2026-04-09T13:22:00Z',
    status: 'approved',
    review_decision: 'approved',
    requested_participant_type_key: 'freelancer_driver',
    email: 'mohammed.zaki@example.com',
    full_name: 'Mohammed Zaki',
    organization_name: 'Mohammed Zaki (sole proprietor)',
    organization_slug: 'mohammed-zaki',
    phone: '+447 70 090 0108',
    website_url: null,
    locale: 'ar-SA',
    page_url: 'https://landing.example.com/become-a-driver',
    referrer: 'https://www.google.com/',
    origin: 'https://landing.example.com',
    experience_summary: '4 years last-mile + B2B delivery for Exampledepot/Examplecourier.',
    capabilities_requested: ['last_mile', 'cold_chain'],
    verification_documents: [
      {
        type: 'license',
        ref: 'doc_drv4391_license',
        issued_at: '2024-07-01',
        expires_at: '2029-07-01',
        status: 'approved',
      },
      {
        type: 'national_id',
        ref: 'doc_drv4391_nid',
        issued_at: '2022-09-15',
        expires_at: '2032-09-15',
        status: 'approved',
      },
      {
        type: 'medical',
        ref: 'doc_drv4391_medical',
        issued_at: '2025-10-04',
        expires_at: '2026-10-04',
        status: 'approved',
      },
    ],
    marketing: { utm_source: 'google', utm_campaign: 'driver_recruit_2026q2' },
    metadata: { source: 'driver-signup-intake', ip_country: 'SA' },
    turnstile_verified: true,
    reviewed_at: '2026-04-09T13:22:00Z',
    reviewed_by: 'usr_admin_rashed',
    review_reason: null,
    decision_metadata: {
      reviewer: 'usr_admin_rashed',
      decision: 'approved',
      checks: { license: 'pass', medical: 'pass', national_id: 'pass' },
    },
    approved_organization_id: 'org_rashed',
    approved_user_id: 'usr_dr_zaki_4391',
    approved_participant_profile_id: 'mpp_drv_zaki_4391',
    invite_email_sent_at: '2026-04-09T13:23:00Z',
    invite_redirect_to: '/onboarding/driver',
  },

  // 5) Rejected — failing license verification; demonstrates the rejection
  //    path with reviewer reason + decision metadata.
  {
    id: 'mpr_drv_4382',
    created_at: '2026-04-04T16:45:00Z',
    updated_at: '2026-04-05T09:11:00Z',
    status: 'rejected',
    review_decision: 'rejected',
    requested_participant_type_key: 'freelancer_driver',
    email: 'yusuf.ali@example.com',
    full_name: 'Yusuf Ali',
    organization_name: 'Yusuf Ali (sole proprietor)',
    organization_slug: 'yusuf-ali',
    phone: '+447 70 090 0126',
    website_url: null,
    locale: 'ar-SA',
    page_url: 'https://landing.example.com/become-a-driver',
    referrer: null,
    origin: 'https://landing.example.com',
    experience_summary: '1 year delivery experience.',
    capabilities_requested: ['last_mile'],
    verification_documents: [
      {
        type: 'license',
        ref: 'doc_drv4382_license',
        issued_at: '2023-08-12',
        expires_at: '2026-02-12', // EXPIRED at submission
        status: 'rejected',
      },
      {
        type: 'national_id',
        ref: 'doc_drv4382_nid',
        issued_at: '2021-11-12',
        expires_at: '2031-11-12',
        status: 'submitted',
      },
    ],
    marketing: { utm_source: 'organic' },
    metadata: { source: 'driver-signup-intake', ip_country: 'SA' },
    turnstile_verified: true,
    reviewed_at: '2026-04-05T09:11:00Z',
    reviewed_by: 'usr_admin_rashed',
    review_reason: 'license_expired_at_submission',
    decision_metadata: {
      reviewer: 'usr_admin_rashed',
      decision: 'rejected',
      reason: 'license_expired_at_submission',
      checks: { license: 'fail', national_id: 'pass' },
    },
  },

  // 6) Pending — applicant in dedupe state (already approved profile exists
  //    for this email; UI must surface the merge-or-decline decision).
  {
    id: 'mpr_drv_4377',
    created_at: '2026-04-02T07:30:00Z',
    updated_at: '2026-04-02T07:30:00Z',
    status: 'pending',
    review_decision: null,
    requested_participant_type_key: 'freelancer_driver',
    email: 'salem.qasim@example.com',
    full_name: 'Salem Qasim',
    organization_name: 'Salem Qasim (sole proprietor)',
    organization_slug: 'salem-qasim',
    phone: '+447 70 090 0100',
    website_url: null,
    locale: 'ar-SA',
    page_url: 'https://landing.example.com/become-a-driver',
    referrer: null,
    origin: 'https://landing.example.com',
    experience_summary: '5 years; previous platform driver.',
    capabilities_requested: ['last_mile', 'hazmat'],
    verification_documents: [
      {
        type: 'license',
        ref: 'doc_drv4377_license',
        issued_at: '2025-01-22',
        expires_at: '2030-01-22',
        status: 'submitted',
      },
      {
        type: 'national_id',
        ref: 'doc_drv4377_nid',
        issued_at: '2023-06-04',
        expires_at: '2033-06-04',
        status: 'submitted',
      },
      {
        type: 'hazmat_endorsement',
        ref: 'doc_drv4377_hazmat',
        issued_at: '2025-09-12',
        expires_at: '2026-09-12',
        status: 'submitted',
      },
    ],
    marketing: { utm_source: 'organic' },
    metadata: {
      source: 'driver-signup-intake',
      ip_country: 'SA',
      dedupe_hint: 'existing_profile_email_match',
    },
    turnstile_verified: true,
  },
];
