// identity-sessions.js — operator-visible auth sessions roster (Phase E2).
//
// Architectural reality (anchored in supabase/migrations/202604280200…+0212):
//   Supabase manages user sessions in `auth.sessions` (auth schema, server-
//   internal). The canonical revoke path is the Phase B6 RPC
//   `public.revoke_session_v1(p_args jsonb)` which writes a revocation INTENT
//   row into `public.revocation_audit` (status='pending') and emits
//   `domain_events.session.revocation_requested`; an out-of-band edge worker
//   then calls Supabase Admin API `auth.admin.signOut(user_id)` and marks the
//   row processed_at + status ∈ ('completed','failed').
//
// Production cutover plan:
//   The recommended SSOT is to expose a tenant-scoped RLS view
//   `public.user_sessions_v` that joins `auth.sessions` (read-only) with
//   `public.users` for visibility, gated by:
//     - `users.read`   → caller can view their own sessions only
//     - `users.manage` → caller can view any user's sessions in scope
//   The view's column set mirrors `auth.sessions` (id, user_id, created_at,
//   updated_at, factor_id, aal, not_after, user_agent, ip) joined with
//   `public.users.email`. Demo mode below synthesizes a structurally identical
//   row shape so the swap-seam is environment-only — modules consume
//   `useResourceList<UserSessionRow>('user_sessions')` without a code change at
//   cutover.
//
// Row shape:
//   id            UUID            session id (matches auth.sessions.id)
//   user_id       UUID            owning user id
//   user_email    TEXT            joined from public.users for operator readability
//   user_agent    TEXT            client UA (auth.sessions.user_agent)
//   ip            INET            client IP (auth.sessions.ip)
//   aal           TEXT            assurance level: aal1 / aal2 / aal3
//   factor_id     UUID|null       MFA factor (auth.sessions.factor_id)
//   created_at    TIMESTAMPTZ     session creation
//   updated_at    TIMESTAMPTZ     last refresh / activity
//   not_after     TIMESTAMPTZ     hard expiry (auth.sessions.not_after)
//   is_current    BOOLEAN         derived: current session for `current_user`

const now = new Date('2026-04-25T13:30:00Z').getTime();
const minutesAgo = (m) => new Date(now - m * 60000).toISOString();
const daysAhead = (d) => new Date(now + d * 86400000).toISOString();

export const user_sessions = [
  {
    id: 'ssn_8a3c1f04-0001-4000-8000-000000000001',
    user_id: 'usr_admin_rashed',
    user_email: 'rashed@rashed-logistics.example',
    user_agent:
      'Mozilla/5.0 (Macintosh; Intel Mac OS X 14.4; rv:124.0) Gecko/20100101 Firefox/124.0',
    ip: '203.0.113.45',
    aal: 'aal2',
    factor_id: 'fct_totp_rashed_macbook',
    created_at: minutesAgo(60),
    updated_at: minutesAgo(2),
    not_after: daysAhead(7),
    is_current: true,
  },
  {
    id: 'ssn_8a3c1f04-0001-4000-8000-000000000002',
    user_id: 'usr_admin_rashed',
    user_email: 'rashed@rashed-logistics.example',
    user_agent:
      'Mozilla/5.0 (iPhone; CPU iPhone OS 17_4 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Mobile/15E148 Safari/604.1',
    ip: '203.0.113.111',
    aal: 'aal2',
    factor_id: 'fct_totp_rashed_iphone',
    created_at: minutesAgo(180),
    updated_at: minutesAgo(45),
    not_after: daysAhead(7),
    is_current: false,
  },
  {
    id: 'ssn_8a3c1f04-0002-4000-8000-000000000003',
    user_id: 'usr_ops_admin_layla',
    user_email: 'layla.ops@rashed-logistics.example',
    user_agent:
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
    ip: '198.51.100.27',
    aal: 'aal1',
    factor_id: null,
    created_at: minutesAgo(420),
    updated_at: minutesAgo(8),
    not_after: daysAhead(7),
    is_current: false,
  },
  {
    id: 'ssn_8a3c1f04-0003-4000-8000-000000000004',
    user_id: 'usr_acct_mgr_omar',
    user_email: 'omar.am@rashed-logistics.example',
    user_agent:
      'Mozilla/5.0 (Linux; Android 14; SM-A546B) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Mobile Safari/537.36',
    ip: '198.51.100.119',
    aal: 'aal2',
    factor_id: 'fct_totp_omar_pixel',
    created_at: minutesAgo(720),
    updated_at: minutesAgo(15),
    not_after: daysAhead(7),
    is_current: false,
  },
  {
    id: 'ssn_8a3c1f04-0003-4000-8000-000000000005',
    user_id: 'usr_acct_mgr_omar',
    user_email: 'omar.am@rashed-logistics.example',
    user_agent:
      'Mozilla/5.0 (Macintosh; Intel Mac OS X 14_4) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Safari/605.1.15',
    ip: '198.51.100.99',
    aal: 'aal1',
    factor_id: null,
    created_at: minutesAgo(1440),
    updated_at: minutesAgo(60),
    not_after: daysAhead(6),
    is_current: false,
  },
];

// Lookup catalog — DataTable resolves the `aal` column lookup pill
// (registry.js:user_sessions.columns) from `lookups.session_aal`. AAL
// semantics mirror supabase auth: aal1 = single factor, aal2 = MFA, aal3 =
// MFA + biometric/hardware key. Tones follow the canonical chip palette
// (good = MFA strong, warn = single factor, info = highest assurance).
//
// Lookup additions are injected via Object.assign(lookups, ...) at import
// time so concurrent Phase E agents land additively (same pattern as
// fleet-vehicles.js, catalog-offerings.js, insights-apigw.js).
import { lookups } from './lookups.js';

Object.assign(lookups, {
  session_aal: [
    { value: 'aal1', label: 'AAL1', tone: 'warn', rank: 1 },
    { value: 'aal2', label: 'AAL2', tone: 'good', rank: 2 },
    { value: 'aal3', label: 'AAL3', tone: 'info', rank: 3 },
  ],
});
