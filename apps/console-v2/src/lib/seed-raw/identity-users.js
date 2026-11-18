// identity-users.js — operator-visible users roster (Phase D4 — CLAIM-PLATFORM-USERS).
//
// Mirrors the canonical `public.users` projection from:
//   - supabase/migrations/202510110002_configuration_core.sql:41-52
//     (id, organization_id, email, full_name, user_type, status,
//     created_at, last_login_at).
//   - supabase/migrations/202512291310_users_access_scope_model.sql:13-29
//     (access_scope_type, access_scope_id with CHECK constraint).
//   - supabase/migrations/202601041120_users_rls.sql — RLS gate that
//     enforces tenant scope on the SELECT path.
//
// Capability gating mirrors backend SSOT
//   supabase/migrations/202601022113_access_control_policy_core.sql:216-217:
//   - `users.read`   gates the table read.
//   - `users.manage` gates Grant role / Revoke role / Suspend / Reactivate /
//                     Force-password-reset / Revoke session actions.
//
// The user_id values match the `usr_*` keys already used by the
// identity-sessions.js seed so the Sessions tab in the users drawer can
// resolve sessions by user without fabricating cross-references.
//
// Demo data covers the 5 canonical roles + the 3 lifecycle statuses
// (active / invited / suspended) so KPI strip totals + filter pivots have
// realistic values for the screenshot iteration loop.

const now = new Date('2026-04-25T13:30:00Z').getTime();
const minutesAgo = (m) => new Date(now - m * 60000).toISOString();
const daysAgo = (d) => new Date(now - d * 86400000).toISOString();

export const users = [
  {
    id: 'usr_admin_rashed',
    organization_id: 'org_rashed',
    email: 'rashed@rashed-logistics.example',
    full_name: 'Rashed Al-Otaibi',
    user_type: 'super_admin',
    access_scope_type: 'platform',
    access_scope_id: null,
    status: 'active',
    last_login_at: minutesAgo(2),
    created_at: daysAgo(360),
  },
  {
    id: 'usr_ops_admin_layla',
    organization_id: 'org_rashed',
    email: 'layla.ops@rashed-logistics.example',
    full_name: 'Layla Bin Saeed',
    user_type: 'ops_admin',
    access_scope_type: 'tenant',
    access_scope_id: 'org_rashed',
    status: 'active',
    last_login_at: minutesAgo(8),
    created_at: daysAgo(240),
  },
  {
    id: 'usr_ops_admin_yousef',
    organization_id: 'org_rashed',
    email: 'yousef.ops@rashed-logistics.example',
    full_name: 'Yousef Al-Rumaih',
    user_type: 'ops_admin',
    access_scope_type: 'tenant',
    access_scope_id: 'org_rashed',
    status: 'active',
    last_login_at: minutesAgo(75),
    created_at: daysAgo(190),
  },
  {
    id: 'usr_acct_mgr_omar',
    organization_id: 'org_rashed',
    email: 'omar.am@rashed-logistics.example',
    full_name: 'Omar Al-Ghamdi',
    user_type: 'account_manager',
    access_scope_type: 'tenant',
    access_scope_id: 'org_rashed',
    status: 'active',
    last_login_at: minutesAgo(15),
    created_at: daysAgo(150),
  },
  {
    id: 'usr_acct_mgr_huda',
    organization_id: 'org_rashed',
    email: 'huda.am@rashed-logistics.example',
    full_name: 'Huda Al-Subaie',
    user_type: 'account_manager',
    access_scope_type: 'tenant',
    access_scope_id: 'org_rashed',
    status: 'invited',
    last_login_at: null,
    created_at: daysAgo(2),
  },
  {
    id: 'usr_client_admin_exampleparcel',
    organization_id: 'org_rashed',
    email: 'fleet-admin@exampleparcel-ksa.example',
    full_name: 'Mona Al-Hashimi',
    user_type: 'client_admin',
    access_scope_type: 'client',
    access_scope_id: 'cli_exampleparcel_ksa',
    status: 'active',
    last_login_at: minutesAgo(45),
    created_at: daysAgo(120),
  },
  {
    id: 'usr_client_admin_examplemart',
    organization_id: 'org_rashed',
    email: 'ops@examplemart-ksa.example',
    full_name: 'Khalid Al-Mutairi',
    user_type: 'client_admin',
    access_scope_type: 'client',
    access_scope_id: 'cli_examplemart_ksa',
    status: 'suspended',
    last_login_at: daysAgo(14),
    created_at: daysAgo(310),
  },
  {
    id: 'usr_sender_exampleoutlet',
    organization_id: 'org_rashed',
    email: 'shipping@exampleoutlet.example',
    full_name: 'Tariq Al-Anazi',
    user_type: 'sender_user',
    access_scope_type: 'sender',
    access_scope_id: 'snd_exampleoutlet_main',
    status: 'active',
    last_login_at: minutesAgo(120),
    created_at: daysAgo(85),
  },
  {
    id: 'usr_sender_exampleretail',
    organization_id: 'org_rashed',
    email: 'logistics@exampleretail-ksa.example',
    full_name: 'Sara Al-Dosari',
    user_type: 'sender_user',
    access_scope_type: 'sender',
    access_scope_id: 'snd_exampleretail_main',
    status: 'invited',
    last_login_at: null,
    created_at: daysAgo(3),
  },
];
