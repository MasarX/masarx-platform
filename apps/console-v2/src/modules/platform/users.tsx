// users.tsx — operator-visible users admin (Phase D4 — CLAIM-PLATFORM-USERS).
//
// IDENTITY cross-walk audit (P0 gap): until this surface lands, the operator
// console had no UI path to grant/revoke roles, suspend or reactivate users,
// force a password reset, or list/revoke registered devices. The 5-step canonical
// data flow is preserved end-to-end:
//
//   • Read seam — `useCompleteResourceList<UserRow>('users')` mirrors the canonical
//     public.users projection (id, organization_id, email, full_name,
//     user_type, access_scope_type, access_scope_id, status, last_login_at,
//     created_at) per supabase/migrations/202510110002_configuration_core.sql:
//     41-52 + 202512291310_users_access_scope_model.sql:13-29.
//   • Device seam — `UserDevicesList` reads `user_device_summary`, the
//     canonical v_user_device_summary projection over public.user_devices; the
//     per-row Revoke action routes through ui_execute_user_device_revoke_v1.
//   • Capability evaluator seam — `useUserCapabilityEval(...)` per
//     supabase/migrations/202601022113_access_control_policy_core.sql:764
//     (canonical public.user_capability_eval_v1) drives the Capabilities tab
//     so operators can see the override-ladder path that produced each
//     allow/deny decision.
//   • Role / lifecycle write seams — `useGrantUserRole`, `useRevokeUserRole`,
//     `useSuspendUser`, `useReactivateUser`, `useForcePasswordReset` route
//     through the canonical Phase C6 *_v1 RPCs (W37-IDENTITY closure):
//     `grant_user_role_v1`, `revoke_user_role_v1`, `suspend_user_v1`,
//     `reactivate_user_v1`, `force_password_reset_v1` per
//     supabase/migrations/202604300300..202604300340. Each RPC asserts
//     `users.manage` server-side; the FE capability gate stays
//     `users.manage`; device revocation stays under `user_devices.write`.
//
// Capability gates anchor on the backend SSOT
//   supabase/migrations/202601022113_access_control_policy_core.sql:216-217:
//   - `users.read`   gates the table read + drawer mount.
//   - `users.manage` gates Grant role / Revoke role / Suspend / Reactivate /
//                     Force password reset actions.
//   - `user_devices.write` gates per-device revocation.

import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { PageHeader } from '@/components/PageHeader';
import { DataTable, type DataTableColumn } from '@/components/DataTable';
import { StateView } from '@/components/StateView';
import { Button } from '@/components/Button';
import { Drawer } from '@/components/Drawer';
import { Chip } from '@/components/Chip';
import { KPICard } from '@/components/KPICard';
import { KvGrid, type KvRow } from '@/components/KvGrid';
import { CapabilityEvalDrilldown } from '@/components/CapabilityEvalDrilldown';
import { UserDevicesList } from '@/components/UserDevicesList';
import { SessionsList } from '@/components/SessionsList';
import { useModal } from '@/hooks/useOverlay';
import { useCapability, useIdentity } from '@/lib/identity';
import { CAP } from '@/lib/capabilities';
import {
  useCompleteResourceList,
  useResourceList,
  useGrantUserRole,
  useRevokeUserRole,
  useSuspendUser,
  useReactivateUser,
  useForcePasswordReset,
  useUserSecurityActions,
  useResolveAccessPolicy,
  useTenantInvitableRoles,
  useTenantUserInvite,
} from '@/lib/queries';
import { pushToast } from '@/components/toastStore';
import { getLookups, lookupRow } from '@/lib/api';
import type { UserSecurityActionRow } from '@/lib/api';
import { hostedInviteRedirect } from '@/lib/hosted-redirect';
import { readAuthorizedTenantOrganizationOverride } from '@/lib/scope-url';
import { readUrlParam } from '@/lib/url-params';
import { fill, useI18n, type Translate } from '@/lib/i18n';

// Canonical user projection — mirrors public.users column shape (only the
// columns surfaced to the operator UI; the production projection includes
// audit columns we do not need at the table level).
//
// W19-3 paired-RPC closure (2026-04-27) — see __audit__/SCHEMA-DRIFT/IDENTITY.md
// (W19-3 closure section). UserRow is canonical-aligned 1:1 with public.users
// (`supabase/migrations/202510110002_configuration_core.sql:41-52` +
//  `202512291310_users_access_scope_model.sql:13-29`); every field below is a
// canonical column on public.users with no projection or fictional drift. The
// FE-self-projection variant `User` in `types/domain.ts` carries the deferred
// renames (`name → full_name`, `role → user_type`, drop `initials`,
// `capabilities`) — those are NOT a UserRow concern; they belong to the
// identity-self shim consumed by `useIdentity()`.
export interface UserRow extends Record<string, unknown> {
  id: string;                                // SSOT: users.id
  organization_id?: string;                  // SSOT: users.organization_id
  email: string;                             // SSOT: users.email
  full_name?: string;                        // SSOT: users.full_name
  user_type: string;                         // SSOT: users.user_type
  access_scope_type?: string;                // SSOT: users.access_scope_type (4-tier access model)
  access_scope_id?: string | null;           // SSOT: users.access_scope_id (NULL for platform/tenant)
  status: string;                            // SSOT: users.status
  last_login_at?: string | null;             // SSOT: users.last_login_at
  created_at?: string;                       // SSOT: users.created_at
}

// W23 paired projection — public.v_user_directory
// (supabase/migrations/202604302200_v_user_directory.sql). The directory
// row is consumed additively to render the organization label, active
// role rollups, and tier flags in the drawer without inventing FE-only
// fields. Production cutover is a single getSupabaseClient() branch
// flip in `ui_list_resource_v1('user_directory')`.
export interface UserDirectoryRow extends Record<string, unknown> {
  id: string;                                // SSOT: users.id
  organization_id: string | null;            // SSOT: users.organization_id
  email: string | null;                      // SSOT: users.email
  full_name: string | null;                  // SSOT: users.full_name
  user_type: string | null;                  // SSOT: users.user_type
  status: string | null;                     // SSOT: users.status
  access_scope_type: string | null;          // SSOT: users.access_scope_type
  access_scope_id: string | null;            // SSOT: users.access_scope_id
  created_at: string | null;                 // SSOT: users.created_at
  last_login_at: string | null;              // SSOT: users.last_login_at
  organization_label: string | null;         // SSOT: projection — organizations.name via organization_id join
  organization_slug: string | null;          // SSOT: projection — organizations.slug via organization_id join
  access_scope_label: string | null;         // SSOT: projection — initcap(access_scope_type)
  active_role_count: number;                 // SSOT: projection — count(rbac_user_role_assignments WHERE user_id=id AND revoked_at IS NULL)
  active_role_keys: string[];                // SSOT: projection — array_agg(rbac_roles.key) via rbac_user_role_assignments active join
  is_platform_user: boolean;                 // SSOT: projection — access_scope_type='platform'
  is_tenant_user: boolean;                   // SSOT: projection — access_scope_type='tenant'
  is_client_user: boolean;                   // SSOT: projection — access_scope_type='client'
  is_sender_user: boolean;                   // SSOT: projection — access_scope_type='sender'
}

// The table role chip still renders the immutable users.user_type lookup, while
// grant/invite choices come from tenant RBAC roles through
// ui_list_tenant_invitable_roles_v1.
function userColumns(t: Translate): DataTableColumn<UserRow>[] {
  return [
    { key: 'full_name', label: t('platformUsers.usersModule.name'), sortable: true, filterable: true },
    { key: 'email', label: t('platformUsers.usersModule.email'), mono: true, sortable: true, filterable: true },
    { key: 'user_type', label: t('platformUsers.usersModule.role'), sortable: true, filterable: true, lookup: 'user_type' },
    { key: 'access_scope_type', label: t('platformUsers.usersModule.scope'), sortable: true, filterable: true },
    { key: 'access_scope_id', label: t('platformUsers.usersModule.scopeId'), mono: true, sortable: true, filterable: true },
    { key: 'status', label: t('platformUsers.usersModule.status'), sortable: true, filterable: true, lookup: 'user_status' },
    { key: 'last_login_at', label: t('platformUsers.usersModule.lastLogin'), format: 'datetime', sortable: true },
    { key: 'created_at', label: t('platformUsers.usersModule.created'), format: 'datetime', sortable: true },
  ];
}

interface RoleCatalogRow extends Record<string, unknown> {
  id?: string;
  role_id?: string;
  key?: string;
  role_key?: string;
  name?: string;
  description?: string | null;
  is_active?: boolean;
}

interface LookupValueRow extends Record<string, unknown> {
  value: string;
  label?: string;
  rank?: number;
  is_default?: boolean;
  metadata?: Record<string, unknown> | null;
}

interface RoleOption {
  key: string;
  label: string;
  description: string | null;
}

interface AccessScopeOption {
  value: string;
  label?: string;
  rank?: number;
  is_default?: boolean;
  metadata?: Record<string, unknown> | null;
}

interface ScopeReferenceOption {
  id: string;
  label: string;
}

interface InviteClientReferenceRow extends Record<string, unknown> {
  id?: string;
  client_id?: string;
  name?: string | null;
  slug?: string | null;
  status?: string | null;
}

interface InviteSenderReferenceRow extends Record<string, unknown> {
  id?: string;
  sender_id?: string;
  name?: string | null;
  brand_name?: string | null;
  client_label?: string | null;
  status?: string | null;
}

function roleOptionsFromRows(rows: RoleCatalogRow[] | undefined): RoleOption[] {
  const options = (rows ?? [])
    .filter((row) => row.is_active !== false)
    .map((row) => {
      const key = String(row.role_key ?? row.key ?? '').trim();
      if (!key) return null;
      return {
        key,
        label: String(row.name ?? key),
        description: typeof row.description === 'string' ? row.description : null,
      };
    })
    .filter((row): row is RoleOption => row !== null);

  if (rows) {
    return options.sort((a, b) => a.key.localeCompare(b.key));
  }
  return [];
}

function scopeReferenceMatchesSearch(option: ScopeReferenceOption, search: string): boolean {
  const normalized = search.trim().toLowerCase();
  if (!normalized) return true;
  return `${option.label} ${option.id}`.toLowerCase().includes(normalized);
}

function clientScopeReferenceOptions(rows: InviteClientReferenceRow[] | undefined): ScopeReferenceOption[] {
  return (rows ?? [])
    .map((row) => {
      const id = String(row.client_id ?? row.id ?? '').trim();
      if (!id) return null;
      const label = String(row.name ?? row.slug ?? id).trim() || 'Unnamed client';
      const status = String(row.status ?? '').trim();
      return {
        id,
        label: [label, status ? `status=${status}` : ''].filter(Boolean).join(' - '),
      };
    })
    .filter((row): row is ScopeReferenceOption => row !== null)
    .sort((a, b) => a.label.localeCompare(b.label));
}

function senderScopeReferenceOptions(rows: InviteSenderReferenceRow[] | undefined): ScopeReferenceOption[] {
  return (rows ?? [])
    .map((row) => {
      const id = String(row.sender_id ?? row.id ?? '').trim();
      if (!id) return null;
      const label = String(row.name ?? row.brand_name ?? id).trim() || 'Unnamed sender';
      const client = String(row.client_label ?? '').trim();
      const status = String(row.status ?? '').trim();
      return {
        id,
        label: [label, client ? `client=${client}` : '', status ? `status=${status}` : '']
          .filter(Boolean)
          .join(' - '),
      };
    })
    .filter((row): row is ScopeReferenceOption => row !== null)
    .sort((a, b) => a.label.localeCompare(b.label));
}

function defaultRoleKey(roleOptions: RoleOption[]): string {
  const fallbackDefault = getLookups('user_type')
    .slice()
    .sort((a, b) => (a.rank ?? 0) - (b.rank ?? 0))
    .find((r) => r.is_default)?.value;
  return roleOptions.find((r) => r.key === fallbackDefault)?.key ?? roleOptions[0]?.key ?? '';
}

function accessScopeRequiresId(scopeType: string, options: AccessScopeOption[] = []): boolean {
  const option = options.find((row) => row.value === scopeType);
  return (
    option?.metadata?.requires_scope_id === true ||
    lookupRow('access_scope_type', scopeType)?.metadata?.requires_scope_id === true
  );
}

function defaultInviteAccessScope(
  rows: AccessScopeOption[],
  preferredScopeType: string | null | undefined,
): string {
  const preferred = (preferredScopeType ?? '').trim();
  if (preferred && (rows.length === 0 || rows.some((row) => row.value === preferred))) {
    return preferred;
  }
  return rows.find((row) => row.is_default)?.value ?? rows[0]?.value ?? 'tenant';
}

function isInviteEmailValid(value: string): boolean {
  const trimmed = value.trim();
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(trimmed);
}

function userRowFromDirectory(row: UserDirectoryRow): UserRow {
  return {
    id: row.id,
    organization_id: row.organization_id ?? undefined,
    email: row.email ?? row.id,
    full_name: row.full_name ?? undefined,
    user_type: row.user_type ?? 'unknown',
    access_scope_type: row.access_scope_type ?? undefined,
    access_scope_id: row.access_scope_id ?? null,
    status: row.status ?? 'unknown',
    last_login_at: row.last_login_at ?? null,
    created_at: row.created_at ?? undefined,
  };
}

function accessScopeOptionsFromRows(rows: LookupValueRow[] | undefined): AccessScopeOption[] {
  const liveRows = rows ?? [];
  const sourceRows = liveRows.length > 0
    ? liveRows
    : (getLookups('access_scope_type') as LookupValueRow[]);
  return sourceRows
    .map((row) => ({
      value: String(row.value ?? '').trim(),
      label: row.label,
      rank: row.rank,
      is_default: row.is_default,
      metadata: row.metadata ?? null,
    }))
    .filter((row) => row.value.length > 0);
}

function usersReadErrorMessage(reason: unknown): string {
  return reason instanceof Error && reason.message
    ? reason.message
    : 'The user list could not be loaded.';
}

function formatSecurityActionTimestamp(value: string | null | undefined): string {
  if (!value) return 'Pending timestamp';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleString();
}

function securityActionLabel(row: UserSecurityActionRow, t: Translate): string {
  const inviteEmailSent =
    row.invite_email_sent === 'true' ||
    row.decision_inputs?.invite_email_sent === true ||
    row.decision_inputs?.invite_email_sent === 'true';
  switch (row.decision_point) {
    case 'force_password_reset_v1':
      return t('platformUsers.securityAction.passwordResetRequested');
    case 'tenant_user_invite_apply_v1':
      return row.decision_outcome === 'idempotent_existing_assignment' && inviteEmailSent
        ? t('platformUsers.securityAction.inviteEmailResent')
        : t('platformUsers.securityAction.inviteDecisionRecorded');
    case 'tenant_user_invite_accept_v1':
      return t('platformUsers.securityAction.inviteAccepted');
    case 'grant_user_role_v1':
      return t('platformUsers.securityAction.roleGranted');
    case 'revoke_user_role_v1':
      return t('platformUsers.securityAction.roleRevoked');
    case 'revoke_session_v1':
      return t('platformUsers.securityAction.sessionRevokeRequested');
    case 'suspend_user_v1':
      return t('platformUsers.securityAction.userSuspended');
    case 'reactivate_user_v1':
      return t('platformUsers.securityAction.userReactivated');
    default:
      return String(row.decision_point ?? row.decision_category ?? t('platformUsers.securityAction.userSecurityAction'));
  }
}

function securityOutcomeTone(outcome: unknown): 'good' | 'warn' | 'danger' | 'info' | 'neutral' {
  const normalized = String(outcome ?? '').toLowerCase();
  if (['approved', 'completed', 'success', 'succeeded'].includes(normalized)) return 'good';
  if (['pending', 'queued', 'processing'].includes(normalized)) return 'warn';
  if (['failed', 'rejected', 'denied'].includes(normalized)) return 'danger';
  if (normalized.length > 0) return 'info';
  return 'neutral';
}

// W50 — Status filter chips derive from the canonical `user_status` lookup
// (already registered in lookup_definitions; mirrored in seed-raw/lookups.js
// with `metadata.tone`). `'all'` sentinel prepends the canonical values for
// the "show all" chip; if the canonical lookup is empty, the chip toolbar
// surfaces a `<StateView kind="error" />` instead of degrading silently.
type StatusFilter = string;

type DrawerTabId = 'profile' | 'roles' | 'capabilities' | 'devices' | 'sessions';
function drawerTabs(t: Translate): Array<{ id: DrawerTabId; label: string }> {
  return [
    { id: 'profile', label: t('platformUsers.usersDrawerBody.profile') },
    { id: 'roles', label: t('platformUsers.usersDrawerBody.roles') },
    { id: 'capabilities', label: t('platformUsers.usersDrawerBody.capabilities') },
    { id: 'devices', label: t('platformUsers.usersDrawerBody.devices') },
    { id: 'sessions', label: t('platformUsers.usersDrawerBody.sessions') },
  ];
}

// ─── Profile tab — KvGrid summary of the canonical user projection ──────
//
// W23 — additive consumption of `v_user_directory` projection. When a
// matching directory row is available, the Profile tab renders the
// joined organization label and active-role rollups underneath the
// canonical KvGrid. The base `useResourceList<UserRow>('users')` seam
// is unchanged so the surface degrades gracefully when the projection
// cache has not yet hydrated.
function ProfileTab({
  user,
  directory,
}: {
  user: UserRow;
  directory?: UserDirectoryRow;
}) {
  const { t } = useI18n();
  const rows: KvRow[] = [
    { key: 'id', label: t('platformUsers.profileTab.userId'), value: user.id, mono: true, editable: false },
    { key: 'email', label: t('platformUsers.profileTab.email'), value: user.email, mono: true, editable: false },
    { key: 'full_name', label: t('platformUsers.profileTab.name'), value: user.full_name, editable: false },
    {
      key: 'user_type',
      label: t('platformUsers.profileTab.role'),
      value: user.user_type,
      lookup: 'user_type',
      editable: false,
    },
    {
      key: 'status',
      label: t('platformUsers.profileTab.status'),
      value: user.status,
      lookup: 'user_status',
      editable: false,
    },
    {
      key: 'access_scope_type',
      label: t('platformUsers.profileTab.accessScope'),
      value: directory?.access_scope_label ?? user.access_scope_type ?? '—',
      editable: false,
    },
    {
      key: 'access_scope_id',
      label: t('platformUsers.profileTab.accessScopeId'),
      value: user.access_scope_id ?? '—',
      mono: true,
      editable: false,
    },
    {
      key: 'organization',
      label: t('platformUsers.profileTab.organization'),
      value: directory?.organization_label ?? user.organization_id ?? '—',
      editable: false,
    },
    {
      key: 'organization_id',
      label: t('platformUsers.profileTab.organizationId'),
      value: user.organization_id ?? '—',
      mono: true,
      editable: false,
    },
    {
      key: 'last_login_at',
      label: t('platformUsers.profileTab.lastLogin'),
      value: user.last_login_at ?? '—',
      mono: true,
      editable: false,
    },
    {
      key: 'created_at',
      label: t('platformUsers.profileTab.created'),
      value: user.created_at ?? '—',
      mono: true,
      editable: false,
    },
  ];
  const activeRoleCount = directory?.active_role_count ?? 0;
  const activeRoleKeys = directory?.active_role_keys ?? [];
  return (
    <div data-testid="users-drawer-profile">
      <div className="section-eyebrow">{t('platformUsers.profileTab.userProfile')}</div>
      <KvGrid rows={rows} />
      {directory ? (
        <div
          className="state__hint"
          data-testid="users-drawer-active-roles"
          style={{ padding: '8px 14px 12px', fontSize: 11.5 }}
        >
          <span>{t('platformUsers.profileTab.directoryProfile')}</span> ·{' '}
          <span data-testid="users-drawer-active-role-count">
            {fill(t(activeRoleCount === 1 ? 'platformUsers.profileTab.activeRoleOne' : 'platformUsers.profileTab.activeRoleOther'), { activeRoleCount: String(activeRoleCount) })}
          </span>
          {activeRoleKeys.length > 0 ? (
            <span style={{ marginLeft: 6 }}>
              ·{' '}
              <span className="mono" data-testid="users-drawer-active-role-keys">
                {activeRoleKeys.join(', ')}
              </span>
            </span>
          ) : null}
        </div>
      ) : null}
      <UserSecurityActions user={user} />
    </div>
  );
}

// ─── Roles tab — Grant / Revoke role actions ─────────────────────────────
function UserSecurityActions({ user }: { user: UserRow }) {
  const { t } = useI18n();
  const actionsQuery = useUserSecurityActions(user.id, 5);
  const rows = actionsQuery.data?.rows ?? [];

  return (
    <div
      data-testid="users-security-actions"
      style={{ borderTop: '1px solid var(--line)', marginTop: 6, paddingTop: 10 }}
    >
      <div className="section-eyebrow">{t('platformUsers.userSecurityActions.securityActionEvidence')}</div>
      {actionsQuery.isLoading ? (
        <StateView kind="loading" />
      ) : actionsQuery.isError ? (
        <StateView
          kind="error"
          title={t('platformUsers.userSecurityActions.securityActionCouldNot')}
          hint={usersReadErrorMessage(actionsQuery.error)}
        />
      ) : rows.length === 0 ? (
        <StateView
          kind="empty"
          title={t('platformUsers.userSecurityActions.noSecurityActionsYet')}
          hint={t('platformUsers.userSecurityActions.passwordResetsSessionRevokes')}
        />
      ) : (
        <ul
          aria-label={t('platformUsers.userSecurityActions.userSecurityActionEvidence')}
          data-testid="users-security-actions-list"
          style={{ listStyle: 'none', margin: 0, padding: '0 14px 12px' }}
        >
          {rows.map((row) => {
            const passwordResetIntentId =
              typeof row.password_reset_intent_id === 'string'
                ? row.password_reset_intent_id
                : typeof row.decision_inputs?.password_reset_intent_id === 'string'
                  ? row.decision_inputs.password_reset_intent_id
                  : null;
            const roleKey =
              typeof row.role_key === 'string'
                ? row.role_key
                : typeof row.decision_inputs?.role_key === 'string'
                  ? row.decision_inputs.role_key
                  : null;
            const reason =
              typeof row.action_reason === 'string'
                ? row.action_reason
                : typeof row.decision_reason === 'string'
                  ? row.decision_reason
                  : typeof row.decision_inputs?.reason === 'string'
                    ? row.decision_inputs.reason
                    : null;
            const sessionId =
              typeof row.session_id === 'string'
                ? row.session_id
                : typeof row.decision_inputs?.session_id === 'string'
                  ? row.decision_inputs.session_id
                  : null;
            const inviteEmail =
              typeof row.invite_email === 'string'
                ? row.invite_email
                : typeof row.decision_inputs?.email === 'string'
                  ? row.decision_inputs.email
                  : null;
            const sendInviteEmailRequested =
              typeof row.send_invite_email_requested === 'string'
                ? row.send_invite_email_requested
                : typeof row.decision_inputs?.send_invite_email_requested === 'boolean'
                  ? row.decision_inputs.send_invite_email_requested ? 'yes' : 'no'
                  : typeof row.decision_inputs?.send_invite_email_requested === 'string'
                    ? row.decision_inputs.send_invite_email_requested
                    : null;
            const inviteEmailSent =
              typeof row.invite_email_sent === 'string'
                ? row.invite_email_sent
                : typeof row.decision_inputs?.invite_email_sent === 'boolean'
                  ? row.decision_inputs.invite_email_sent ? 'yes' : 'no'
                  : typeof row.decision_inputs?.invite_email_sent === 'string'
                    ? row.decision_inputs.invite_email_sent
                    : null;
            const inviteRedirectTo =
              typeof row.invite_redirect_to === 'string'
                ? row.invite_redirect_to
                : typeof row.decision_inputs?.invite_redirect_to === 'string'
                  ? row.decision_inputs.invite_redirect_to
                  : null;
            const inviteRedirectRecorded =
              Object.prototype.hasOwnProperty.call(row.decision_inputs ?? {}, 'invite_redirect_to') ||
              (typeof row.invite_redirect_to === 'string' && row.invite_redirect_to.trim().length > 0);
            const inviteAcceptedFrom =
              typeof row.accepted_from_status === 'string'
                ? row.accepted_from_status
                : typeof row.decision_inputs?.accepted_from_status === 'string'
                ? row.decision_inputs.accepted_from_status
                : null;
            const inviteAcceptedTo =
              typeof row.accepted_to_status === 'string'
                ? row.accepted_to_status
                : typeof row.decision_inputs?.accepted_to_status === 'string'
                ? row.decision_inputs.accepted_to_status
                : null;
            const hasInviteRedirectEvidence =
              row.decision_point === 'tenant_user_invite_apply_v1' ||
              Boolean(inviteEmail || sendInviteEmailRequested || inviteEmailSent);
            return (
              <li
                key={row.id}
                data-testid={`users-security-action-${row.id}`}
                style={{
                  borderTop: '1px solid var(--line)',
                  display: 'grid',
                  gap: 4,
                  padding: '8px 0',
                }}
              >
                <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
                  <strong style={{ fontSize: 12.5 }}>{securityActionLabel(row, t)}</strong>
                  <Chip
                    label={String(row.decision_outcome ?? t('platformUsers.userSecurityActions.recorded'))}
                    kind={securityOutcomeTone(row.decision_outcome)}
                    size="xs"
                  />
                  <span className="mono" style={{ color: 'var(--ink-3)', fontSize: 11 }}>
                    {formatSecurityActionTimestamp(row.timestamp)}
                  </span>
                </div>
                <div className="state__hint" style={{ fontSize: 11.5 }}>
                  {passwordResetIntentId ? (
                    <span>
                      {t('platformUsers.userSecurityActions.intent')} <code className="mono">{passwordResetIntentId}</code>
                    </span>
                  ) : null}
                  {roleKey ? (
                    <span>
                      {passwordResetIntentId ? ' - ' : null}
                      {t('platformUsers.userSecurityActions.role')} <code className="mono">{roleKey}</code>
                    </span>
                  ) : null}
                  {sessionId ? (
                    <span>
                      {passwordResetIntentId || roleKey ? ' - ' : null}
                      {t('platformUsers.userSecurityActions.session')} <code className="mono">{sessionId}</code>
                    </span>
                  ) : null}
                  {inviteEmail ? (
                    <span>
                      {passwordResetIntentId || roleKey || sessionId ? ' - ' : null}
                      {t('platformUsers.userSecurityActions.invite')} <code className="mono">{inviteEmail}</code>
                    </span>
                  ) : null}
                  {sendInviteEmailRequested ? (
                    <span>
                      {passwordResetIntentId || roleKey || sessionId || inviteEmail ? ' - ' : null}
                      {fill(t('platformUsers.userSecurityActions.emailRequested'), { value: String(sendInviteEmailRequested) })}
                    </span>
                  ) : null}
                  {inviteEmailSent ? (
                    <span>
                      {passwordResetIntentId || roleKey || sessionId || inviteEmail || sendInviteEmailRequested ? ' - ' : null}
                      {fill(t('platformUsers.userSecurityActions.sent'), { value: String(inviteEmailSent) })}
                    </span>
                  ) : null}
                  {hasInviteRedirectEvidence ? (
                    <span>
                      {passwordResetIntentId || roleKey || sessionId || inviteEmail || sendInviteEmailRequested || inviteEmailSent ? ' - ' : null}
                      {fill(t('platformUsers.userSecurityActions.redirect'), { value: String(inviteRedirectRecorded ? inviteRedirectTo ?? t('platformUsers.userSecurityActions.notRequested') : t('platformUsers.userSecurityActions.notRecorded')) })}
                    </span>
                  ) : null}
                  {inviteAcceptedFrom || inviteAcceptedTo ? (
                    <span>
                      {passwordResetIntentId || roleKey || sessionId || inviteEmail || sendInviteEmailRequested || inviteEmailSent || hasInviteRedirectEvidence ? ' - ' : null}
                      {fill(t('platformUsers.userSecurityActions.accessTo'), { from: String(inviteAcceptedFrom ?? t('platformUsers.userSecurityActions.invited')), to: String(inviteAcceptedTo ?? t('platformUsers.userSecurityActions.active')) })}
                    </span>
                  ) : null}
                  {reason ? (
                    <span>
                      {passwordResetIntentId || roleKey || sessionId || inviteEmail || sendInviteEmailRequested || inviteEmailSent || hasInviteRedirectEvidence || inviteAcceptedFrom || inviteAcceptedTo ? ' - ' : null}
                      {fill(t('platformUsers.userSecurityActions.reason'), { reason: String(reason) })}
                    </span>
                  ) : null}
                  {!passwordResetIntentId && !roleKey && !sessionId && !inviteEmail && !sendInviteEmailRequested && !inviteEmailSent && !hasInviteRedirectEvidence && !inviteAcceptedFrom && !inviteAcceptedTo && !reason ? (
                    <span>{t('platformUsers.userSecurityActions.decisionEvidenceRecorded')}</span>
                  ) : null}
                </div>
                {row.correlation_id ? (
                  <div className="mono" style={{ color: 'var(--ink-3)', fontSize: 11 }}>
                    {t('platformUsers.userSecurityActions.requestTrailRecorded')}
                  </div>
                ) : null}
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}

function RolesTab({
  activeRoleKeys,
  roleOptions,
  canManage,
  onGrant,
  onRevoke,
  pending,
}: {
  activeRoleKeys: string[];
  roleOptions: RoleOption[];
  canManage: boolean;
  onGrant: (roleKey: string) => void;
  onRevoke: (roleKey: string) => void;
  pending: boolean;
}) {
  const { t } = useI18n();
  const effectiveActiveRoleKeys = activeRoleKeys;

  return (
    <div data-testid="users-drawer-roles">
      <div className="section-eyebrow">{t('platformUsers.rolesTab.activeRolesRoleLifecycle')}</div>
      <p className="state__hint" style={{ padding: '4px 14px 8px', fontSize: 11.5 }}>
        {t('platformUsers.rolesTab.activeRoles')}{' '}
        <code className="mono" data-testid="users-active-role-rollup">
          {effectiveActiveRoleKeys.length > 0 ? effectiveActiveRoleKeys.join(', ') : t('platformUsers.rolesTab.noActiveRbacRoles')}
        </code>
        .{' '}
        {t('platformUsers.rolesTab.revokeDetachesTheSelected')}
      </p>
      {roleOptions.length === 0 ? (
        <StateView
          kind="error"
          title={t('platformUsers.rolesTab.tenantRoleCatalogMissing')}
          hint={t('platformUsers.rolesTab.theTenantRoleCatalog')}
        />
      ) : null}
      <ul
        style={{ listStyle: 'none', padding: '0 14px', margin: 0 }}
        aria-label={t('platformUsers.rolesTab.roleCatalog')}
        data-testid="users-roles-list"
      >
        {roleOptions.map((role) => {
          const roleKey = role.key;
          const isActive = effectiveActiveRoleKeys.includes(roleKey);
          return (
            <li
              key={roleKey}
              style={{
                display: 'grid',
                gridTemplateColumns: '1fr auto auto',
                gap: 8,
                padding: '8px 0',
                borderTop: '1px solid var(--line)',
                alignItems: 'center',
              }}
              data-testid={`users-role-row-${roleKey}`}
            >
              <span className="mono" style={{ fontSize: 12 }}>
                {role.label}
                <span style={{ color: 'var(--ink-3)' }}> · {roleKey}</span>
              </span>
              {isActive ? (
                <Chip label={t('platformUsers.rolesTab.active')} kind="good" size="xs" />
              ) : (
                <span className="mono" style={{ fontSize: 11, color: 'var(--ink-3)' }}>
                  —
                </span>
              )}
              <div style={{ display: 'flex', gap: 6 }}>
                <Button
                  label={isActive ? t('platformUsers.rolesTab.revoke') : t('platformUsers.rolesTab.grant')}
                  size="sm"
                  kind={isActive ? 'danger' : 'primary'}
                  capability={CAP.USERS_MANAGE}
                  disabled={!canManage || pending}
                  onClick={() => (isActive ? onRevoke(roleKey) : onGrant(roleKey))}
                  ariaLabel={fill(t(isActive ? 'platformUsers.rolesTab.revokeRole' : 'platformUsers.rolesTab.grantRole'), { roleKey: String(roleKey) })}
                />
              </div>
            </li>
          );
        })}
      </ul>
    </div>
  );
}

// ─── Capabilities tab — per-capability eval drilldown via the canonical
//      user_capability_eval_v1 RPC. Resolved capability list comes from the
//      canonical access policy resolver (NOT FE seed) so the surface stays
//      backend-SSOT. ─────────────────────────────────────────────────────
interface AccessPolicyCapability {
  key: string;
  label?: string;
}
interface AccessPolicyRole {
  key?: string;
  capability_keys?: string[];
}
interface AccessPolicyBody {
  capabilities?: AccessPolicyCapability[];
  roles?: AccessPolicyRole[];
}

function capabilityRuleMatches(capability: string, rule: string): boolean {
  if (!rule) return false;
  if (rule === '*') return true;
  if (rule === capability) return true;
  if (rule.endsWith('.*')) return capability.startsWith(rule.slice(0, -1));
  return false;
}

function CapabilitiesTab({
  user,
  activeRoleKeys,
}: {
  user: UserRow;
  activeRoleKeys: string[];
}) {
  const { t } = useI18n();
  const canReadAccessPolicy = useCapability(CAP.ACCESS_POLICY_READ);
  // Resolve the access policy at the user's effective scope so the capability
  // catalog matches what the backend actually evaluates against. Mirrors the
  // pattern used in /platform/access (access.tsx).
  const access = useResolveAccessPolicy(
    user.access_scope_type ?? undefined,
    user.access_scope_id ?? null,
    { enabled: canReadAccessPolicy },
  );
  const policy = (access.data?.policy ?? null) as AccessPolicyBody | null;
  const capKeys = useMemo<string[]>(() => {
    const list = policy?.capabilities ?? [];
    return list
      .map((c) => c.key)
      .filter((k): k is string => typeof k === 'string' && k.length > 0);
  }, [policy?.capabilities]);
  const targetRoleKeys = useMemo(() => {
    const keys = activeRoleKeys.filter((roleKey) => typeof roleKey === 'string' && roleKey.length > 0);
    return keys.length > 0 ? keys : [user.user_type].filter(Boolean);
  }, [activeRoleKeys, user.user_type]);
  const targetGrantedCapabilities = useMemo(() => {
    const granted = new Set<string>();
    const roleKeySet = new Set(targetRoleKeys);
    for (const role of policy?.roles ?? []) {
      if (!role.key || !roleKeySet.has(role.key)) continue;
      for (const capability of role.capability_keys ?? []) {
        if (typeof capability === 'string' && capability.length > 0) {
          granted.add(capability);
        }
      }
    }
    return Array.from(granted);
  }, [policy?.roles, targetRoleKeys]);
  const targetAllowsCapability = useMemo(() => {
    return (capability: string) =>
      targetGrantedCapabilities.some((rule) => capabilityRuleMatches(capability, rule));
  }, [targetGrantedCapabilities]);

  const [filter, setFilter] = useState<string>('');
  const filtered = useMemo(() => {
    const q = filter.toLowerCase();
    if (!q) return capKeys;
    return capKeys.filter((c) => c.toLowerCase().includes(q));
  }, [capKeys, filter]);

  return (
    <div data-testid="users-drawer-capabilities">
      <div className="section-eyebrow">{t('platformUsers.capabilitiesTab.effectivePermissions')}</div>
      {!canReadAccessPolicy ? (
        <StateView
          kind="denied"
          capability={CAP.ACCESS_POLICY_READ}
          hint={t('platformUsers.capabilitiesTab.capabilityCatalogInspectionRequires')}
        />
      ) : (
        <>
      <div className="dt-toolbar">
        <div className="dt-tb-search">
          <input
            type="text"
            placeholder={t('platformUsers.capabilitiesTab.filterCapabilities')}
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
            data-testid="users-capabilities-filter"
            aria-label={t('platformUsers.capabilitiesTab.filterCapabilities2')}
          />
        </div>
        <span className="dt-tb-spacer" />
        <span className="dt-tb-count mono">{fill(t('platformUsers.capabilitiesTab.permissions'), { length: String(filtered.length) })}</span>
      </div>
      {access.isLoading ? (
        <StateView kind="loading" />
      ) : capKeys.length === 0 ? (
        <StateView
          kind="empty"
          title={t('platformUsers.capabilitiesTab.noCapabilityCatalog')}
          hint={t('platformUsers.capabilitiesTab.theResolvedPolicyDoes')}
        />
      ) : (
        <ul
          style={{ listStyle: 'none', padding: '0 14px', margin: 0 }}
          aria-label={t('platformUsers.capabilitiesTab.capabilityMatrix')}
          data-testid="users-capabilities-list"
        >
          {filtered.map((cap) => (
            <li
              key={cap}
              style={{
                display: 'grid',
                gridTemplateColumns: '1fr auto',
                gap: 8,
                padding: '8px 0',
                borderTop: '1px solid var(--line)',
                alignItems: 'center',
              }}
              data-testid={`users-capability-row-${cap}`}
            >
              <span className="mono" style={{ fontSize: 12 }}>
                {cap}
              </span>
              <CapabilityEvalDrilldown
                userId={user.id}
                capabilityKey={cap}
                scopeType={user.access_scope_type}
                scopeId={user.access_scope_id ?? null}
                knownAllowed={targetAllowsCapability(cap)}
                testIdPrefix={`users-cap-eval-${cap}`}
              />
            </li>
          ))}
        </ul>
      )}
        </>
      )}
    </div>
  );
}

// Device tab - wraps the shared backend-backed user-device roster.
function DevicesTab({ user }: { user: UserRow }) {
  const { t } = useI18n();
  return (
    <div data-testid="users-drawer-devices">
      <div className="section-eyebrow">{t('platformUsers.devicesTab.registeredDevices')}</div>
      <UserDevicesList userId={user.id} hideTitle title="" />
    </div>
  );
}

function SessionsTab({ user }: { user: UserRow }) {
  const { t } = useI18n();
  return (
    <div data-testid="users-drawer-sessions">
      <div className="section-eyebrow">{t('platformUsers.sessionsTab.activeSessions')}</div>
      <SessionsList userId={user.id} hideTitle title="" />
    </div>
  );
}

interface InviteUserFormProps {
  organizationId?: string | null;
  roleOptions: RoleOption[];
  accessScopeOptions: AccessScopeOption[];
  clientScopeOptions: ScopeReferenceOption[];
  senderScopeOptions: ScopeReferenceOption[];
  defaultAccessScopeType?: string | null;
  roleCatalogLoading?: boolean;
  roleCatalogError?: string | null;
  accessScopeLoading?: boolean;
  accessScopeError?: string | null;
  clientScopeLoading?: boolean;
  clientScopeError?: string | null;
  senderScopeLoading?: boolean;
  senderScopeError?: string | null;
  canManage: boolean;
  pending: boolean;
  onCancel: () => void;
  onSubmit: (args: {
    email: string;
    full_name: string;
    role_key: string;
    organization_id?: string | null;
    access_scope_type: string;
    access_scope_id?: string | null;
    send_invite_email: boolean;
    invite_redirect_to?: string | null;
  }) => Promise<void>;
}

function InviteUserForm({
  organizationId,
  roleOptions,
  accessScopeOptions,
  clientScopeOptions,
  senderScopeOptions,
  defaultAccessScopeType,
  roleCatalogLoading = false,
  roleCatalogError = null,
  accessScopeLoading = false,
  accessScopeError = null,
  clientScopeLoading = false,
  clientScopeError = null,
  senderScopeLoading = false,
  senderScopeError = null,
  canManage,
  pending,
  onCancel,
  onSubmit,
}: InviteUserFormProps) {
  const { t } = useI18n();
  const scopeRows = useMemo(
    () => accessScopeOptions.slice().sort((a, b) => (a.rank ?? 0) - (b.rank ?? 0)),
    [accessScopeOptions],
  );
  const initialScope = defaultInviteAccessScope(scopeRows, defaultAccessScopeType);
  const inviteRedirectTo = useMemo(() => hostedInviteRedirect(), []);
  const canSendInviteEmail = Boolean(inviteRedirectTo);
  const [draft, setDraft] = useState({
    email: '',
    full_name: '',
    role_key: defaultRoleKey(roleOptions),
    access_scope_type: initialScope,
    access_scope_id: '',
    send_invite_email: canSendInviteEmail,
  });
  const scopeReferenceType =
    draft.access_scope_type === 'client' || draft.access_scope_type === 'sender'
      ? draft.access_scope_type
      : null;
  const [scopeReferenceSearch, setScopeReferenceSearch] = useState('');
  const scopeReferenceOptions = useMemo(() => {
    if (scopeReferenceType === 'client') return clientScopeOptions;
    if (scopeReferenceType === 'sender') return senderScopeOptions;
    return [];
  }, [clientScopeOptions, scopeReferenceType, senderScopeOptions]);
  const scopeReferenceLoading =
    scopeReferenceType === 'client'
      ? clientScopeLoading
      : scopeReferenceType === 'sender'
        ? senderScopeLoading
        : false;
  const scopeReferenceError =
    scopeReferenceType === 'client'
      ? clientScopeError
      : scopeReferenceType === 'sender'
        ? senderScopeError
        : null;
  const selectedScopeReference = scopeReferenceOptions.find((option) => option.id === draft.access_scope_id);
  const filteredScopeReferenceOptions = useMemo(
    () =>
      scopeReferenceOptions.filter((option) =>
        option.id === selectedScopeReference?.id || scopeReferenceMatchesSearch(option, scopeReferenceSearch),
      ),
    [scopeReferenceOptions, scopeReferenceSearch, selectedScopeReference?.id],
  );
  useEffect(() => {
    setDraft((current) => {
      if (roleOptions.some((role) => role.key === current.role_key)) return current;
      return { ...current, role_key: defaultRoleKey(roleOptions) };
    });
  }, [roleOptions]);
  useEffect(() => {
    setDraft((current) => {
      const nextDefault = defaultInviteAccessScope(scopeRows, defaultAccessScopeType);
      if (current.access_scope_type && scopeRows.some((row) => row.value === current.access_scope_type)) {
        return current;
      }
      return {
        ...current,
        access_scope_type: nextDefault,
        access_scope_id: accessScopeRequiresId(nextDefault, scopeRows) ? current.access_scope_id : '',
      };
    });
  }, [scopeRows, defaultAccessScopeType]);
  useEffect(() => {
    setScopeReferenceSearch('');
  }, [scopeReferenceType]);
  useEffect(() => {
    if (!scopeReferenceType || scopeReferenceLoading || !draft.access_scope_id) return;
    if (scopeReferenceOptions.some((option) => option.id === draft.access_scope_id)) return;
    setDraft((current) => ({ ...current, access_scope_id: '' }));
  }, [draft.access_scope_id, scopeReferenceLoading, scopeReferenceOptions, scopeReferenceType]);
  const scopeNeedsId = accessScopeRequiresId(draft.access_scope_type, scopeRows);
  const scopeReferenceMissing =
    Boolean(scopeReferenceType) &&
    !scopeReferenceLoading &&
    !scopeReferenceError &&
    scopeReferenceOptions.length === 0;
  const scopeReferenceSelected = Boolean(
    scopeReferenceType &&
    draft.access_scope_id.trim() &&
    scopeReferenceOptions.some((option) => option.id === draft.access_scope_id.trim()),
  );
  const hasActiveTenant = Boolean(organizationId);
  const catalogLoading = roleCatalogLoading || accessScopeLoading;
  const scopeCatalogMissing = !accessScopeLoading && scopeRows.length === 0;
  const roleCatalogMissing = hasActiveTenant && !roleCatalogLoading && roleOptions.length === 0;
  const catalogError = roleCatalogError ?? accessScopeError ?? (scopeReferenceType ? scopeReferenceError : null);
  const valid =
    hasActiveTenant &&
    !catalogLoading &&
    !catalogError &&
    !scopeReferenceLoading &&
    !scopeReferenceMissing &&
    isInviteEmailValid(draft.email) &&
    draft.full_name.trim().length > 0 &&
    draft.role_key.trim().length > 0 &&
    !roleCatalogMissing &&
    !scopeCatalogMissing &&
    (!scopeNeedsId ||
      (scopeReferenceType ? scopeReferenceSelected : draft.access_scope_id.trim().length > 0));

  return (
    <div data-testid="tenant-user-invite-form">
      <div className="section-eyebrow">{t('platformUsers.inviteUserForm.userInvitationTenantInvite')}</div>
      {catalogLoading ? (
        <StateView
          kind="loading"
          title={t('platformUsers.inviteUserForm.loadingInviteCatalogs')}
          hint={t('platformUsers.inviteUserForm.roleAndAccessScope')}
        />
      ) : null}
      {catalogError ? (
        <StateView
          kind="error"
          title={t('platformUsers.inviteUserForm.inviteCatalogUnavailable')}
          hint={catalogError}
        />
      ) : null}
      {scopeCatalogMissing ? (
        <StateView
          kind="error"
          title={t('platformUsers.inviteUserForm.accessScopeCatalogMissing')}
          hint={t('platformUsers.inviteUserForm.theAccessScopeType')}
        />
      ) : null}
      {roleCatalogMissing ? (
        <StateView
          kind="error"
          title={t('platformUsers.inviteUserForm.tenantRoleCatalogMissing')}
          hint={t('platformUsers.inviteUserForm.theTenantRoleCatalog')}
        />
      ) : null}
      {scopeReferenceMissing ? (
        <StateView
          kind="error"
          title={t(scopeReferenceType === 'client' ? 'platformUsers.inviteUserForm.clientReferencesMissing' : 'platformUsers.inviteUserForm.senderReferencesMissing')}
          hint={fill(t('platformUsers.inviteUserForm.selectASavedReference'), { scopeReferenceType: String(scopeReferenceType), scopeReferenceType2: String(scopeReferenceType) })}
        />
      ) : null}
      {!hasActiveTenant ? (
        <StateView
          kind="denied"
          title={t('platformUsers.inviteUserForm.selectATenantFirst')}
          hint={t('platformUsers.inviteUserForm.useTheTenantPicker')}
        />
      ) : null}
      {!canSendInviteEmail ? (
        <p className="state__hint" style={{ padding: '0 4px', fontSize: 11.5 }}>
          {t('platformUsers.inviteUserForm.hostedInviteEmailIs')}
        </p>
      ) : null}
      <div
        style={{
          display: 'grid',
          gridTemplateColumns: '140px minmax(0, 1fr)',
          gap: 8,
          alignItems: 'center',
          padding: '0 4px',
        }}
      >
        <label className="mono" htmlFor="invite-user-email">{t('platformUsers.inviteUserForm.email')}</label>
        <input
          id="invite-user-email"
          className="dt-inline-input"
          type="text"
          inputMode="email"
          autoComplete="email"
          spellCheck={false}
          value={draft.email}
          onChange={(e) => setDraft((s) => ({ ...s, email: e.target.value }))}
        />
        <label className="mono" htmlFor="invite-user-name">{t('platformUsers.inviteUserForm.name')}</label>
        <input
          id="invite-user-name"
          className="dt-inline-input"
          value={draft.full_name}
          onChange={(e) => setDraft((s) => ({ ...s, full_name: e.target.value }))}
        />
        <label className="mono" htmlFor="invite-user-role">{t('platformUsers.inviteUserForm.role')}</label>
        <select
          id="invite-user-role"
          className="dt-inline-input"
          value={draft.role_key}
          disabled={catalogLoading || roleCatalogMissing}
          onChange={(e) => setDraft((s) => ({ ...s, role_key: e.target.value }))}
        >
          {roleOptions.map((role) => (
            <option key={role.key} value={role.key}>{role.label} ({role.key})</option>
          ))}
        </select>
        <label className="mono" htmlFor="invite-user-scope-type">{t('platformUsers.inviteUserForm.accessScope')}</label>
        <select
          id="invite-user-scope-type"
          className="dt-inline-input"
          value={draft.access_scope_type}
          disabled={catalogLoading || scopeCatalogMissing}
          onChange={(e) => setDraft((s) => ({
            ...s,
            access_scope_type: e.target.value,
            access_scope_id: '',
          }))}
        >
          {scopeRows.map((scope) => (
            <option key={scope.value} value={scope.value}>{scope.label ?? scope.value}</option>
          ))}
        </select>
        {scopeReferenceType ? (
          <>
            <label className="mono" htmlFor="invite-user-scope-reference-search">
              {scopeReferenceType === 'client' ? t('platformUsers.inviteUserForm.clientSearch') : t('platformUsers.inviteUserForm.senderSearch')}
            </label>
            <input
              id="invite-user-scope-reference-search"
              className="dt-inline-input"
              value={scopeReferenceSearch}
              disabled={catalogLoading || scopeReferenceLoading || scopeReferenceOptions.length === 0}
              placeholder={scopeReferenceType === 'client' ? t('platformUsers.inviteUserForm.searchClients') : t('platformUsers.inviteUserForm.searchSenders')}
              onChange={(e) => setScopeReferenceSearch(e.target.value)}
            />
            <label className="mono" htmlFor="invite-user-scope-reference">
              {scopeReferenceType === 'client' ? t('platformUsers.inviteUserForm.client') : t('platformUsers.inviteUserForm.sender')}
            </label>
            <select
              id="invite-user-scope-reference"
              className="dt-inline-input"
              value={draft.access_scope_id}
              disabled={catalogLoading || scopeReferenceLoading || scopeReferenceOptions.length === 0}
              onChange={(e) => setDraft((s) => ({ ...s, access_scope_id: e.target.value }))}
            >
              <option value="">
                {scopeReferenceLoading
                  ? fill(t('platformUsers.inviteUserForm.loadingReferences'), { scopeReferenceType: String(scopeReferenceType) })
                  : fill(t('platformUsers.inviteUserForm.select'), { scopeReferenceType: String(scopeReferenceType) })}
              </option>
              {filteredScopeReferenceOptions.map((option) => (
                <option key={option.id} value={option.id}>
                  {option.label}
                </option>
              ))}
            </select>
          </>
        ) : (
          <>
            <label className="mono" htmlFor="invite-user-scope-id">{t('platformUsers.inviteUserForm.scopeId')}</label>
            <input
              id="invite-user-scope-id"
              className="dt-inline-input"
              value={draft.access_scope_id}
              disabled={catalogLoading || !scopeNeedsId}
              onChange={(e) => setDraft((s) => ({ ...s, access_scope_id: e.target.value }))}
            />
          </>
        )}
        <label className="mono" htmlFor="invite-user-send-email">{t('platformUsers.inviteUserForm.inviteEmail')}</label>
        <label style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <input
            id="invite-user-send-email"
            type="checkbox"
            checked={draft.send_invite_email && canSendInviteEmail}
            disabled={!canSendInviteEmail}
            onChange={(e) => setDraft((s) => ({ ...s, send_invite_email: canSendInviteEmail && e.target.checked }))}
          />
          <span className="state__hint">{t('platformUsers.inviteUserForm.sendAnInviteEmail')}</span>
        </label>
      </div>
      <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8, marginTop: 14 }}>
        <Button label={t('platformUsers.inviteUserForm.cancel')} kind="ghost" onClick={onCancel} />
        <Button
          label={t('platformUsers.inviteUserForm.sendInvite')}
          iconName="user_in"
          kind="primary"
          capability={CAP.USERS_MANAGE}
          disabled={!canManage || pending || !valid}
          onClick={() =>
            onSubmit({
              email: draft.email.trim().toLowerCase(),
              full_name: draft.full_name.trim(),
              role_key: draft.role_key,
              organization_id: organizationId ?? null,
              access_scope_type: draft.access_scope_type,
              access_scope_id: scopeNeedsId ? draft.access_scope_id.trim() : null,
              send_invite_email: canSendInviteEmail && draft.send_invite_email,
              invite_redirect_to: canSendInviteEmail && draft.send_invite_email ? inviteRedirectTo : null,
            })
          }
        />
      </div>
    </div>
  );
}

interface InviteUserModalBodyProps {
  organizationId?: string | null;
  defaultAccessScopeType?: string | null;
  canManage: boolean;
  pending: boolean;
  onCancel: () => void;
  onSubmit: InviteUserFormProps['onSubmit'];
}

function InviteUserModalBody({
  organizationId,
  defaultAccessScopeType,
  canManage,
  pending,
  onCancel,
  onSubmit,
}: InviteUserModalBodyProps) {
  const roleCatalogQuery = useTenantInvitableRoles({ organization_id: organizationId ?? null });
  const roleOptions = useMemo(
    () => roleOptionsFromRows(roleCatalogQuery.data?.rows as RoleCatalogRow[] | undefined),
    [roleCatalogQuery.data],
  );
  const accessScopeQuery = useResourceList<LookupValueRow>('lookup_values', {
    filter: { category: 'access_scope_type' },
  });
  const accessScopeOptions = useMemo(
    () => accessScopeOptionsFromRows(accessScopeQuery.data?.rows),
    [accessScopeQuery.data],
  );
  const clientReferenceOpts = useMemo(
    () => (organizationId ? { filter: { organization_id: organizationId } } : undefined),
    [organizationId],
  );
  const senderReferenceOpts = useMemo(
    () => (organizationId ? { filter: { organization_id_resolved: organizationId } } : undefined),
    [organizationId],
  );
  const clientReferenceQuery = useCompleteResourceList<InviteClientReferenceRow>(
    'client_summary',
    clientReferenceOpts,
    { enabled: Boolean(organizationId) },
  );
  const senderReferenceQuery = useCompleteResourceList<InviteSenderReferenceRow>(
    'sender_summary',
    senderReferenceOpts,
    { enabled: Boolean(organizationId) },
  );
  const clientScopeOptions = useMemo(
    () => clientScopeReferenceOptions(clientReferenceQuery.data?.rows),
    [clientReferenceQuery.data],
  );
  const senderScopeOptions = useMemo(
    () => senderScopeReferenceOptions(senderReferenceQuery.data?.rows),
    [senderReferenceQuery.data],
  );

  return (
    <InviteUserForm
      organizationId={organizationId}
      roleOptions={roleOptions}
      accessScopeOptions={accessScopeOptions}
      clientScopeOptions={clientScopeOptions}
      senderScopeOptions={senderScopeOptions}
      defaultAccessScopeType={defaultAccessScopeType}
      roleCatalogLoading={roleCatalogQuery.isLoading}
      roleCatalogError={(roleCatalogQuery.error as Error | null)?.message ?? null}
      accessScopeLoading={accessScopeQuery.isLoading && accessScopeOptions.length === 0}
      accessScopeError={
        accessScopeOptions.length === 0 ? (accessScopeQuery.error as Error | null)?.message ?? null : null
      }
      clientScopeLoading={clientReferenceQuery.isLoading && clientScopeOptions.length === 0}
      clientScopeError={
        clientScopeOptions.length === 0 ? (clientReferenceQuery.error as Error | null)?.message ?? null : null
      }
      senderScopeLoading={senderReferenceQuery.isLoading && senderScopeOptions.length === 0}
      senderScopeError={
        senderScopeOptions.length === 0 ? (senderReferenceQuery.error as Error | null)?.message ?? null : null
      }
      canManage={canManage}
      pending={pending}
      onCancel={onCancel}
      onSubmit={onSubmit}
    />
  );
}

// ─── Drawer body — tab shell (Profile / Roles / Capabilities / Devices / Sessions)
//      plus the lifecycle action row (Suspend / Reactivate / Force-password-
//      reset). All actions are gated on `users.manage`. ────────────────────
interface UsersDrawerBodyProps {
  user: UserRow;
  directory?: UserDirectoryRow;
  roleOptions: RoleOption[];
  canManage: boolean;
  onSuspend: () => void;
  onReactivate: () => void;
  onForcePasswordReset: () => void;
  onResendInvite: () => void;
  onGrant: (roleKey: string) => void;
  onRevoke: (roleKey: string) => void;
  pending: boolean;
  lifecycleReadback?: string | null;
}

function UsersDrawerBody({
  user,
  directory,
  roleOptions,
  canManage,
  onSuspend,
  onReactivate,
  onForcePasswordReset,
  onResendInvite,
  onGrant,
  onRevoke,
  pending,
  lifecycleReadback,
}: UsersDrawerBodyProps) {
  const { t } = useI18n();
  const [tab, setTab] = useState<DrawerTabId>('profile');
  // W71-Platform (Cycle F-R-11) closure — suspended-status gate resolves
  // through canonical `user_status.metadata.is_suspended` instead of an
  // inline `'suspended'` literal compare. AGENTS.md §2 (ZERO HARDCODING)
  // + §6 (row-driven by configuration).
  const isSuspended = lookupRow('user_status', user.status ?? '')?.metadata?.is_suspended === true;
  const isInvited = lookupRow('user_status', user.status ?? '')?.metadata?.is_invited === true;

  return (
    <div data-testid="users-drawer">
      <div className="tabs" role="tablist" aria-label={t('platformUsers.usersDrawerBody.userDrawerTabs')}>
        {drawerTabs(t).map((entry) => (
          <button
            key={entry.id}
            role="tab"
            aria-selected={tab === entry.id}
            type="button"
            className={`tabs__tab ${tab === entry.id ? 'is-active' : ''}`}
            onClick={() => setTab(entry.id)}
            data-key={entry.id}
            data-testid={`users-drawer-tab-${entry.id}`}
          >
            {entry.label}
          </button>
        ))}
      </div>

      <div style={{ marginTop: 14 }}>
        {tab === 'profile' ? <ProfileTab user={user} directory={directory} /> : null}
        {tab === 'roles' ? (
          <RolesTab
            activeRoleKeys={directory?.active_role_keys ?? []}
            roleOptions={roleOptions}
            canManage={canManage}
            onGrant={onGrant}
            onRevoke={onRevoke}
            pending={pending}
          />
        ) : null}
        {tab === 'capabilities' ? (
          <CapabilitiesTab user={user} activeRoleKeys={directory?.active_role_keys ?? []} />
        ) : null}
        {tab === 'devices' ? <DevicesTab user={user} /> : null}
        {tab === 'sessions' ? <SessionsTab user={user} /> : null}
      </div>

      <div
        className="section-eyebrow"
        style={{ marginTop: 12 }}
        data-testid="users-drawer-actions-eyebrow"
      >
        {t('platformUsers.usersDrawerBody.lifecycleActionsSuspendReactivate')}
      </div>
      <div
        style={{ display: 'flex', gap: 8, padding: '6px 14px 16px', flexWrap: 'wrap' }}
        data-testid="users-drawer-actions"
      >
        {isSuspended ? (
          <Button
            label={t('platformUsers.usersDrawerBody.reactivate')}
            iconName="check"
            kind="primary"
            capability={CAP.USERS_MANAGE}
            disabled={!canManage || pending}
            onClick={onReactivate}
          />
        ) : (
          <Button
            label={t('platformUsers.usersDrawerBody.suspend')}
            iconName="close"
            kind="danger"
            capability={CAP.USERS_MANAGE}
            disabled={!canManage || pending}
            onClick={onSuspend}
          />
        )}
        <Button
          label={t('platformUsers.usersDrawerBody.forcePasswordReset')}
          iconName="lock"
          kind="ghost"
          capability={CAP.USERS_MANAGE}
          disabled={!canManage || pending}
          onClick={onForcePasswordReset}
        />
        {isInvited ? (
          <Button
            label={t('platformUsers.usersDrawerBody.resendInvite')}
            iconName="user_in"
            kind="ghost"
            capability={CAP.USERS_MANAGE}
            disabled={!canManage || pending}
            onClick={onResendInvite}
          />
        ) : null}
      </div>
      {lifecycleReadback ? (
        <p
          className="state__hint"
          data-testid="users-drawer-lifecycle-readback"
          style={{
            margin: '0 14px 14px',
            padding: '8px 10px',
            border: '1px solid var(--good)',
            borderRadius: 6,
            color: 'var(--good)',
          }}
        >
          {lifecycleReadback}
        </p>
      ) : null}
    </div>
  );
}

// ─── Top-level module ───────────────────────────────────────────────────
export function UsersModule() {
  const { t } = useI18n();
  const columns = useMemo(() => userColumns(t), [t]);
  const identity = useIdentity();
  const { scope } = identity;
  const tenantId = scope.tenant?.id;
  const requestedOrganizationId = readAuthorizedTenantOrganizationOverride(identity);
  const requestedFocus = readUrlParam('focus')?.trim() || null;
  const homeTenantOrganizationId =
    identity.currentScopeType() === 'tenant' ? identity.currentTenantId() : null;
  const activeOrganizationId = requestedOrganizationId ?? tenantId ?? homeTenantOrganizationId ?? null;
  const tenantListOpts = useMemo(
    () => (activeOrganizationId ? { filter: { organization_id: activeOrganizationId } } : undefined),
    [activeOrganizationId],
  );
  const canRead = useCapability(CAP.USERS_READ);
  const canManage = useCapability(CAP.USERS_MANAGE);
  const readQueryOptions = useMemo(() => ({ enabled: canRead }), [canRead]);
  const usersQuery = useCompleteResourceList<UserRow>('users', tenantListOpts, readQueryOptions);
  // W23 — additive directory projection. The base `users` read seam
  // remains the canonical SSOT; this read enriches the drawer with the
  // organization label + active role rollups via `v_user_directory`.
  const userDirectoryQuery = useCompleteResourceList<UserDirectoryRow>(
    'user_directory',
    tenantListOpts,
    readQueryOptions,
  );
  const userStatusLookupQuery = useResourceList<LookupValueRow>(
    'lookup_values',
    { filter: { category: 'user_status' } },
    { enabled: canRead },
  );
  const userDirectoryById = useMemo(() => {
    const map = new Map<string, UserDirectoryRow>();
    for (const r of userDirectoryQuery.data?.rows ?? []) map.set(r.id, r);
    return map;
  }, [userDirectoryQuery.data]);
  const usersReadError = usersQuery.isError
    ? usersQuery.error
    : userDirectoryQuery.isError
      ? userDirectoryQuery.error
      : null;

  const roleCatalogQuery = useTenantInvitableRoles({ organization_id: activeOrganizationId });
  const roleOptions = useMemo(
    () => roleOptionsFromRows(roleCatalogQuery.data?.rows as RoleCatalogRow[] | undefined),
    [roleCatalogQuery.data],
  );
  const defaultAccessScopeType = activeOrganizationId ? 'tenant' : identity.currentScopeType();

  const modal = useModal();
  const [selectedUserId, setSelectedUserId] = useState<string | null>(null);
  const [selectedUserEmail, setSelectedUserEmail] = useState<string | null>(null);
  const [openedUrlFocus, setOpenedUrlFocus] = useState<string | null>(null);
  const [lifecycleReadbackByUserId, setLifecycleReadbackByUserId] = useState<Record<string, string>>({});

  const [statusFilter, setStatusFilter] = useState<StatusFilter>('all');
  // W50 — Resolve filter chips from canonical `user_status` lookup (no
  // hardcoded status array). `'all'` sentinel prepends the canonical values
  // so the "show all" chip always exists; if the canonical lookup is empty
  // (seed gap), the chip toolbar surfaces a `<StateView kind="error"/>`.
  const statusFilters = useMemo<string[]>(() => {
    const liveRows = userStatusLookupQuery.data?.rows ?? [];
    const rows = liveRows.length > 0
      ? liveRows
      : (getLookups('user_status') ?? []) as Array<{ value: string }>;
    return ['all', ...rows.map((r) => r.value)];
  }, [userStatusLookupQuery.data]);
  const statusLookupByValue = useMemo(() => {
    const liveRows = userStatusLookupQuery.data?.rows ?? [];
    const rows = liveRows.length > 0
      ? liveRows
      : (getLookups('user_status') ?? []) as LookupValueRow[];
    return new Map(rows.map((row) => [row.value, row]));
  }, [userStatusLookupQuery.data]);

  // Filter pivots — keep status filter row-driven so adding a new status
  // (e.g. `pending_invite`) only requires updating the canonical user_status
  // lookup, never the filter logic itself.
  const filteredUsers = useMemo<UserRow[]>(() => {
    const rows = usersQuery.data?.rows ?? [];
    if (statusFilter === 'all') return rows;
    return rows.filter((r) => (r.status ?? '').toLowerCase() === statusFilter);
  }, [usersQuery.data, statusFilter]);

  // KPI strip — totals derived from the registry-driven projection so the
  // numbers stay in sync with the table without needing a separate metrics
  // endpoint (zero-redundancy: same canonical source).
  const kpis = useMemo(() => {
    // W71-Platform (Cycle F-R-11) closure — KPI status filters resolve
    // through canonical `user_status.metadata.is_active|is_suspended|
    // is_invited` instead of inline `'active'|'suspended'|'invited'`
    // literal compares. AGENTS.md §2 (ZERO HARDCODING) + §6 (row-driven).
    const rows = usersQuery.data?.rows ?? [];
    const total = rows.length;
    const active = rows.filter(
      (r) => statusLookupByValue.get(r.status ?? '')?.metadata?.is_active === true,
    ).length;
    const suspended = rows.filter(
      (r) => statusLookupByValue.get(r.status ?? '')?.metadata?.is_suspended === true,
    ).length;
    const invited = rows.filter(
      (r) => statusLookupByValue.get(r.status ?? '')?.metadata?.is_invited === true,
    ).length;
    return [
      { key: 'total', label: t('platformUsers.usersModule.totalUsers'), value: total, tone: 'neutral' as const },
      { key: 'active', label: t('platformUsers.usersModule.active'), value: active, tone: 'good' as const },
      { key: 'invited', label: t('platformUsers.usersModule.invited'), value: invited, tone: 'info' as const },
      { key: 'suspended', label: t('platformUsers.usersModule.suspended'), value: suspended, tone: 'danger' as const },
    ];
  }, [statusLookupByValue, usersQuery.data, t]);

  // Mutations — the hooks invalidate list-query prefixes so tenant-filtered
  // reads refresh after an invite, role, or lifecycle action.
  const grantMutation = useGrantUserRole();
  const revokeMutation = useRevokeUserRole();
  const suspendMutation = useSuspendUser();
  const reactivateMutation = useReactivateUser();
  const forceResetMutation = useForcePasswordReset();
  const inviteMutation = useTenantUserInvite();
  const pending =
    grantMutation.isPending ||
    revokeMutation.isPending ||
    suspendMutation.isPending ||
    reactivateMutation.isPending ||
    forceResetMutation.isPending ||
    inviteMutation.isPending;

  const selectedDirectory = useMemo(() => {
    if (selectedUserId) {
      const byId = userDirectoryById.get(selectedUserId);
      if (byId) return byId;
    }
    const email = selectedUserEmail?.toLowerCase();
    if (!email) return undefined;
    return (userDirectoryQuery.data?.rows ?? []).find((row) => (row.email ?? '').toLowerCase() === email);
  }, [selectedUserEmail, selectedUserId, userDirectoryById, userDirectoryQuery.data?.rows]);
  const selectedUser = useMemo(() => {
    const listRow = usersQuery.data?.rows.find((row) => row.id === selectedUserId) ?? null;
    if (listRow) return listRow;
    const email = selectedUserEmail?.toLowerCase();
    const emailRow = email
      ? usersQuery.data?.rows.find((row) => row.email.toLowerCase() === email) ?? null
      : null;
    if (emailRow) return emailRow;
    return selectedDirectory ? userRowFromDirectory(selectedDirectory) : null;
  }, [selectedDirectory, selectedUserEmail, selectedUserId, usersQuery.data?.rows]);
  const closeUserDrawer = () => {
    setSelectedUserId(null);
    setSelectedUserEmail(null);
  };
  const selectedLifecycleReadback =
    selectedUserId
      ? lifecycleReadbackByUserId[selectedUserId] ?? null
      : selectedUserEmail
        ? lifecycleReadbackByUserId[selectedUserEmail] ?? null
        : null;

  useEffect(() => {
    if (!requestedFocus || openedUrlFocus === requestedFocus || usersQuery.isLoading || userDirectoryQuery.isLoading) return;
    const normalizedFocus = requestedFocus.toLowerCase();
    const match =
      usersQuery.data?.rows.find((row) =>
        row.id === requestedFocus || row.email.toLowerCase() === normalizedFocus,
      ) ??
      userDirectoryQuery.data?.rows.find((row) =>
        row.id === requestedFocus || (row.email ?? '').toLowerCase() === normalizedFocus,
      ) ??
      null;
    if (!match) return;
    setOpenedUrlFocus(requestedFocus);
    setSelectedUserId(match.id);
    setSelectedUserEmail((match.email ?? requestedFocus).toLowerCase());
  }, [
    openedUrlFocus,
    requestedFocus,
    userDirectoryQuery.data?.rows,
    userDirectoryQuery.isLoading,
    usersQuery.data?.rows,
    usersQuery.isLoading,
  ]);

  function handleGrantRole(user: UserRow, roleKey: string) {
    grantMutation.mutate(
      { target_user_id: user.id, role_key: roleKey },
      {
        onSuccess: () =>
          pushToast(`grant_user_role_v1 - ${user.email} - ${roleKey}`, 'good'),
        onError: (err: Error) =>
          pushToast(t('platformUsers.usersModule.roleGrantCouldNot'), 'danger'),
      },
    );
  }

  function handleRevokeRole(user: UserRow, roleKey: string) {
    revokeMutation.mutate(
      { target_user_id: user.id, role_key: roleKey },
      {
        onSuccess: () =>
          pushToast(`revoke_user_role_v1 - ${user.email} - ${roleKey}`, 'warn'),
        onError: (err: Error) =>
          pushToast(t('platformUsers.usersModule.roleRevokeCouldNot'), 'danger'),
      },
    );
  }

  function handleSuspendUser(user: UserRow) {
    function SuspendUserConfirm() {
      const { t } = useI18n();
      const [reason, setReason] = useState('');
      const valid = reason.trim().length > 0;
      return (
        <div data-testid="users-suspend-confirm">
          <p className="state__hint">
            {t('platformUsers.suspendUserConfirm.suspendingThisUserBlocks')}
          </p>
          <div className="field">
            <label className="field__label" htmlFor="users-suspend-reason">
              {t('platformUsers.suspendUserConfirm.reason')}
            </label>
            <textarea
              id="users-suspend-reason"
              rows={3}
              value={reason}
              onChange={(event) => setReason(event.target.value)}
              placeholder={t('platformUsers.suspendUserConfirm.roleEndedSecurityReview')}
            />
          </div>
          <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8, marginTop: 12 }}>
            <Button label={t('platformUsers.suspendUserConfirm.cancel')} kind="ghost" onClick={() => modal.close()} />
            <Button
              label={suspendMutation.isPending ? t('platformUsers.suspendUserConfirm.suspending') : t('platformUsers.suspendUserConfirm.confirmSuspend')}
              kind="danger"
              capability={CAP.USERS_MANAGE}
              disabled={!valid || suspendMutation.isPending}
              onClick={() => {
                modal.close();
                suspendMutation.mutate(
                  { target_user_id: user.id, reason: reason.trim() },
                  {
                    onSuccess: () => {
                      setSelectedUserId(user.id);
                      setLifecycleReadbackByUserId((previous) => ({
                        ...previous,
                        [user.id]: `Saved data confirms ${user.email} is suspended in this drawer.`,
                      }));
                      pushToast(fill(t('platformUsers.suspendUserConfirm.userSuspended'), { email: String(user.email) }), 'warn');
                    },
                    onError: (err: Error) =>
                      pushToast(t('platformUsers.suspendUserConfirm.userSuspensionCouldNot'), 'danger'),
                  },
                );
              }}
            />
          </div>
        </div>
      );
    }
    modal.open({
      title: fill(t('platformUsers.usersModule.suspendUser'), { email: String(user.email) }),
      body: <SuspendUserConfirm />,
    });
  }

  function handleReactivateUser(user: UserRow) {
    reactivateMutation.mutate(
      { target_user_id: user.id },
      {
        onSuccess: () => {
          setSelectedUserId(user.id);
          setLifecycleReadbackByUserId((previous) => ({
            ...previous,
            [user.id]: `Saved data confirms ${user.email} is active in this drawer.`,
          }));
          pushToast(fill(t('platformUsers.usersModule.userReactivated'), { email: String(user.email) }), 'good');
        },
        onError: (err: Error) =>
          pushToast(t('platformUsers.usersModule.userReactivationCouldNot'), 'danger'),
      },
    );
  }

  function handleForcePasswordReset(user: UserRow) {
    function ForcePasswordResetConfirm() {
      const { t } = useI18n();
      const [reason, setReason] = useState('');
      const valid = reason.trim().length > 0;
      return (
        <div data-testid="users-force-password-reset-confirm">
          <p className="state__hint">
            {t('platformUsers.forcePasswordResetConfirm.passwordResetRequestsAre')}
          </p>
          <div className="field">
            <label className="field__label" htmlFor="users-force-password-reset-reason">
              {t('platformUsers.forcePasswordResetConfirm.reason')}
            </label>
            <textarea
              id="users-force-password-reset-reason"
              rows={3}
              value={reason}
              onChange={(event) => setReason(event.target.value)}
              placeholder={t('platformUsers.forcePasswordResetConfirm.securityReviewUserRequest')}
            />
          </div>
          <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8, marginTop: 12 }}>
            <Button label={t('platformUsers.forcePasswordResetConfirm.cancel')} kind="ghost" onClick={() => modal.close()} />
            <Button
              label={forceResetMutation.isPending ? t('platformUsers.forcePasswordResetConfirm.requesting') : t('platformUsers.forcePasswordResetConfirm.confirmReset')}
              kind="danger"
              capability={CAP.USERS_MANAGE}
              disabled={!valid || forceResetMutation.isPending}
              onClick={() => {
                forceResetMutation.mutate(
                  { target_user_id: user.id, email: user.email, reason: reason.trim() },
                  {
                    onSuccess: () => {
                      modal.close();
                      pushToast(
                        fill(t('platformUsers.forcePasswordResetConfirm.passwordResetStarted'), { email: String(user.email) }),
                        'good',
                      );
                    },
                    onError: (err: Error) =>
                      pushToast(t('platformUsers.forcePasswordResetConfirm.passwordResetCouldNot'), 'danger'),
                  },
                );
              }}
            />
          </div>
        </div>
      );
    }
    modal.open({
      title: fill(t('platformUsers.usersModule.forcePasswordReset'), { email: String(user.email) }),
      body: <ForcePasswordResetConfirm />,
    });
  }

  async function handleResendInvite(user: UserRow) {
    if (!canManage) {
      pushToast(t('platformUsers.usersModule.inviteResendRequiresUser'), 'danger');
      return;
    }
    const inviteRedirectTo = hostedInviteRedirect();
    if (!inviteRedirectTo) {
      pushToast(t('platformUsers.usersModule.hostedInviteResendRequires'), 'danger');
      return;
    }
    const directory = userDirectoryById.get(user.id);
    const roleKey = directory?.active_role_keys?.[0];
    if (!roleKey) {
      pushToast(fill(t('platformUsers.usersModule.inviteResendFailedNo'), { email: String(user.email) }), 'danger');
      return;
    }
    const accessScopeType = user.access_scope_type ?? 'tenant';
    try {
      const result = await inviteMutation.mutateAsync({
        email: user.email,
        full_name: user.full_name ?? user.email,
        role_key: roleKey,
        organization_id: user.organization_id ?? activeOrganizationId,
        access_scope_type: accessScopeType,
        access_scope_id:
          accessScopeType === 'client' || accessScopeType === 'sender'
            ? user.access_scope_id ?? null
            : null,
        send_invite_email: true,
        invite_redirect_to: inviteRedirectTo,
        resend_existing_invite: true,
      });
      setSelectedUserId(user.id);
      setSelectedUserEmail(user.email.toLowerCase());
      setLifecycleReadbackByUserId((previous) => ({
        ...previous,
        [user.id]: `Invite resend was saved for ${user.email}.`,
      }));
      const sent = result.invite_email_sent === true || result.invite_email_sent === 'true';
      pushToast(
        sent ? fill(t('platformUsers.usersModule.inviteResentTo'), { email: String(user.email) }) : fill(t('platformUsers.usersModule.inviteResendRequestedFor'), { email: String(user.email) }),
        sent ? 'good' : 'warn',
      );
    } catch (err) {
      pushToast(t('platformUsers.usersModule.inviteEmailCouldNot'), 'danger');
    }
  }

  function openUserDrawer(user: UserRow) {
    setSelectedUserId(user.id);
    setSelectedUserEmail(user.email.toLowerCase());
    void usersQuery.refetch();
    void userDirectoryQuery.refetch();
  }

  // Bulk actions — Suspend / Reactivate are row-driven so the operator can
  // sweep through invited or stale rows without opening the drawer per row.
  // Capability gating ensures the buttons disable + lock when missing
  // `users.manage`.
  const bulkSuspend = (rows: UserRow[]) => {
    if (!canManage) {
      pushToast(t('platformUsers.usersModule.suspendRequiresUserManagement'), 'danger');
      return;
    }
    void Promise.allSettled(rows.map((r) => suspendMutation.mutateAsync({ target_user_id: r.id }))).then(
      (results) => {
        const failed = results.filter((result) => result.status === 'rejected');
        results.forEach((result, index) => {
          if (result.status === 'rejected') {
            pushToast(
              fill(t('platformUsers.usersModule.suspendFailedFor'), { value: String(rows[index]?.email ?? t('platformUsers.usersModule.selectedUser')), value2: String(result.reason instanceof Error ? result.reason.message : String(result.reason)) }),
              'danger',
            );
          }
        });
        const succeeded = results.length - failed.length;
        if (succeeded > 0) pushToast(`${succeeded}/${rows.length} user(s) suspended`, 'warn');
        if (failed.length > 0) pushToast(fill(t('platformUsers.usersModule.userSWereNot'), { length: String(failed.length), length2: String(rows.length) }), 'danger');
      },
    );
  };
  const bulkReactivate = (rows: UserRow[]) => {
    if (!canManage) {
      pushToast(t('platformUsers.usersModule.reactivateRequiresUserManagement'), 'danger');
      return;
    }
    void Promise.allSettled(rows.map((r) => reactivateMutation.mutateAsync({ target_user_id: r.id }))).then(
      (results) => {
        const failed = results.filter((result) => result.status === 'rejected');
        results.forEach((result, index) => {
          if (result.status === 'rejected') {
            pushToast(
              fill(t('platformUsers.usersModule.reactivateFailedFor'), { value: String(rows[index]?.email ?? t('platformUsers.usersModule.selectedUser')), value2: String(result.reason instanceof Error ? result.reason.message : String(result.reason)) }),
              'danger',
            );
          }
        });
        const succeeded = results.length - failed.length;
        if (succeeded > 0) pushToast(`${succeeded}/${rows.length} user(s) reactivated`, 'good');
        if (failed.length > 0) pushToast(fill(t('platformUsers.usersModule.userSWereNot2'), { length: String(failed.length), length2: String(rows.length) }), 'danger');
      },
    );
  };

  const openInviteUser = () => {
    function InviteBody() {
      const { t } = useI18n();
      return (
        <InviteUserModalBody
          organizationId={activeOrganizationId}
          defaultAccessScopeType={defaultAccessScopeType}
          canManage={canManage}
          pending={inviteMutation.isPending}
          onCancel={() => modal.close()}
          onSubmit={async (args) => {
            try {
              const result = await inviteMutation.mutateAsync(args);
              const invitedUserId =
                typeof result.user_id === 'string'
                  ? result.user_id
                  : typeof result.id === 'string'
                    ? result.id
                    : null;
              modal.close();
              const invitedEmail = args.email.toLowerCase();
              setSelectedUserEmail(invitedEmail);
              if (invitedUserId) {
                setSelectedUserId(invitedUserId);
              }
              setLifecycleReadbackByUserId((previous) => ({
                ...previous,
                ...(invitedUserId
                  ? { [invitedUserId]: `Invite decision was saved for ${args.email}.` }
                  : {}),
                [invitedEmail]: `Invite decision was saved for ${args.email}.`,
              }));
              pushToast(fill(t('platformUsers.inviteBody.inviteSentTo'), { email: String(args.email) }), 'good');
            } catch (err) {
              pushToast(t('platformUsers.inviteBody.inviteCouldNotBe'), 'danger');
            }
          }}
        />
      );
    }

    modal.open({ title: t('platformUsers.usersModule.inviteUser'), body: <InviteBody /> });
  };

  if (!canRead) {
    return (
      <div className="page" data-testid="users-page">
        <PageHeader
          eyebrow={t('platformUsers.usersModule.platform')}
          titleAccent={t('platformUsers.usersModule.titleAccent')}
          titlePlain={t('platformUsers.usersModule.titlePlain')}
          pills={[
            <span key="cap" className="chip chip--xs mono">
              {t('platformUsers.usersModule.userAccessUserManagement')}
            </span>,
          ] as ReactNode[]}
        />
        <StateView
          kind="denied"
          capability={CAP.USERS_READ}
          hint={t('platformUsers.usersModule.userManagementRequiresUser')}
        />
      </div>
    );
  }

  return (
    <div className="page" data-testid="users-page">
      <PageHeader
        eyebrow={t('platformUsers.usersModule.platform')}
        titleAccent={t('platformUsers.usersModule.titleAccent')}
        titlePlain={t('platformUsers.usersModule.titlePlain')}
        pills={[
          activeOrganizationId ? (
            <span key="org" className="chip chip--xs">
              {requestedOrganizationId ? t('platformUsers.usersModule.tenantHandoffActive') : t('platformUsers.usersModule.tenantScopeActive')}
            </span>
          ) : null,
          <span key="user-access" className="chip chip--xs">
            {t('platformUsers.usersModule.userAccess')}
          </span>,
        ].filter(Boolean) as ReactNode[]}
        actions={[
          <Button
            key="invite"
            label={t('platformUsers.usersModule.inviteUser')}
            iconName="user_in"
            kind="primary"
            capability={CAP.USERS_MANAGE}
            onClick={openInviteUser}
          />,
        ]}
      />

      <div className="kpi-strip" data-testid="users-kpi-strip">
        {kpis.map((k) => (
          <KPICard
            key={k.key}
            label={k.label}
            value={k.value}
            tone={k.tone}
          />
        ))}
      </div>

      {usersQuery.isLoading ||
      userDirectoryQuery.isLoading ||
      (userStatusLookupQuery.isLoading && statusFilters.length <= 1) ? (
        <StateView kind="loading" />
      ) : usersReadError ? (
        <StateView
          kind="error"
          title={t('platformUsers.usersModule.usersReadFailed')}
          hint={usersReadErrorMessage(usersReadError)}
        />
      ) : statusFilters.length <= 1 ? (
        <StateView
          kind="error"
          hint={t('platformUsers.usersModule.userStatusOptionsAre')}
        />
      ) : (
        <>
          <div className="dt-toolbar">
            <span className="eyebrow">{t('platformUsers.usersModule.status')}</span>
            {statusFilters.map((f) => (
              <button
                key={f}
                type="button"
                className={`dt-tb-view-tab ${statusFilter === f ? 'is-active' : ''}`}
                onClick={() => setStatusFilter(f)}
                data-testid={`users-status-${f}`}
              >
                {f}
              </button>
            ))}
            <span className="dt-tb-spacer" />
            <span className="dt-tb-count mono">
              {`${filteredUsers.length}/${usersQuery.data?.rows?.length ?? 0}`}
            </span>
          </div>
          <DataTable<UserRow>
            columns={columns}
            rows={filteredUsers}
            viewKey="users"
            entityKind="users"
            onRowClick={openUserDrawer}
            bulkActions={[
              {
                label: t('platformUsers.usersModule.suspend'),
                icon: 'close',
                kind: 'danger',
                capability: CAP.USERS_MANAGE,
                onClick: bulkSuspend,
              },
              {
                label: t('platformUsers.usersModule.reactivate'),
                icon: 'check',
                kind: 'primary',
                capability: CAP.USERS_MANAGE,
                onClick: bulkReactivate,
              },
            ]}
          />
        </>
      )}
      {selectedUser ? (
        <Drawer
          open
          title={fill(t('platformUsers.usersModule.user'), { value: String(selectedUser.full_name ?? selectedUser.email) })}
          size="lg"
          onClose={closeUserDrawer}
        >
          <UsersDrawerBody
            user={selectedUser}
            directory={selectedDirectory}
            roleOptions={roleOptions}
            canManage={canManage}
            onGrant={(roleKey) => handleGrantRole(selectedUser, roleKey)}
            onRevoke={(roleKey) => handleRevokeRole(selectedUser, roleKey)}
            onSuspend={() => handleSuspendUser(selectedUser)}
            onReactivate={() => handleReactivateUser(selectedUser)}
            onForcePasswordReset={() => handleForcePasswordReset(selectedUser)}
            onResendInvite={() => void handleResendInvite(selectedUser)}
            lifecycleReadback={selectedLifecycleReadback}
            pending={pending}
          />
        </Drawer>
      ) : null}
      {modal.node}
    </div>
  );
}
