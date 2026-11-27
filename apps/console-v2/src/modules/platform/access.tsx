// access.tsx — `/platform/access` operator surface.
//
// Phase E3 (CLAIM-IDENTITY-RBAC) extends the historical capability matrix
// with the canonical RBAC role-management lifecycle: list/create/edit/delete
// roles, list/grant/revoke user-role assignments, and apply global role
// templates. The capability + resource catalog is still resolved through
// `public.resolve_access_control_policy_v1` (override-ladder evaluator); the
// new RBAC tabs read straight from the canonical tables via
// `useResourceList<RbacRoleRow>('rbac_roles')` etc, mirroring the production
// SSOT in supabase/migrations/202601300030_rbac_foundation_v1.sql +
// supabase/migrations/202601300050_rbac_role_templates_v1.sql.
//
// Capability gates (registered in seed-raw/registry.js capabilities array):
//   - access_policy.read    → tabs visibility, list reads
//   - access_policy.approve → mutate (create/edit/deactivate role + grant/revoke
//                              + apply template)
//
// Mutations (queries.ts hooks):
//   useCreateRbacRole / useUpdateRbacRole / useDeleteRbacRole /
//   useGrantRbacRole / useRevokeRbacRole / useApplyRbacRoleTemplate
//
// All RBAC mutation RPC names follow canonical naming and are shipped through
// the typed query/API/data-source hooks. `provision_rbac_roles_from_templates_v1`
// remains the template provisioning path.

import { useMemo, useState, type ReactNode } from 'react';
import { PageHeader } from '@/components/PageHeader';
import { ScopePill } from '@/components/ScopePill';
import { Dot } from '@/components/Dot';
import { Chip } from '@/components/Chip';
import { Button } from '@/components/Button';
import { Icon } from '@/components/Icon';
import { DataTable, type DataTableColumn } from '@/components/DataTable';
import { StateView } from '@/components/StateView';
import { useModal, useDrawer } from '@/hooks/useOverlay';
import { useIdentity } from '@/lib/identity';
import {
  CAP,
  formatCapabilityLabel,
  formatCapabilityRequirement,
  formatCapabilityTitle,
  hasWildcardCapability,
} from '@/lib/capabilities';
import {
  useResolveAccessPolicy,
  useRequestCapabilityGrant,
  useReviewCapabilityGrantRequest,
  useResolveSettings,
  useResourceList,
  useCompleteResourceList,
  useCreateRbacRole,
  useUpdateRbacRole,
  useDeleteRbacRole,
  useGrantRbacRole,
  useRevokeRbacRole,
  useApplyRbacRoleTemplate,
} from '@/lib/queries';
import { pushToast } from '@/components/toastStore';
import { CapabilityEvalDrilldown } from '@/components/CapabilityEvalDrilldown';
import { readAuthorizedConsoleScopeOverride } from '@/lib/scope-url';
import { fill, useI18n, useT, type Translate } from '@/lib/i18n';

interface PolicyCapability {
  key: string;
  label?: string;
}

interface PolicyResourceMapEntry {
  read?: string;
  write?: string;
}

interface AccessControlPolicyBody {
  capabilities?: PolicyCapability[];
  resource_map?: Record<string, PolicyResourceMapEntry>;
}

function accessResourceLabel(value: string): string {
  const raw = String(value ?? '').trim();
  if (!raw) return 'Resource';
  return raw
    .replace(/^v_/, '')
    .replace(/[._-]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/\b\w/g, (match) => match.toUpperCase());
}

function accessScopeLabel(value: string | null | undefined): string {
  return accessResourceLabel(value ?? 'global');
}

function accessScopeReferenceLabel(scopeType: string | null | undefined, scopeId: string | null | undefined): string {
  if (!scopeId) return 'Global default';
  return `${accessScopeLabel(scopeType)} scope`;
}

function accessQueryErrorHint(error: unknown, fallback: string): string {
  const message = error instanceof Error ? error.message : String(error ?? '').trim();
  return message ? `${fallback} ${message}` : fallback;
}

// -----------------------------------------------------------------------------
// RBAC row interfaces — mirror the canonical tables exactly.
// SSOT: supabase/migrations/202601300030_rbac_foundation_v1.sql:59-145 +
//       supabase/migrations/202601300050_rbac_role_templates_v1.sql:19-43.
//
// W19-3 paired-RPC closure (2026-04-27) — see __audit__/SCHEMA-DRIFT/IDENTITY.md
// (W19-3 closure section at end of file). Every field on the four RBAC row
// interfaces below has been re-verified against canonical SSOT and explicitly
// annotated either as `// SSOT: <table>.<column>` (canonical) or
// `// SSOT: projection — <derivation>` (joined or computed at the BE / FE).
// No undocumented fictional fields remain.
//
// W19-3 paired-RPC items closed:
//   1. RbacRoleRow.{permission_count,assignment_count} — projections (counts)
//   2. RbacRolePermissionRow.permission_value — projection (lookup_values.value)
//   3. RbacUserRoleAssignmentRow.{user_email,user_full_name} — projections (users join)
//   4. RbacUserRoleAssignmentRow.{role_key,role_name} — projections (rbac_roles join)
//   5. RbacRoleTemplateRow.{permission_count,permission_values} — projections
//      (count + flattened lookup_values.value array via rbac_role_template_permissions)
// -----------------------------------------------------------------------------

interface RbacRoleRow extends Record<string, unknown> {
  id: string;                                // SSOT: rbac_roles.id
  organization_id: string;                   // SSOT: rbac_roles.organization_id
  key: string;                               // SSOT: rbac_roles.key
  name: string;                              // SSOT: rbac_roles.name
  description: string | null;                // SSOT: rbac_roles.description
  is_active: boolean;                        // SSOT: rbac_roles.is_active
  metadata: Record<string, unknown>;         // SSOT: rbac_roles.metadata
  created_at: string;                        // SSOT: rbac_roles.created_at
  updated_at: string;                        // SSOT: rbac_roles.updated_at
  permission_count?: number;                 // SSOT: projection — count(rbac_role_permissions WHERE role_id=id)
  assignment_count?: number;                 // SSOT: projection — count(rbac_user_role_assignments WHERE role_id=id AND revoked_at IS NULL)
}

interface RbacRolePermissionRow extends Record<string, unknown> {
  id: string;                                // SSOT: rbac_role_permissions.id
  organization_id: string;                   // SSOT: rbac_role_permissions.organization_id
  role_id: string;                           // SSOT: rbac_role_permissions.role_id
  permission_id?: string;                    // SSOT: rbac_role_permissions.permission_id (FK lookup_values.id)
  permission_value?: string;                 // SSOT: projection — lookup_values.value via permission_id join (display key)
  granted_by_user_id: string | null;         // SSOT: rbac_role_permissions.granted_by_user_id
  granted_at: string;                        // SSOT: rbac_role_permissions.granted_at
  metadata: Record<string, unknown>;         // SSOT: rbac_role_permissions.metadata
  created_at: string;                        // SSOT: rbac_role_permissions.created_at
  updated_at: string;                        // SSOT: rbac_role_permissions.updated_at
}

interface RbacUserRoleAssignmentRow extends Record<string, unknown> {
  id: string;                                // SSOT: rbac_user_role_assignments.id
  organization_id: string;                   // SSOT: rbac_user_role_assignments.organization_id
  user_id: string;                           // SSOT: rbac_user_role_assignments.user_id
  user_email?: string;                       // SSOT: projection — users.email via user_id join
  user_full_name?: string;                   // SSOT: projection — users.full_name via user_id join
  role_id: string;                           // SSOT: rbac_user_role_assignments.role_id
  role_key?: string;                         // SSOT: projection — rbac_roles.key via role_id join
  role_name?: string;                        // SSOT: projection — rbac_roles.name via role_id join
  assigned_by_user_id: string | null;        // SSOT: rbac_user_role_assignments.assigned_by_user_id
  assigned_at: string;                       // SSOT: rbac_user_role_assignments.assigned_at
  revoked_by_user_id: string | null;         // SSOT: rbac_user_role_assignments.revoked_by_user_id
  revoked_at: string | null;                 // SSOT: rbac_user_role_assignments.revoked_at
  metadata: Record<string, unknown>;         // SSOT: rbac_user_role_assignments.metadata
  created_at: string;                        // SSOT: rbac_user_role_assignments.created_at
  updated_at: string;                        // SSOT: rbac_user_role_assignments.updated_at
}

interface RbacRoleTemplateRow extends Record<string, unknown> {
  id: string;                                // SSOT: rbac_role_templates.id
  key: string;                               // SSOT: rbac_role_templates.key
  name: string;                              // SSOT: rbac_role_templates.name
  description: string | null;                // SSOT: rbac_role_templates.description
  is_active: boolean;                        // SSOT: rbac_role_templates.is_active
  metadata: Record<string, unknown>;         // SSOT: rbac_role_templates.metadata
  permission_count?: number;                 // SSOT: projection — count(rbac_role_template_permissions WHERE role_template_id=id)
  permission_values?: string[];              // SSOT: projection — array_agg(lookup_values.value) via rbac_role_template_permissions join
  created_at: string;                        // SSOT: rbac_role_templates.created_at
  updated_at: string;                        // SSOT: rbac_role_templates.updated_at
}

interface RbacTemplateApplyRoleResult extends Record<string, unknown> {
  template_key?: string;
  role_id?: string;
  created?: boolean;
}

interface RbacTemplateApplyResult extends Record<string, unknown> {
  ok?: boolean;
  rbac_role_id?: string;
  rbac_roles?: RbacTemplateApplyRoleResult[];
  organization_id?: string;
  template_keys?: string[];
  correlation_id?: string;
}

interface RbacAssignmentMutationEvidence {
  action: 'granted' | 'revoked';
  assignmentId: string | null;
  userLabel: string;
  roleLabel: string;
  status: 'active' | 'revoked';
  reason?: string | null;
  correlationId?: string | null;
}

interface AccessRequestEvidence extends Record<string, unknown> {
  id?: string;
  capability_key?: string;
  scope_type?: string;
  scope_id?: string | null;
  duration_hours?: number | null;
  reason?: string;
  capability_grant_request_id?: string;
  status?: string;
  correlation_id?: string;
  decision_log_id?: string;
  created_at?: string;
  idempotent?: boolean;
}

interface CapabilityGrantRequestRow extends Record<string, unknown> {
  id: string;
  organization_id: string;
  requested_by?: string | null;
  requested_by_email?: string | null;
  requested_by_full_name?: string | null;
  target_user_id?: string | null;
  target_user_email?: string | null;
  target_user_full_name?: string | null;
  capability_key: string;
  scope_type: string;
  scope_id?: string | null;
  reason?: string | null;
  duration_hours?: number | null;
  status: 'pending' | 'approved' | 'denied' | 'cancelled' | string;
  decided_by?: string | null;
  decided_by_email?: string | null;
  decided_by_full_name?: string | null;
  decided_at?: string | null;
  decision_notes?: string | null;
  correlation_id?: string | null;
  decision_log_id?: string | null;
  approved_role_id?: string | null;
  approved_permission_id?: string | null;
  approved_assignment_id?: string | null;
  created_at: string;
  updated_at?: string | null;
}

interface AccessRequestReviewEvidence extends AccessRequestEvidence {
  decision_notes?: string | null;
  requested_by_email?: string | null;
  target_user_email?: string | null;
  decided_by_email?: string | null;
  decided_at?: string | null;
  rbac_role_id?: string | null;
  rbac_role_permission_id?: string | null;
  rbac_user_role_assignment_id?: string | null;
}

function normalizeAccessRequestReadback(result: Record<string, unknown>): AccessRequestEvidence | null {
  const readback = result.request_readback;
  if (!readback || typeof readback !== 'object') return null;
  const row = readback as Record<string, unknown>;
  const id = typeof row.id === 'string' ? row.id : undefined;
  const capabilityKey = typeof row.capability_key === 'string' ? row.capability_key : undefined;
  const scopeType = typeof row.scope_type === 'string' ? row.scope_type : undefined;
  const status = typeof row.status === 'string' ? row.status : undefined;
  if (!id || !capabilityKey || !scopeType || !status) return null;
  const durationValue = row.duration_hours;
  const durationHours =
    typeof durationValue === 'number'
      ? durationValue
      : typeof durationValue === 'string' && durationValue.trim()
        ? Number(durationValue)
        : null;
  return {
    id,
    capability_grant_request_id:
      typeof result.capability_grant_request_id === 'string'
        ? result.capability_grant_request_id
        : id,
    capability_key: capabilityKey,
    scope_type: scopeType,
    scope_id: typeof row.scope_id === 'string' ? row.scope_id : null,
    duration_hours: durationHours !== null && Number.isFinite(durationHours) ? durationHours : null,
    reason: typeof row.reason === 'string' ? row.reason : undefined,
    status,
    correlation_id: typeof row.correlation_id === 'string' ? row.correlation_id : undefined,
    decision_log_id: typeof row.decision_log_id === 'string' ? row.decision_log_id : undefined,
    created_at: typeof row.created_at === 'string' ? row.created_at : undefined,
    idempotent: Boolean(result.idempotent),
  };
}

function normalizeAccessRequestReviewReadback(
  result: Record<string, unknown>,
): AccessRequestReviewEvidence | null {
  const base = normalizeAccessRequestReadback(result);
  if (!base) return null;
  const row = result.request_readback as Record<string, unknown>;
  return {
    ...base,
    decision_notes:
      typeof row.decision_notes === 'string'
        ? row.decision_notes
        : null,
    requested_by_email:
      typeof row.requested_by_email === 'string'
        ? row.requested_by_email
        : null,
    target_user_email:
      typeof row.target_user_email === 'string'
        ? row.target_user_email
        : null,
    decided_by_email:
      typeof row.decided_by_email === 'string'
        ? row.decided_by_email
        : null,
    decided_at:
      typeof row.decided_at === 'string'
        ? row.decided_at
        : null,
    rbac_role_id:
      typeof result.rbac_role_id === 'string'
        ? result.rbac_role_id
        : typeof row.approved_role_id === 'string'
          ? row.approved_role_id
          : null,
    rbac_role_permission_id:
      typeof result.rbac_role_permission_id === 'string'
        ? result.rbac_role_permission_id
        : typeof row.approved_permission_id === 'string'
          ? row.approved_permission_id
          : null,
    rbac_user_role_assignment_id:
      typeof result.rbac_user_role_assignment_id === 'string'
        ? result.rbac_user_role_assignment_id
        : typeof row.approved_assignment_id === 'string'
          ? row.approved_assignment_id
          : null,
  };
}

// W23 paired projection — public.v_rbac_role_summary
// (supabase/migrations/202604302210_v_rbac_role_summary.sql). Promotes the
// W19-3 `permission_count` / `assignment_count` projections from FE-side
// derived annotations on `RbacRoleRow` to a canonical view, and adds
// `permission_values`, `revoked_assignment_count`, `last_assigned_at`,
// `role_tier`, and the joined organization label/slug. Production cutover
// is a single getSupabaseClient() branch flip in
// `ui_list_resource_v1('rbac_role_summary')`. The base `rbac_roles` read
// seam is unchanged so the surface degrades gracefully when the projection
// cache has not yet hydrated.
interface RbacRoleEditorDraft {
  key: string;
  name: string;
  description: string;
}

function normalizeRbacRoleKey(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .replace(/_{2,}/g, '_');
}

function RbacRoleEditorBody({
  existing,
  onDraftChange,
}: {
  existing?: RbacRoleRow;
  onDraftChange: (draft: RbacRoleEditorDraft) => void;
}) {
  const { t } = useI18n();
  const editing = Boolean(existing);
  const [keyManuallyEdited, setKeyManuallyEdited] = useState(editing);
  const [draft, setDraft] = useState<RbacRoleEditorDraft>(() => ({
    key: existing?.key ?? '',
    name: existing?.name ?? '',
    description: existing?.description ?? '',
  }));

  const updateDraft = (updater: (previous: RbacRoleEditorDraft) => RbacRoleEditorDraft) => {
    setDraft((previous) => {
      const next = updater(previous);
      onDraftChange(next);
      return next;
    });
  };

  return (
    <div data-testid="rbac-role-editor-body">
      <p
        className="state__hint"
        style={{
          margin: '0 0 10px',
          padding: '8px 10px',
          border: '1px solid var(--line)',
          borderRadius: '6px',
          fontSize: '11.5px',
        }}
      >
        {t('platformAccess.rbacRoleEditorBody.savesATenantScoped')}
      </p>
      <div className="field">
        <label className="field__label">{t('platformAccess.rbacRoleEditorBody.name')}</label>
        <input
          type="text"
          value={draft.name}
          data-testid="rbac-role-editor-name"
          placeholder={t('platformAccess.rbacRoleEditorBody.dispatchLead')}
          onChange={(event) => {
            const nextName = event.target.value;
            updateDraft((previous) => {
              const previousAutoKey = normalizeRbacRoleKey(previous.name);
              const shouldSyncKey =
                !editing &&
                (!keyManuallyEdited ||
                  previous.key.trim() === '' ||
                  previous.key === previousAutoKey);
              return {
                ...previous,
                name: nextName,
                key: shouldSyncKey ? normalizeRbacRoleKey(nextName) : previous.key,
              };
            });
          }}
        />
      </div>
      <div className="field">
        <label className="field__label">{t('platformAccess.rbacRoleEditorBody.customRoleSlug')}</label>
        <input
          type="text"
          value={draft.key}
          placeholder={t('platformAccess.rbacRoleEditorBody.dispatchLead2')}
          data-testid="rbac-role-editor-key"
          disabled={editing}
          onChange={(event) => {
            setKeyManuallyEdited(true);
            updateDraft((previous) => ({
              ...previous,
              key: normalizeRbacRoleKey(event.target.value),
            }));
          }}
        />
        <small className="state__hint">
          {t('platformAccess.rbacRoleEditorBody.lowercaseSnakeCaseUnique')}
        </small>
      </div>
      <div className="field">
        <label className="field__label">{t('platformAccess.rbacRoleEditorBody.description')}</label>
        <input
          type="text"
          value={draft.description}
          data-testid="rbac-role-editor-description"
          placeholder={t('platformAccess.rbacRoleEditorBody.whatThisRoleIs')}
          onChange={(event) => {
            updateDraft((previous) => ({
              ...previous,
              description: event.target.value,
            }));
          }}
        />
      </div>
    </div>
  );
}

interface RbacRoleSummaryRow extends Record<string, unknown> {
  id: string;                                // SSOT: rbac_roles.id
  organization_id: string | null;            // SSOT: rbac_roles.organization_id
  key: string | null;                        // SSOT: rbac_roles.key
  name: string | null;                       // SSOT: rbac_roles.name
  description: string | null;                // SSOT: rbac_roles.description
  is_active: boolean;                        // SSOT: rbac_roles.is_active
  metadata: Record<string, unknown>;         // SSOT: rbac_roles.metadata
  created_at: string | null;                 // SSOT: rbac_roles.created_at
  updated_at: string | null;                 // SSOT: rbac_roles.updated_at
  organization_label: string | null;         // SSOT: projection — organizations.name via organization_id join
  organization_slug: string | null;          // SSOT: projection — organizations.slug via organization_id join
  role_tier: string;                         // SSOT: projection — metadata->>'tier' (default 'functional')
  permission_count: number;                  // SSOT: projection — count(rbac_role_permissions WHERE role_id=id)
  permission_values: string[];               // SSOT: projection — array_agg(lookup_values.value) via rbac_role_permissions join
  assignment_count: number;                  // SSOT: projection — count(rbac_user_role_assignments WHERE role_id=id AND revoked_at IS NULL)
  active_assignment_count: number;           // SSOT: projection — same as assignment_count (active filter)
  revoked_assignment_count: number;          // SSOT: projection — count(rbac_user_role_assignments WHERE role_id=id AND revoked_at IS NOT NULL)
  last_assigned_at: string | null;           // SSOT: projection — max(rbac_user_role_assignments.assigned_at) via role_id join
}

// W-Cycle-E2 (P1 #2) — `scope_type_registry` row shape mirrors the canonical
// SSOT seed (`scope_type_registry` in policies.js + the paired backend
// migration 202601301100_scope_registry_ssot.sql). Drives the Scope <select>
// options for the capability-grant request modal so the option list stays
// row-driven (mirrors the config.tsx + mobile-policy.tsx pattern) instead of
// an inline `<option>` literal cluster. AGENTS.md §2 (ZERO HARDCODING) +
// §4 (SSOT).
interface ScopeTypeRegistryRow {
  id: string;
  scope_type: string;
  description?: string;
  ladder_rank: number;
  is_enabled?: boolean;
}

interface UserPickerRow extends Record<string, unknown> {
  id: string;
  email?: string | null;
  full_name?: string | null;
  name?: string | null;
}

function userPickerLabel(row: UserPickerRow): string {
  return row.email ?? row.full_name ?? row.name ?? row.id;
}

function normalizeTemplateApplyRoles(result: RbacTemplateApplyResult | null): RbacTemplateApplyRoleResult[] {
  if (!result) return [];
  if (Array.isArray(result.rbac_roles) && result.rbac_roles.length > 0) {
    return result.rbac_roles;
  }
  if (result.rbac_role_id) {
    const templateKey =
      Array.isArray(result.template_keys) && result.template_keys.length > 0
        ? result.template_keys[0]
        : undefined;
    return [{ role_id: result.rbac_role_id, template_key: templateKey }];
  }
  return [];
}

type AccessTabKey = 'policy' | 'roles' | 'assignments' | 'templates' | 'requests';

function accessTabs(t: Translate): Array<{ key: AccessTabKey; label: string }> {
  return [
    { key: 'policy', label: t('platformAccess.accessModule.policy') },
    { key: 'roles', label: t('platformAccess.accessModule.roles') },
    { key: 'assignments', label: t('platformAccess.accessModule.assignments') },
    { key: 'templates', label: t('platformAccess.accessModule.templates') },
    { key: 'requests', label: t('platformAccess.accessModule.requests') },
  ];
}

// -----------------------------------------------------------------------------
// AccessModule — top-level surface with tabbed lifecycle.
// -----------------------------------------------------------------------------

export function AccessModule() {
  const t = useT();
  const { user, scope, capabilities, hasCapability } = useIdentity();
  const myCaps = useMemo(() => new Set(capabilities), [capabilities]);
  const modal = useModal();
  const drawer = useDrawer();
  // CLAIM-PLATFORM-ACCESS / Phase C6 — canonical request_capability_grant_v1
  // RPC. Replaces the PREVIEW chip + synthetic toast.
  const requestGrantMutation = useRequestCapabilityGrant();
  const requestedScope = useMemo(
    () => readAuthorizedConsoleScopeOverride({ user }),
    [user.access_scope_type],
  );
  const tenantId =
    requestedScope?.scopeType === 'tenant'
      ? requestedScope.scopeId
      : scope.tenant?.id ?? (user.access_scope_type === 'tenant' ? user.organization_id : null);
  const effectiveAccessScopeType = requestedScope?.scopeType ?? user.access_scope_type;
  const effectiveAccessScopeId =
    requestedScope
      ? requestedScope.scopeId
      : user.access_scope_id ?? (user.access_scope_type === 'tenant' ? tenantId ?? null : null);
  const accessRead = hasCapability(CAP.ACCESS_POLICY_READ);
  const canApprove = hasCapability(CAP.ACCESS_POLICY_APPROVE);
  const accessReadQueryOptions = useMemo(() => ({ enabled: accessRead }), [accessRead]);
  const tenantFilter = useMemo(() => {
    if (!tenantId) return undefined;
    return { filter: { organization_id: tenantId } };
  }, [tenantId]);

  // Canonical resolver — pinned to the user's effective access scope.
  const access = useResolveAccessPolicy(effectiveAccessScopeType, effectiveAccessScopeId, accessReadQueryOptions);
  const policy = (access.data?.policy ?? null) as AccessControlPolicyBody | null;

  const policyCaps = useMemo<string[]>(() => {
    const list = policy?.capabilities ?? [];
    return list.map((c) => c.key).filter((k): k is string => typeof k === 'string' && k.length > 0);
  }, [policy?.capabilities]);

  const policyResources = useMemo<Array<[string, PolicyResourceMapEntry]>>(() => {
    return Object.entries(policy?.resource_map ?? {});
  }, [policy?.resource_map]);

  const [search, setSearch] = useState('');
  const [tab, setTab] = useState<AccessTabKey>('policy');
  const [templateApplyEvidence, setTemplateApplyEvidence] = useState<RbacTemplateApplyResult | null>(null);
  const [assignmentMutationEvidence, setAssignmentMutationEvidence] =
    useState<RbacAssignmentMutationEvidence | null>(null);
  const [accessRequestEvidence, setAccessRequestEvidence] = useState<AccessRequestEvidence | null>(null);
  const [accessRequestReviewEvidence, setAccessRequestReviewEvidence] =
    useState<AccessRequestReviewEvidence | null>(null);

  // CLAIM-IDENTITY-RBAC (Phase E3) — RBAC list reads.
  const rolesQuery = useCompleteResourceList<RbacRoleRow>('rbac_roles', tenantFilter, accessReadQueryOptions);
  const rolePermsQuery = useCompleteResourceList<RbacRolePermissionRow>(
    'rbac_role_permissions',
    tenantFilter,
    accessReadQueryOptions,
  );
  const assignmentsQuery = useCompleteResourceList<RbacUserRoleAssignmentRow>(
    'rbac_user_role_assignments',
    tenantFilter,
    accessReadQueryOptions,
  );
  const templatesQuery = useResourceList<RbacRoleTemplateRow>(
    'rbac_role_templates',
    undefined,
    accessReadQueryOptions,
  );
  const grantRequestsQuery = useCompleteResourceList<CapabilityGrantRequestRow>(
    'capability_grant_requests',
    tenantFilter,
    accessReadQueryOptions,
  );
  const usersQuery = useCompleteResourceList<UserPickerRow>('users', tenantFilter, accessReadQueryOptions);
  const userOptions = useMemo<UserPickerRow[]>(() => {
    return (usersQuery.data?.rows ?? [])
      .slice()
      .sort((a, b) => userPickerLabel(a).localeCompare(userPickerLabel(b)));
  }, [usersQuery.data]);
  const grantableRoleOptions = useMemo<RbacRoleRow[]>(
    () => (rolesQuery.data?.rows ?? []).filter((role) => role.is_active),
    [rolesQuery.data],
  );
  const canOpenGrantRole =
    !!tenantId &&
    !usersQuery.isLoading &&
    !usersQuery.error &&
    userOptions.length > 0 &&
    !rolesQuery.isLoading &&
    !rolesQuery.error &&
    grantableRoleOptions.length > 0;
  const grantRoleBlockedReason = usersQuery.error
    ? accessQueryErrorHint(usersQuery.error, 'Could not load users for role grants.')
    : rolesQuery.error
      ? accessQueryErrorHint(rolesQuery.error, 'Could not load roles for role grants.')
      : !tenantId
        ? 'Select a tenant before granting tenant RBAC roles.'
        : usersQuery.isLoading || rolesQuery.isLoading
        ? 'Loading users and roles before role grants can be started.'
        : userOptions.length === 0
          ? 'No users are available to grant a role in this scope.'
          : grantableRoleOptions.length === 0
            ? 'No active roles are available to grant in this scope.'
            : null;
  // W-Cycle-E2 (P1 #2) — Scope <select> options for the capability-grant
  // request modal derive from canonical `scope_type_registry` (rank-sorted
  // ascending; only enabled rows). Mirrors the config.tsx + mobile-policy.tsx
  // pattern so the option list stays row-driven across every settings/access
  // surface. AGENTS.md §2 (ZERO HARDCODING) + §4 (SSOT).
  const scopeRegistryQuery = useResourceList<ScopeTypeRegistryRow>(
    'scope_type_registry',
    undefined,
    accessReadQueryOptions,
  );
  const scopeOptions = useMemo<Array<{ value: string; label: string }>>(() => {
    const rows = scopeRegistryQuery.data?.rows ?? [];
    return rows
      .filter((r) => r.is_enabled !== false)
      .slice()
      .sort((a, b) => a.ladder_rank - b.ladder_rank)
      .map((r) => ({
        value: r.scope_type,
        label: r.scope_type.charAt(0).toUpperCase() + r.scope_type.slice(1),
      }));
  }, [scopeRegistryQuery.data]);

  // W-Cycle-E2 (P2 #13) — `capability_grant_policy` policy. Drives the
  // capability-grant request modal Duration input (default + max hours).
  // Replaces inline `24` / `720` literals (`policies.js#sv_393`). When
  // missing, the modal falls through to safe operator-visible defaults
  // (default 1, max 1) so the gap is observable rather than masked.
  const grantPolicyResolution = useResolveSettings(
    'capability_grant_policy',
    undefined,
    accessReadQueryOptions,
  );
  const grantPolicy = grantPolicyResolution.data?.value as
    | { default_hours?: number; max_hours?: number }
    | undefined;
  const grantDefaultHours = grantPolicy?.default_hours;
  const grantMaxHours = grantPolicy?.max_hours;
  // W23 — additive paired projection. The base `rbac_roles` read seam
  // remains the canonical SSOT; this read enriches the role drawer with
  // the canonical permission_count + active/revoked assignment counters
  // + last_assigned_at + role_tier + organization_label via
  // `v_rbac_role_summary` instead of FE-side counter math.
  const roleSummaryQuery = useCompleteResourceList<RbacRoleSummaryRow>(
    'rbac_role_summary',
    tenantFilter,
    accessReadQueryOptions,
  );
  const roleSummaryById = useMemo(() => {
    const map = new Map<string, RbacRoleSummaryRow>();
    for (const r of roleSummaryQuery.data?.rows ?? []) map.set(r.id, r);
    return map;
  }, [roleSummaryQuery.data]);

  // Mutations — all gate on `access_policy.approve` capability at call sites.
  const createRole = useCreateRbacRole();
  const updateRole = useUpdateRbacRole();
  const deleteRole = useDeleteRbacRole();
  const grantRole = useGrantRbacRole();
  const revokeRole = useRevokeRbacRole();
  const applyTemplate = useApplyRbacRoleTemplate();
  const reviewGrantRequest = useReviewCapabilityGrantRequest();
  const templateApplyRoles = useMemo(
    () => normalizeTemplateApplyRoles(templateApplyEvidence),
    [templateApplyEvidence],
  );
  const tenantMutationBlockedReason = tenantId
    ? null
    : 'Select a tenant before changing tenant RBAC roles.';

  const refetchRbacSurface = async () => {
    await Promise.all([
      rolesQuery.refetch({ throwOnError: true }),
      roleSummaryQuery.refetch({ throwOnError: true }),
      rolePermsQuery.refetch({ throwOnError: true }),
      assignmentsQuery.refetch({ throwOnError: true }),
      templatesQuery.refetch({ throwOnError: true }),
      grantRequestsQuery.refetch({ throwOnError: true }),
    ]);
  };

  const filteredCaps = useMemo(() => {
    const q = search.toLowerCase();
    if (!q) return policyCaps;
    return policyCaps.filter((c) => c.toLowerCase().includes(q));
  }, [policyCaps, search]);

  const filteredResources = useMemo(() => {
    const q = search.toLowerCase();
    if (!q) return policyResources;
    return policyResources.filter(
      ([k, def]) =>
        k.toLowerCase().includes(q) ||
        (def.read ?? '').toLowerCase().includes(q) ||
        (def.write ?? '').toLowerCase().includes(q),
    );
  }, [policyResources, search]);

  const resolveAccessScopeId = (scopeType: string): string | null => {
    if (requestedScope?.scopeType === scopeType) return requestedScope.scopeId;
    if (scopeType === 'global' || scopeType === 'platform') return null;
    if (scopeType === 'tenant') return tenantId ?? user.organization_id ?? null;
    const scoped = scope[scopeType as keyof typeof scope];
    if (typeof scoped?.id === 'string' && scoped.id) return scoped.id;
    return user.access_scope_type === scopeType ? user.access_scope_id ?? null : null;
  };

  const requestCapability = (cap: string) => {
    let scopeType: string = effectiveAccessScopeType === 'platform' ? 'tenant' : effectiveAccessScopeType;
    // W-Cycle-E2 (P2 #13) — Duration default resolves through canonical
    // `capability_grant_policy.default_hours` (no inline `24` literal).
    let durationHours: number = grantDefaultHours ?? 1;
    let justification: string = '';
    modal.open({
      title: (
        <span style={{ display: 'inline-flex', alignItems: 'center', gap: '8px' }}>
          {fill(t('platformAccess.accessModule.requestAccess'), { value: formatCapabilityLabel(cap, { titleCase: true }, t) })}
        </span>
      ),
      body: (
        <div data-testid="access-request-modal-body">
          <p
            className="state__hint"
            style={{
              margin: '0 0 10px',
              padding: '8px 10px',
              border: '1px solid var(--line)',
              borderRadius: '6px',
              fontSize: '11.5px',
            }}
          >
            {t('platformAccess.accessModule.submitsAScopedTime')}
          </p>
          <div className="field">
            <label className="field__label">{t('platformAccess.accessModule.scope')}</label>
            <select
              className="field"
              defaultValue={scopeType}
              onChange={(e) => {
                scopeType = e.target.value;
              }}
            >
              {scopeOptions.map((opt) => (
                <option key={opt.value} value={opt.value}>
                  {opt.label}
                </option>
              ))}
            </select>
          </div>
          <div className="field">
            <label className="field__label">{t('platformAccess.accessModule.durationHours')}</label>
            {grantPolicy ? null : (
              <Chip
                label={t('platformAccess.accessModule.accessRequestPolicyMissing')}
                kind="danger"
                size="xs"
                className="mono"
              />
            )}
            <input
              type="number"
              defaultValue={durationHours}
              min={1}
              max={grantMaxHours ?? 1}
              onChange={(e) => {
                durationHours = Number(e.target.value);
              }}
            />
          </div>
          <div className="field">
            <label className="field__label">{t('platformAccess.accessModule.justification')}</label>
            <input
              type="text"
              placeholder={t('platformAccess.accessModule.requiredForIncidentResponse')}
              onChange={(e) => {
                justification = e.target.value;
              }}
            />
          </div>
        </div>
      ),
      footer: (
        <div style={{ display: 'flex', justifyContent: 'flex-end', gap: '8px' }}>
          <Button label={t('platformAccess.accessModule.cancel')} kind="ghost" onClick={() => modal.close()} />
          <Button
            label={t('platformAccess.accessModule.submitRequest')}
            iconName="check"
            kind="primary"
            onClick={() => {
              requestGrantMutation.mutate(
                {
                  capability_key: cap,
                  scope_type: scopeType,
                  scope_id: resolveAccessScopeId(scopeType),
                  duration_hours: durationHours,
                  reason: justification,
                  justification,
                },
                {
                  onSuccess: (result: Record<string, unknown>) => {
                    const readback = normalizeAccessRequestReadback(result);
                    if (!readback) {
                      pushToast(t('platformAccess.accessModule.accessRequestSubmittedBut'), 'danger');
                      return;
                    }
                    setAccessRequestEvidence(readback);
                    pushToast(fill(t('platformAccess.accessModule.accessRequestSubmitted'), { value: formatCapabilityTitle(cap, t) }), 'good');
                    modal.close();
                  },
                  onError: () => pushToast(t('platformAccess.accessModule.accessRequestCouldNot'), 'danger'),
                },
              );
            }}
          />
        </div>
      ),
    });
  };

  const openReviewAccessRequest = (
    request: CapabilityGrantRequestRow,
    decision: 'approved' | 'denied',
  ) => {
    const approving = decision === 'approved';
    let notes = '';
    let submitted = false;
    const submitReview = async () => {
      if (submitted) return;
      submitted = true;
      pushToast(fill(t('platformAccess.accessModule.reviewingAccessRequest'), { capability_key: String(request.capability_key) }), 'info');
      try {
        const result = await reviewGrantRequest.mutateAsync({
          request_id: request.id,
          decision,
          decision_notes: notes,
        });
        const readback = normalizeAccessRequestReviewReadback(result);
        if (!readback) {
          submitted = false;
          pushToast(t('platformAccess.accessModule.accessRequestReviewCompleted'), 'danger');
          return;
        }
        await refetchRbacSurface();
        setAccessRequestReviewEvidence(readback);
        pushToast(fill(t('platformAccess.accessModule.accessRequest'), { decision: String(decision), capability_key: String(request.capability_key) }), 'good');
        modal.close();
      } catch (err) {
        submitted = false;
        pushToast(t('platformAccess.accessModule.accessRequestReviewCould'), 'danger');
      }
    };
    modal.open({
      title: t(approving ? 'platformAccess.accessModule.approveAccessRequest' : 'platformAccess.accessModule.denyAccessRequest'),
      body: (
        <div data-testid="access-request-review-body">
          <p
            className="state__hint"
            style={{
              margin: '0 0 10px',
              padding: '8px 10px',
              border: '1px solid var(--line)',
              borderRadius: '6px',
              fontSize: '11.5px',
            }}
          >
            {t('platformAccess.accessModule.reviewsThePersistedAccess')}
          </p>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: '6px', marginBottom: '10px' }}>
            <Chip label={request.capability_key} kind="neutral" size="xs" className="mono" />
            <Chip label={request.status} kind={request.status === 'pending' ? 'warn' : 'info'} size="xs" />
            <Chip
              label={request.target_user_email ?? request.target_user_full_name ?? request.target_user_id ?? t('platformAccess.accessModule.targetUser')}
              kind="neutral"
              size="xs"
              className="mono"
            />
          </div>
          {request.reason ? (
            <div className="state__hint mono" style={{ margin: '0 0 10px' }}>
              {request.reason}
            </div>
          ) : null}
          <div className="field">
            <label className="field__label">{t('platformAccess.accessModule.decisionNotes')}</label>
            <input
              type="text"
              placeholder={approving ? t('platformAccess.accessModule.approvedForCurrentOperations') : t('platformAccess.accessModule.deniedWithReason')}
              data-testid="access-request-review-notes"
              onChange={(event) => {
                notes = event.target.value;
              }}
            />
          </div>
        </div>
      ),
      footer: (
        <div style={{ display: 'flex', justifyContent: 'flex-end', gap: '8px' }}>
          <Button label={t('platformAccess.accessModule.cancel')} kind="ghost" onClick={() => modal.close()} />
          <Button
            label={approving ? t('platformAccess.accessModule.approve') : t('platformAccess.accessModule.deny')}
            iconName={approving ? 'check' : 'close'}
            kind={approving ? 'primary' : 'danger'}
            capability={CAP.ACCESS_POLICY_APPROVE}
            disabled={request.status !== 'pending'}
            title={request.status !== 'pending' ? t('platformAccess.accessModule.requestIsAlreadyReviewed') : undefined}
            onClick={() => {
              void submitReview();
            }}
          />
        </div>
      ),
    });
  };

  const wildcardGranted = hasWildcardCapability(myCaps);
  const grantedCount = wildcardGranted ? policyCaps.length : policyCaps.filter((c) => myCaps.has(c)).length;
  const totalCount = policyCaps.length;
  const policyPillLabel = !accessRead
    ? 'Policy denied'
    : access.error || (!access.isLoading && !access.data)
      ? 'Policy unavailable'
      : access.isLoading
        ? 'Policy loading'
        : 'Policy enforced';
  const roleCountPillLabel = rolesQuery.error
    ? 'roles unavailable'
    : `${rolesQuery.data?.rows?.length ?? 0} roles`;

  const scopePath = access.data?.scope_path ?? [];
  const winningScopeType = access.data?.scope_type ?? 'global';

  // -----------------------------------------------------------------------
  // RBAC mutation handlers — modal/drawer-driven flows.
  // -----------------------------------------------------------------------

  const openRoleEditor = (existing?: RbacRoleRow) => {
    let draft: RbacRoleEditorDraft = {
      key: existing?.key ?? '',
      name: existing?.name ?? '',
      description: existing?.description ?? '',
    };
    const editing = Boolean(existing);
    modal.open({
      title: editing ? fill(t('platformAccess.accessModule.editRole'), { value: String(existing!.name || existing!.key) }) : t('platformAccess.accessModule.createAccessRole'),
      body: (
        <RbacRoleEditorBody
          existing={existing}
          onDraftChange={(next) => {
            draft = next;
          }}
        />
      ),
      footer: (
        <div style={{ display: 'flex', justifyContent: 'flex-end', gap: '8px' }}>
          <Button label={t('platformAccess.accessModule.cancel')} kind="ghost" onClick={() => modal.close()} />
          <Button
            label={editing ? t('platformAccess.accessModule.save') : t('platformAccess.accessModule.create')}
            iconName="check"
            kind="primary"
            capability={CAP.ACCESS_POLICY_APPROVE}
            onClick={() => {
              const key = normalizeRbacRoleKey(draft.key);
              const name = draft.name.trim();
              const description = draft.description.trim();
              if (!key || !name) {
                pushToast(t('platformAccess.accessModule.roleNameAndCustom'), 'danger');
                return;
              }
              if (!tenantId) {
                pushToast(t('platformAccess.accessModule.selectATenantBefore'), 'danger');
                return;
              }
              const duplicate = (rolesQuery.data?.rows ?? []).some(
                (role) => role.key === key && role.id !== existing?.id,
              );
              if (duplicate) {
                pushToast(fill(t('platformAccess.accessModule.roleSlugAlreadyExists'), { key: String(key) }), 'danger');
                return;
              }
              const args: Record<string, unknown> = {
                organization_id: tenantId,
                key,
                name,
                description,
              };
              const fn = editing ? updateRole : createRole;
              if (editing) {
                args.role_id = existing!.id;
              }
              fn.mutate(args, {
                onSuccess: async () => {
                  await refetchRbacSurface();
                  pushToast(
                    editing
                      ? fill(t('platformAccess.accessModule.accessRoleUpdated'), { value: String(name || key) })
                      : fill(t('platformAccess.accessModule.accessRoleCreated'), { value: String(name || key) }),
                    'good',
                  );
                  modal.close();
                },
                onError: () => pushToast(t('platformAccess.accessModule.accessRoleCouldNot'), 'danger'),
              });
            }}
          />
        </div>
      ),
    });
  };

  const openRoleDelete = (role: RbacRoleRow) => {
    modal.open({
      title: fill(t('platformAccess.accessModule.deactivateRole'), { key: String(role.key) }),
      body: (
        <div data-testid="rbac-role-delete-body">
          <p>
            {t('platformAccess.accessModule.deactivateRolePrefix')} <code className="mono">{role.key}</code>
            {t('platformAccess.accessModule.theRoleStaysInactive')}{' '}
            <code className="mono">{role.assignment_count ?? 0}</code>{' '}
            {t('platformAccess.accessModule.activeAssignmentsAreRevoked')}
          </p>
        </div>
      ),
      footer: (
        <div style={{ display: 'flex', justifyContent: 'flex-end', gap: '8px' }}>
          <Button label={t('platformAccess.accessModule.cancel')} kind="ghost" onClick={() => modal.close()} />
          <Button
            label={t('platformAccess.accessModule.deactivate')}
            iconName="close"
            kind="danger"
            capability={CAP.ACCESS_POLICY_APPROVE}
            disabled={!role.organization_id}
            title={!role.organization_id ? tenantMutationBlockedReason ?? undefined : undefined}
            onClick={() =>
              deleteRole.mutate(
                { role_id: role.id, organization_id: role.organization_id },
                {
                  onSuccess: async () => {
                    await refetchRbacSurface();
                    pushToast(fill(t('platformAccess.accessModule.accessRoleDeactivated'), { value: String(role.name || role.key) }), 'good');
                    modal.close();
                    drawer.close();
                  },
                  onError: () => pushToast(t('platformAccess.accessModule.accessRoleCouldNot2'), 'danger'),
                },
              )
            }
          />
        </div>
      ),
    });
  };

  const openGrantRole = () => {
    let userId = userOptions[0]?.id ?? '';
    let roleId = grantableRoleOptions[0]?.id ?? '';
    const hasUsers = userOptions.length > 0;
    modal.open({
      title: t('platformAccess.accessModule.grantRoleToUser'),
      body: (
        <div data-testid="rbac-grant-modal-body">
          <p
            className="state__hint"
            style={{
              margin: '0 0 10px',
              padding: '8px 10px',
              border: '1px solid var(--line)',
              borderRadius: '6px',
              fontSize: '11.5px',
            }}
          >
            {t('platformAccess.accessModule.grantsTheSelectedRole')}
          </p>
          {hasUsers ? (
            <div className="field">
              <label className="field__label">{t('platformAccess.accessModule.user')}</label>
              <select
                defaultValue={userId}
                data-testid="rbac-grant-user-id"
                onChange={(e) => {
                  userId = e.target.value;
                }}
              >
                {userOptions.map((u) => (
                  <option key={u.id} value={u.id}>
                    {userPickerLabel(u)} - {u.id}
                  </option>
                ))}
              </select>
            </div>
          ) : (
            <StateView
              kind="error"
              title={t('platformAccess.accessModule.noUsersAvailable')}
              hint={t('platformAccess.accessModule.grantingARoleRequires')}
            />
          )}
          <div className="field">
            <label className="field__label">{t('platformAccess.accessModule.role')}</label>
            <select
              defaultValue={roleId}
              data-testid="rbac-grant-role-select"
              onChange={(e) => {
                roleId = e.target.value;
              }}
            >
              {grantableRoleOptions.map((r) => (
                <option key={r.id} value={r.id}>
                  {r.name} · {r.key}
                </option>
              ))}
            </select>
          </div>
        </div>
      ),
      footer: (
        <div style={{ display: 'flex', justifyContent: 'flex-end', gap: '8px' }}>
          <Button label={t('platformAccess.accessModule.cancel')} kind="ghost" onClick={() => modal.close()} />
          <Button
            label={t('platformAccess.accessModule.grant')}
            iconName="check"
            kind="primary"
            capability={CAP.ACCESS_POLICY_APPROVE}
            disabled={!hasUsers || !roleId}
            onClick={() => {
              const selectedUser = userOptions.find((u) => u.id === userId);
              const selectedRole = grantableRoleOptions.find((r) => r.id === roleId);
              grantRole.mutate(
                {
                  organization_id: tenantId,
                  user_id: userId,
                  role_id: roleId,
                },
                {
                  onSuccess: async (result) => {
                    await refetchRbacSurface();
                    setAssignmentMutationEvidence({
                      action: 'granted',
                      assignmentId: result.rbac_user_role_assignment_id ?? null,
                      userLabel: selectedUser ? userPickerLabel(selectedUser) : userId,
                      roleLabel: selectedRole?.key ?? selectedRole?.name ?? roleId,
                      status: 'active',
                      correlationId:
                        typeof result.correlation_id === 'string' ? result.correlation_id : null,
                    });
                    pushToast(fill(t('platformAccess.accessModule.roleGranted'), { value: String(selectedUser ? userPickerLabel(selectedUser) : 'selected user') }), 'good');
                    modal.close();
                  },
                  onError: () => pushToast(t('platformAccess.accessModule.roleGrantCouldNot'), 'danger'),
                },
              );
            }}
          />
        </div>
      ),
    });
  };

  const openRevokeAssignment = (assignment: RbacUserRoleAssignmentRow) => {
    let reason = '';
    modal.open({
      title: fill(t('platformAccess.accessModule.revokeRole'), { value: String(assignment.role_key ?? assignment.role_id) }),
      body: (
        <div data-testid="rbac-revoke-modal-body">
          <p
            className="state__hint"
            style={{
              margin: '0 0 10px',
              padding: '8px 10px',
              border: '1px solid var(--line)',
              borderRadius: '6px',
              fontSize: '11.5px',
            }}
          >
            {t('platformAccess.accessModule.revokesTheSelectedAssignment')}
          </p>
          <div className="field">
            <label className="field__label">{t('platformAccess.accessModule.reason')}</label>
            <input
              type="text"
              placeholder={t('platformAccess.accessModule.noLongerRequired')}
              data-testid="rbac-revoke-reason"
              onChange={(e) => {
                reason = e.target.value;
              }}
            />
          </div>
        </div>
      ),
      footer: (
        <div style={{ display: 'flex', justifyContent: 'flex-end', gap: '8px' }}>
          <Button label={t('platformAccess.accessModule.cancel')} kind="ghost" onClick={() => modal.close()} />
          <Button
            label={t('platformAccess.accessModule.revoke')}
            iconName="close"
            kind="danger"
            capability={CAP.ACCESS_POLICY_APPROVE}
            onClick={() =>
              revokeRole.mutate(
                {
                  assignment_id: assignment.id,
                  organization_id: assignment.organization_id,
                  reason,
                },
                {
                  onSuccess: async (result) => {
                    await refetchRbacSurface();
                    setAssignmentMutationEvidence({
                      action: 'revoked',
                      assignmentId: result.rbac_user_role_assignment_id ?? assignment.id,
                      userLabel: assignment.user_email ?? assignment.user_full_name ?? assignment.user_id,
                      roleLabel: assignment.role_key ?? assignment.role_name ?? assignment.role_id,
                      status: 'revoked',
                      reason: reason.trim() || null,
                      correlationId:
                        typeof result.correlation_id === 'string' ? result.correlation_id : null,
                    });
                    pushToast(
                      fill(t('platformAccess.accessModule.roleRevoked'), { value: String(assignment.role_name ?? assignment.role_key ?? assignment.role_id) }),
                      'good',
                    );
                    modal.close();
                    drawer.close();
                  },
                  onError: () => pushToast(t('platformAccess.accessModule.roleRevokeCouldNot'), 'danger'),
                },
              )
            }
          />
        </div>
      ),
    });
  };

  const openApplyTemplate = (template: RbacRoleTemplateRow) => {
    modal.open({
      title: fill(t('platformAccess.accessModule.applyTemplate'), { key: String(template.key) }),
      body: (
        <div data-testid="rbac-template-apply-body">
          <p
            className="state__hint"
            style={{
              margin: '0 0 10px',
              padding: '8px 10px',
              border: '1px solid var(--line)',
              borderRadius: '6px',
              fontSize: '11.5px',
            }}
          >
            {t('platformAccess.accessModule.appliesTheSelectedTemplate')}{' '}
            <strong>{template.permission_count ?? template.permission_values?.length ?? 0}</strong>{' '}
            {t('platformAccess.accessModule.permissionsOntoTenantRole')}{' '}
            <code className="mono">{template.key}</code>.
          </p>
          {template.permission_values && template.permission_values.length > 0 ? (
            <div className="field">
              <label className="field__label">{t('platformAccess.accessModule.permissions')}</label>
              <div
                style={{ display: 'flex', flexWrap: 'wrap', gap: '4px' }}
                data-testid="rbac-template-permission-list"
              >
                {template.permission_values.map((p) => (
                  <Chip key={p} label={p} kind="info" size="xs" />
                ))}
              </div>
            </div>
          ) : null}
        </div>
      ),
      footer: (
        <div style={{ display: 'flex', justifyContent: 'flex-end', gap: '8px' }}>
          <Button label={t('platformAccess.accessModule.cancel')} kind="ghost" onClick={() => modal.close()} />
          <Button
            label={t('platformAccess.accessModule.apply')}
            iconName="check"
            kind="primary"
            capability={CAP.ACCESS_POLICY_APPROVE}
            disabled={!tenantId}
            title={tenantMutationBlockedReason ?? undefined}
            onClick={() =>
              applyTemplate.mutate(
                {
                  organization_id: tenantId,
                  template_keys: [template.key],
                },
                {
                  onSuccess: async (result) => {
                    await refetchRbacSurface();
                    setTemplateApplyEvidence(result as RbacTemplateApplyResult);
                    pushToast(
                      fill(t('platformAccess.accessModule.accessTemplateApplied'), { value: String(template.name || template.key) }),
                      'good',
                    );
                    modal.close();
                  },
                  onError: () => pushToast(t('platformAccess.accessModule.accessTemplateCouldNot'), 'danger'),
                },
              )
            }
          />
        </div>
      ),
    });
  };

  const openRoleDrawer = (role: RbacRoleRow) => {
    const perms = (rolePermsQuery.data?.rows ?? []).filter((p) => p.role_id === role.id);
    const assignees = (assignmentsQuery.data?.rows ?? []).filter(
      (a) => a.role_id === role.id && !a.revoked_at,
    );
    // W23 — pull paired projection rollups for this role, if available.
    // The drawer prefers canonical projection counters over inline
    // FE-side `.length` math so the operator-visible numbers match the
    // canonical `v_rbac_role_summary` SSOT exactly.
    const summary = roleSummaryById.get(role.id);
    const permCount = summary?.permission_count ?? perms.length;
    const assignmentCount = summary?.active_assignment_count ?? assignees.length;
    const revokedCount = summary?.revoked_assignment_count ?? 0;
    const lastAssignedAt = summary?.last_assigned_at ?? null;
    const roleTier = summary?.role_tier ?? null;
    const orgLabel = summary?.organization_label ?? null;
    drawer.open({
      title: `${role.name} · ${role.key}`,
      size: 'lg',
      body: (
        <div data-testid="rbac-role-drawer-body" style={{ padding: '12px' }}>
          <div style={{ display: 'flex', gap: '6px', marginBottom: '12px', flexWrap: 'wrap' }}>
            <Chip label={role.is_active ? t('platformAccess.accessModule.active') : t('platformAccess.accessModule.inactive')} kind={role.is_active ? 'good' : 'warn'} size="xs" />
            <Chip
              label={fill(t('platformAccess.accessModule.permissions2'), { permCount: String(permCount) })}
              kind="info"
              size="xs"
              data-testid="rbac-role-drawer-permission-count"
            />
            <Chip
              label={fill(t('platformAccess.accessModule.assignees'), { assignmentCount: String(assignmentCount) })}
              kind="info"
              size="xs"
              data-testid="rbac-role-drawer-assignment-count"
            />
            {summary ? (
              <Chip
                label={fill(t('platformAccess.accessModule.revoked'), { revokedCount: String(revokedCount) })}
                kind={revokedCount > 0 ? 'warn' : 'neutral'}
                size="xs"
                data-testid="rbac-role-drawer-revoked-count"
              />
            ) : null}
            {roleTier ? (
              <Chip
                label={fill(t('platformAccess.accessModule.tier'), { roleTier: String(roleTier) })}
                kind="neutral"
                size="xs"
                data-testid="rbac-role-drawer-tier"
              />
            ) : null}
            {orgLabel ? (
              <Chip
                label={orgLabel}
                kind="neutral"
                size="xs"
                data-testid="rbac-role-drawer-org-label"
              />
            ) : null}
            {lastAssignedAt ? (
              <Chip
                label={fill(t('platformAccess.accessModule.lastAssigned'), { value: String(lastAssignedAt.slice(0, 10)) })}
                kind="neutral"
                size="xs"
                data-testid="rbac-role-drawer-last-assigned"
              />
            ) : null}
            <span style={{ flex: 1 }} />
            <Button
              label={t('platformAccess.accessModule.edit')}
              kind="ghost"
              size="sm"
              capability={CAP.ACCESS_POLICY_APPROVE}
              onClick={() => {
                drawer.close();
                openRoleEditor(role);
              }}
            />
            <Button
              label={t('platformAccess.accessModule.deactivate')}
              kind="danger"
              size="sm"
              capability={CAP.ACCESS_POLICY_APPROVE}
              disabled={!role.is_active}
              title={!role.is_active ? t('platformAccess.accessModule.roleIsAlreadyInactive') : undefined}
              onClick={() => {
                drawer.close();
                openRoleDelete(role);
              }}
            />
          </div>
          {role.description ? (
            <p style={{ fontSize: '12px', color: 'var(--mute)', marginBottom: '12px' }}>
              {role.description}
            </p>
          ) : null}
          <div className="section-eyebrow" style={{ marginTop: 0 }}>{t('platformAccess.accessModule.permissions')}</div>
          <ul style={{ listStyle: 'none', padding: 0, margin: '0 0 16px' }} data-testid="rbac-role-drawer-permissions">
            {perms.length === 0 ? (
              <li style={{ fontSize: '11px', color: 'var(--mute)' }}>
                {t('platformAccess.accessModule.noPermissionsGrantedTo')}
              </li>
            ) : (
              perms.map((p) => (
                <li
                  key={p.id}
                  className="card"
                  style={{ padding: '6px 8px', marginBottom: '4px', display: 'flex', alignItems: 'center', gap: '8px' }}
                >
                  <Dot kind="good" />
                  <code className="mono" style={{ fontSize: '11px' }}>
                    {p.permission_value}
                  </code>
                  <span style={{ flex: 1 }} />
                  <span className="mono" style={{ fontSize: '10px', color: 'var(--mute)' }}>
                    {new Date(p.granted_at).toISOString().slice(0, 10)}
                  </span>
                </li>
              ))
            )}
          </ul>
          <div className="section-eyebrow" style={{ marginTop: 0 }}>{t('platformAccess.accessModule.activeAssignees')}</div>
          <ul style={{ listStyle: 'none', padding: 0, margin: 0 }} data-testid="rbac-role-drawer-assignees">
            {assignees.length === 0 ? (
              <li style={{ fontSize: '11px', color: 'var(--mute)' }}>
                {t('platformAccess.accessModule.noActiveAssignees')}
              </li>
            ) : (
              assignees.map((a) => (
                <li
                  key={a.id}
                  className="card"
                  style={{ padding: '6px 8px', marginBottom: '4px', display: 'flex', alignItems: 'center', gap: '8px' }}
                >
                  <Dot kind="good" />
                  <span className="mono" style={{ fontSize: '11px' }}>
                    {a.user_email ?? a.user_full_name ?? t('platformAccess.accessModule.assignedUser')}
                  </span>
                  <span style={{ flex: 1 }} />
                  <Button
                    label={t('platformAccess.accessModule.revoke')}
                    kind="ghost"
                    size="sm"
                    capability={CAP.ACCESS_POLICY_APPROVE}
                    onClick={() => {
                      drawer.close();
                      openRevokeAssignment(a);
                    }}
                  />
                </li>
              ))
            )}
          </ul>
        </div>
      ),
    });
  };

  const openTemplateDrawer = (template: RbacRoleTemplateRow) => {
    const permissions = template.permission_values ?? [];

    drawer.open({
      title: `${template.name} - ${template.key}`,
      size: 'lg',
      body: (
        <div data-testid="rbac-template-drawer-body" style={{ padding: '12px' }}>
          <div style={{ display: 'flex', gap: '6px', marginBottom: '12px', flexWrap: 'wrap' }}>
            <Chip
              label={template.is_active ? t('platformAccess.accessModule.active') : t('platformAccess.accessModule.inactive')}
              kind={template.is_active ? 'good' : 'warn'}
              size="xs"
            />
            <Chip
              label={fill(t('platformAccess.accessModule.permissions3'), { value: String(template.permission_count ?? permissions.length) })}
              kind="info"
              size="xs"
            />
            <span style={{ flex: 1 }} />
            <Button
              label={t('platformAccess.accessModule.applyTemplate2')}
              iconName="check"
              kind="primary"
              size="sm"
              capability={CAP.ACCESS_POLICY_APPROVE}
              onClick={() => {
                drawer.close();
                openApplyTemplate(template);
              }}
            />
          </div>
          {template.description ? (
            <p style={{ fontSize: '12px', color: 'var(--mute)', marginBottom: '12px' }}>
              {template.description}
            </p>
          ) : null}
          <div className="section-eyebrow" style={{ marginTop: 0 }}>{t('platformAccess.accessModule.templatePermissions')}</div>
          <ul
            style={{ listStyle: 'none', padding: 0, margin: 0 }}
            data-testid="rbac-template-drawer-permissions"
          >
            {permissions.length === 0 ? (
              <li style={{ fontSize: '11px', color: 'var(--mute)' }}>
                {t('platformAccess.accessModule.noPermissionsDefinedOn')}
              </li>
            ) : (
              permissions.map((permission) => (
                <li
                  key={permission}
                  className="card"
                  style={{ padding: '6px 8px', marginBottom: '4px', display: 'flex', alignItems: 'center', gap: '8px' }}
                >
                  <Dot kind="good" />
                  <code className="mono" style={{ fontSize: '11px' }}>
                    {permission}
                  </code>
                </li>
              ))
            )}
          </ul>
        </div>
      ),
    });
  };

  // -----------------------------------------------------------------------
  // RBAC table column definitions.
  // -----------------------------------------------------------------------

  const ROLE_COLUMNS: DataTableColumn<RbacRoleRow>[] = [
    { key: 'key', label: t('platformAccess.accessModule.roleSlug'), mono: true, sortable: true, filterable: true },
    { key: 'name', label: t('platformAccess.accessModule.name'), sortable: true, filterable: true },
    { key: 'description', label: t('platformAccess.accessModule.description') },
    { key: 'permission_count', label: t('platformAccess.accessModule.permissions'), align: 'right', sortable: true },
    { key: 'assignment_count', label: t('platformAccess.accessModule.assignees2'), align: 'right', sortable: true },
    {
      key: 'is_active',
      label: t('platformAccess.accessModule.active2'),
      sortable: true,
      filterable: true,
      render: (raw) => (
        <Chip label={raw ? t('platformAccess.accessModule.active') : t('platformAccess.accessModule.inactive')} kind={raw ? 'good' : 'warn'} size="xs" />
      ),
    },
    { key: 'updated_at', label: t('platformAccess.accessModule.updated'), format: 'datetime', sortable: true },
  ];

  const ASSIGNMENT_COLUMNS: DataTableColumn<RbacUserRoleAssignmentRow>[] = [
    { key: 'user_email', label: t('platformAccess.accessModule.user'), mono: true, sortable: true, filterable: true },
    { key: 'user_full_name', label: t('platformAccess.accessModule.name'), sortable: true, filterable: true },
    { key: 'role_key', label: t('platformAccess.accessModule.role'), mono: true, sortable: true, filterable: true },
    { key: 'role_name', label: t('platformAccess.accessModule.roleName'), sortable: true },
    { key: 'assigned_at', label: t('platformAccess.accessModule.assigned'), format: 'datetime', sortable: true },
    {
      key: 'revoked_at',
      label: t('platformAccess.accessModule.status'),
      sortable: true,
      filterable: true,
      render: (raw) => (
        <Chip
          label={raw ? t('platformAccess.accessModule.revoked2') : t('platformAccess.accessModule.active')}
          kind={raw ? 'warn' : 'good'}
          size="xs"
        />
      ),
    },
  ];

  const TEMPLATE_COLUMNS: DataTableColumn<RbacRoleTemplateRow>[] = [
    { key: 'key', label: t('platformAccess.accessModule.templateKey'), mono: true, sortable: true, filterable: true },
    { key: 'name', label: t('platformAccess.accessModule.name'), sortable: true, filterable: true },
    { key: 'description', label: t('platformAccess.accessModule.description') },
    { key: 'permission_count', label: t('platformAccess.accessModule.permissions'), align: 'right', sortable: true },
    {
      key: 'is_active',
      label: t('platformAccess.accessModule.active2'),
      sortable: true,
      filterable: true,
      render: (raw) => (
        <Chip label={raw ? t('platformAccess.accessModule.active') : t('platformAccess.accessModule.inactive')} kind={raw ? 'good' : 'warn'} size="xs" />
      ),
    },
    { key: 'updated_at', label: t('platformAccess.accessModule.updated'), format: 'datetime', sortable: true },
  ];

  const REQUEST_COLUMNS: DataTableColumn<CapabilityGrantRequestRow>[] = [
    { key: 'capability_key', label: t('platformAccess.accessModule.capability'), mono: true, sortable: true, filterable: true },
    {
      key: 'target_user_email',
      label: t('platformAccess.accessModule.targetUser2'),
      sortable: true,
      filterable: true,
      render: (raw, row) => String(raw ?? row.target_user_full_name ?? row.target_user_id ?? t('platformAccess.accessModule.unknownUser')),
    },
    {
      key: 'requested_by_email',
      label: t('platformAccess.accessModule.requestedBy'),
      sortable: true,
      filterable: true,
      render: (raw, row) => String(raw ?? row.requested_by_full_name ?? row.requested_by ?? t('platformAccess.accessModule.unknownRequester')),
    },
    { key: 'scope_type', label: t('platformAccess.accessModule.scope'), sortable: true, filterable: true },
    {
      key: 'status',
      label: t('platformAccess.accessModule.status'),
      sortable: true,
      filterable: true,
      render: (raw) => {
        const status = String(raw ?? 'pending');
        return (
          <Chip
            label={status}
            kind={status === 'approved' ? 'good' : status === 'denied' ? 'danger' : 'warn'}
            size="xs"
          />
        );
      },
    },
    { key: 'created_at', label: t('platformAccess.accessModule.created'), format: 'datetime', sortable: true },
    { key: 'decided_at', label: t('platformAccess.accessModule.decided'), format: 'datetime', sortable: true },
  ];

  return (
    <div className="page">
      <PageHeader
        moduleKey="access"
        eyebrow={t('platformAccess.accessModule.platform')}
        titleAccent={t('platformAccess.accessModule.titleAccent')}
        titlePlain={t('platformAccess.accessModule.titlePlain')}
        pills={[
          tenantId ? <ScopePill scopeType="tenant" scopeId={tenantId} /> : null,
          <span key="cap" className="chip chip--xs mono">{fill(t('platformAccess.accessModule.capabilitiesGranted'), { grantedCount: String(grantedCount), totalCount: String(totalCount) })}</span>,
          <span key="rbac" className="chip chip--xs mono">{roleCountPillLabel}</span>,
          <span key="policy" className="chip chip--xs mono">{policyPillLabel}</span>,
        ].filter(Boolean) as ReactNode[]}
      />

      {/* Tab strip — stable ordering: policy / roles / assignments / templates */}
      <div className="dt-toolbar" data-testid="access-tabs">
        {accessTabs(t).map((entry) => (
          <button
            key={entry.key}
            type="button"
            className={`dt-tb-view-tab ${tab === entry.key ? 'is-active' : ''}`}
            onClick={() => setTab(entry.key)}
            data-testid={`access-tab-${entry.key}`}
          >
            {entry.label}
          </button>
        ))}
        <span className="dt-tb-spacer" />
        {tab === 'policy' ? (
          <div className="dt-tb-search">
            <span>
              <Icon name="search" size={12} />
            </span>
            <input
              type="text"
              placeholder={t('platformAccess.accessModule.filterCapabilitiesResources')}
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              data-testid="access-filter"
            />
          </div>
        ) : null}
        {tab === 'roles' ? (
          <span data-testid="rbac-create-role-btn">
            <Button
              label={t('platformAccess.accessModule.newRole')}
              iconName="plus"
              kind="primary"
              size="sm"
              capability={CAP.ACCESS_POLICY_APPROVE}
              disabled={!tenantId}
              title={tenantMutationBlockedReason ?? undefined}
              onClick={() => openRoleEditor()}
            />
          </span>
        ) : null}
        {tab === 'assignments' ? (
          <span data-testid="rbac-grant-role-btn">
            <Button
              label={t('platformAccess.accessModule.grantRole')}
              iconName="plus"
              kind="primary"
              size="sm"
              capability={CAP.ACCESS_POLICY_APPROVE}
              disabled={!canOpenGrantRole}
              title={grantRoleBlockedReason ?? undefined}
              onClick={() => openGrantRole()}
            />
          </span>
        ) : null}
      </div>

      {/* ------------------------- Tab: Policy ------------------------- */}
      {tab === 'policy' ? (
        <>
          {!accessRead ? (
            <div style={{ padding: '0 16px 16px' }}>
              <StateView
                kind="denied"
                capability={CAP.ACCESS_POLICY_READ}
                hint={t('platformAccess.accessModule.accessPolicyResolutionRequires')}
              />
            </div>
          ) : access.error ? (
            <div style={{ padding: '0 16px 16px' }}>
              <StateView
                kind="error"
                title={t('platformAccess.accessModule.accessPolicyUnavailable')}
                hint={accessQueryErrorHint(
                  access.error,
                  'Could not load the access policy.',
                )}
              />
            </div>
          ) : access.isLoading ? (
            <div style={{ padding: '0 16px 16px' }}>
              <StateView
                kind="loading"
                title={t('platformAccess.accessModule.resolvingAccessPolicy')}
                hint={t('platformAccess.accessModule.loadingTheCurrentAccess')}
              />
            </div>
          ) : !access.data ? (
            <div style={{ padding: '0 16px 16px' }}>
              <StateView
                kind="error"
                title={t('platformAccess.accessModule.accessPolicyUnavailable')}
                hint={t('platformAccess.accessModule.theAccessPolicyResolver')}
              />
            </div>
          ) : (
            <>
          <div className="section-eyebrow">{fill(t('platformAccess.accessModule.currentUserRole'), { name: String(user.name), role: String(user.role) })}</div>
          <div className="section-eyebrow">{t('platformAccess.accessModule.accessResolutionLadder')}</div>
          <div className="ladder" data-testid="access-ladder" style={{ padding: '0 16px 8px' }}>
            {scopePath.map((step, i) => {
              const isMatch = step.scope_type === winningScopeType;
              const stepClasses = ['ladder__step', isMatch ? 'is-match' : 'is-dim']
                .filter(Boolean)
                .join(' ');
              return (
                <div
                  key={`${step.scope_type}-${step.scope_id ?? 'null'}-${i}`}
                  className={stepClasses}
                  data-testid={`access-ladder-step-${step.scope_type}`}
                >
                  <span className="ladder__rank">{String(i + 1)}</span>
                  <span className="ladder__level">{accessScopeLabel(step.scope_type)}</span>
                  <span className="ladder__id">{accessScopeReferenceLabel(step.scope_type, step.scope_id)}</span>
                  <span className="ladder__value">{isMatch ? t('platformAccess.accessModule.resolved') : t('platformAccess.accessModule.inherit')}</span>
                </div>
              );
            })}
          </div>

          <div
            style={{
              padding: '0 16px 16px',
              display: 'grid',
              gridTemplateColumns: 'repeat(auto-fit, minmax(240px, 1fr))',
              gap: '6px',
              overflow: 'auto',
            }}
          >
            {filteredCaps.map((c) => {
              const allowed = wildcardGranted || myCaps.has(c);
              return (
                <div
                  key={c}
                  className="card"
                  style={{
                    padding: '8px 10px',
                    display: 'flex',
                    alignItems: 'center',
                    gap: '8px',
                    flexWrap: 'wrap',
                    borderColor: allowed ? 'var(--accent-soft)' : 'var(--line)',
                    background: allowed ? 'var(--accent-soft)' : 'var(--paper)',
                  }}
                  data-testid={`access-cap-${c}`}
                >
                  <Dot kind={allowed ? 'good' : 'neutral'} />
                  <span className="mono" style={{ fontSize: '11px' }}>
                    {c}
                  </span>
                  <div style={{ flex: 1 }} />
                  {allowed ? (
                    <>
                      {tenantId ? <Chip label={t('platformAccess.accessModule.tenant')} kind="info" size="xs" /> : null}
                      <Chip label={t('platformAccess.accessModule.granted')} kind="good" size="xs" />
                    </>
                  ) : (
                    <Button
                      label={t('platformAccess.accessModule.request')}
                      kind="ghost"
                      size="sm"
                      capability={CAP.ACCESS_POLICY_READ}
                      onClick={() => requestCapability(c)}
                    />
                  )}
                  <CapabilityEvalDrilldown
                    userId={user.id}
                    capabilityKey={c}
                    scopeType={effectiveAccessScopeType}
                    scopeId={effectiveAccessScopeId}
                    testIdPrefix={`access-eval-${c}`}
                  />
                </div>
              );
            })}
          </div>

          <div className="section-eyebrow">{t('platformAccess.accessModule.resourceAccessMatrix')}</div>
          <div style={{ padding: '0 16px 16px', overflow: 'auto' }}>
            <table className="dt__table">
              <thead>
                <tr>
                  <th>{t('platformAccess.accessModule.resource')}</th>
                  <th>{t('platformAccess.accessModule.read')}</th>
                  <th>{t('platformAccess.accessModule.write')}</th>
                  <th>{t('platformAccess.accessModule.scopePolicy')}</th>
                </tr>
              </thead>
              <tbody>
                {filteredResources.map(([key, def]) => {
                  const r = def.read || '';
                  const w = def.write || '';
                  const rOk = r ? wildcardGranted || myCaps.has(r) : false;
                  const wOk = w ? wildcardGranted || myCaps.has(w) : false;
                  return (
                    <tr key={key} data-testid={`access-resource-${key}`}>
                      <td>{accessResourceLabel(key)}</td>
                      <td>
                        <Chip
                          label={r ? formatCapabilityLabel(r, { titleCase: true }, t) : t('platformAccess.accessModule.notAvailable')}
                          kind={rOk ? 'good' : 'warn'}
                          size="xs"
                        />
                      </td>
                      <td>
                        <Chip
                          label={w ? formatCapabilityLabel(w, { titleCase: true }, t) : t('platformAccess.accessModule.notAvailable')}
                          kind={wOk ? 'good' : 'warn'}
                          size="xs"
                        />
                      </td>
                      <td>
                        <Chip label={t('platformAccess.accessModule.enabled')} kind="good" size="xs" />
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
          {accessRequestEvidence ? (
            <div
              className="card"
              data-testid="access-request-evidence"
              style={{
                margin: '8px 16px 16px',
                padding: '10px 12px',
                display: 'grid',
                gap: '8px',
                borderColor: 'var(--good)',
              }}
            >
              <div style={{ display: 'flex', alignItems: 'center', gap: '8px', flexWrap: 'wrap' }}>
                <div className="section-eyebrow" style={{ margin: 0 }}>
                      {t('platformAccess.accessModule.accessRequestConfirmed')}
                </div>
                {accessRequestEvidence.status ? (
                  <Chip label={String(accessRequestEvidence.status)} kind="info" size="xs" />
                ) : null}
                {accessRequestEvidence.idempotent ? (
                  <Chip label={t('platformAccess.accessModule.existingPendingRequest')} kind="neutral" size="xs" />
                ) : null}
              </div>
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: '6px' }}>
                {accessRequestEvidence.capability_key ? (
                  <Chip
                    label={String(accessRequestEvidence.capability_key)}
                    kind="neutral"
                    size="xs"
                    className="mono"
                  />
                ) : null}
                {accessRequestEvidence.scope_type ? (
                  <Chip
                    label={fill(t('platformAccess.accessModule.scope2'), { scope_type: String(accessRequestEvidence.scope_type) })}
                    kind="neutral"
                    size="xs"
                    className="mono"
                  />
                ) : null}
                {accessRequestEvidence.capability_grant_request_id ? (
                  <Chip
                    label={fill(t('platformAccess.accessModule.request2'), { capability_grant_request_id: String(accessRequestEvidence.capability_grant_request_id) })}
                    kind="neutral"
                    size="xs"
                    className="mono"
                  />
                ) : null}
                {accessRequestEvidence.duration_hours ? (
                  <Chip
                    label={fill(t('platformAccess.accessModule.hRequested'), { duration_hours: String(accessRequestEvidence.duration_hours) })}
                    kind="neutral"
                    size="xs"
                    className="mono"
                  />
                ) : null}
                {accessRequestEvidence.correlation_id ? (
                  <Chip
                    label={t('platformAccess.accessModule.referenceRecorded')}
                    kind="info"
                    size="xs"
                    className="mono"
                  />
                ) : null}
              </div>
              {accessRequestEvidence.reason ? (
                <div className="state__hint mono" style={{ margin: 0 }}>
                  {accessRequestEvidence.reason}
                </div>
              ) : null}
            </div>
          ) : null}

            </>
          )}
        </>
      ) : null}

      {/* ------------------------- Tab: Roles ------------------------- */}
      {tab === 'roles' ? (
        <div data-testid="access-roles-pane">
          <div className="section-eyebrow">{t('platformAccess.accessModule.accessRoles')}</div>
          {!accessRead ? (
            <StateView
              kind="denied"
              capability={CAP.ACCESS_POLICY_READ}
              hint={t('platformAccess.accessModule.roleListRequiresAccess')}
            />
          ) : rolesQuery.error ? (
            <StateView
              kind="error"
              title={t('platformAccess.accessModule.accessRolesUnavailable')}
              hint={accessQueryErrorHint(
                rolesQuery.error,
                'Could not load access roles.',
              )}
            />
          ) : rolesQuery.isLoading ? (
            <StateView kind="loading" />
          ) : (
            <DataTable<RbacRoleRow>
              columns={ROLE_COLUMNS}
              rows={rolesQuery.data?.rows ?? []}
              viewKey="rbac_roles"
              entityKind="rbac_roles"
              onRowClick={openRoleDrawer}
              rowActions={[
                {
                  label: t('platformAccess.accessModule.edit'),
                  icon: 'edit',
                  capability: CAP.ACCESS_POLICY_APPROVE,
                  onClick: openRoleEditor,
                },
                {
                  label: t('platformAccess.accessModule.deactivate'),
                  icon: 'close',
                  kind: 'danger',
                  capability: CAP.ACCESS_POLICY_APPROVE,
                  disabled: (role) => !role.is_active,
                  disabledReason: 'Role is already inactive.',
                  onClick: openRoleDelete,
                },
              ]}
            />
          )}
          {!canApprove ? (
            <p className="state__hint" style={{ padding: '0 16px 16px' }}>
              {fill(t('platformAccess.accessModule.roleChangesRequire'), { value: formatCapabilityRequirement(CAP.ACCESS_POLICY_APPROVE, t) })}
            </p>
          ) : null}
        </div>
      ) : null}

      {/* ----------------------- Tab: Assignments ---------------------- */}
      {tab === 'assignments' ? (
        <div data-testid="access-assignments-pane">
          <div className="section-eyebrow">{t('platformAccess.accessModule.userRoleAssignments')}</div>
          {canApprove && grantRoleBlockedReason ? (
            <StateView
              kind={
                usersQuery.error || rolesQuery.error
                  ? 'error'
                  : usersQuery.isLoading || rolesQuery.isLoading
                    ? 'loading'
                    : 'empty'
              }
              title={t('platformAccess.accessModule.grantRoleUnavailable')}
              hint={grantRoleBlockedReason}
            />
          ) : null}
          {!accessRead ? (
            <StateView
              kind="denied"
              capability={CAP.ACCESS_POLICY_READ}
              hint={t('platformAccess.accessModule.assignmentListRequiresAccess')}
            />
          ) : assignmentsQuery.error ? (
            <StateView
              kind="error"
              title={t('platformAccess.accessModule.userRoleAssignmentsUnavailable')}
              hint={accessQueryErrorHint(
                assignmentsQuery.error,
                'Could not load user role assignments.',
              )}
            />
          ) : assignmentsQuery.isLoading ? (
            <StateView kind="loading" />
          ) : (
            <DataTable<RbacUserRoleAssignmentRow>
              columns={ASSIGNMENT_COLUMNS}
              rows={assignmentsQuery.data?.rows ?? []}
              viewKey="rbac_user_role_assignments"
              entityKind="rbac_user_role_assignments"
              rowActions={[
                {
                  label: t('platformAccess.accessModule.revoke'),
                  icon: 'close',
                  kind: 'danger',
                  capability: CAP.ACCESS_POLICY_APPROVE,
                  disabled: (assignment) => Boolean(assignment.revoked_at),
                  disabledReason: 'Assignment is already revoked.',
                  onClick: openRevokeAssignment,
                },
              ]}
            />
          )}
          {assignmentMutationEvidence ? (
            <div
              className="card"
              data-testid="rbac-assignment-mutation-evidence"
              style={{
                margin: '8px 16px 0',
                padding: '10px 12px',
                display: 'grid',
                gap: '8px',
                borderColor: 'var(--good)',
              }}
            >
              <div style={{ display: 'flex', alignItems: 'center', gap: '8px', flexWrap: 'wrap' }}>
                <div className="section-eyebrow" style={{ margin: 0 }}>
                  {t('platformAccess.accessModule.assignmentConfirmed')}
                </div>
                <Chip label={assignmentMutationEvidence.action} kind="info" size="xs" />
                <Chip
                  label={assignmentMutationEvidence.status}
                  kind={assignmentMutationEvidence.status === 'active' ? 'good' : 'warn'}
                  size="xs"
                />
              </div>
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: '6px' }}>
                <Chip
                  label={fill(t('platformAccess.accessModule.user2'), { userLabel: String(assignmentMutationEvidence.userLabel) })}
                  kind="neutral"
                  size="xs"
                  className="mono"
                />
                <Chip
                  label={fill(t('platformAccess.accessModule.role2'), { roleLabel: String(assignmentMutationEvidence.roleLabel) })}
                  kind="neutral"
                  size="xs"
                  className="mono"
                />
                {assignmentMutationEvidence.assignmentId ? (
                  <Chip
                    label={fill(t('platformAccess.accessModule.assignment'), { assignmentId: String(assignmentMutationEvidence.assignmentId) })}
                    kind="neutral"
                    size="xs"
                    className="mono"
                  />
                ) : null}
                {assignmentMutationEvidence.correlationId ? (
                  <Chip
                    label={t('platformAccess.accessModule.referenceRecorded')}
                    kind="info"
                    size="xs"
                    className="mono"
                  />
                ) : null}
              </div>
              {assignmentMutationEvidence.reason ? (
                <div className="state__hint mono" style={{ margin: 0 }}>
                  {assignmentMutationEvidence.reason}
                </div>
              ) : null}
            </div>
          ) : null}
          {!canApprove ? (
            <p className="state__hint" style={{ padding: '0 16px 16px' }}>
              {t('platformAccess.accessModule.grantRevokeRequire')} <code className="mono">{t('platformAccess.accessModule.accessPolicyApprove')}</code>.
            </p>
          ) : null}
        </div>
      ) : null}

      {/* ------------------------ Tab: Templates ----------------------- */}
      {tab === 'templates' ? (
        <div data-testid="access-templates-pane">
          <div className="section-eyebrow">{t('platformAccess.accessModule.globalRoleTemplates')}</div>
          {!accessRead ? (
            <StateView
              kind="denied"
              capability={CAP.ACCESS_POLICY_READ}
              hint={t('platformAccess.accessModule.templateListRequiresAccess')}
            />
          ) : templatesQuery.error ? (
            <StateView
              kind="error"
              title={t('platformAccess.accessModule.roleTemplatesUnavailable')}
              hint={accessQueryErrorHint(
                templatesQuery.error,
                'Could not load role templates.',
              )}
            />
          ) : templatesQuery.isLoading ? (
            <StateView kind="loading" />
          ) : (
            <>
              <DataTable<RbacRoleTemplateRow>
                columns={TEMPLATE_COLUMNS}
                rows={templatesQuery.data?.rows ?? []}
                viewKey="rbac_role_templates"
                entityKind="rbac_role_templates"
                onRowClick={openTemplateDrawer}
                rowActions={[
                  {
                    label: t('platformAccess.accessModule.apply'),
                    icon: 'check',
                    kind: 'primary',
                    capability: CAP.ACCESS_POLICY_APPROVE,
                    disabled: () => !tenantId,
                    disabledReason: tenantMutationBlockedReason ?? undefined,
                    onClick: openApplyTemplate,
                  },
                ]}
              />
              {templateApplyEvidence ? (
                <div
                  className="card"
                  data-testid="rbac-template-apply-evidence"
                  style={{
                    margin: '8px 16px 0',
                    padding: '10px 12px',
                    display: 'grid',
                    gap: '8px',
                    borderColor: 'var(--good)',
                  }}
                >
                  <div style={{ display: 'flex', alignItems: 'center', gap: '8px', flexWrap: 'wrap' }}>
                    <div className="section-eyebrow" style={{ margin: 0 }}>
                      {t('platformAccess.accessModule.templateApplicationConfirmed')}
                    </div>
                    {templateApplyEvidence.organization_id ? (
                      <Chip label={t('platformAccess.accessModule.organizationRecorded')} kind="neutral" size="xs" />
                    ) : null}
                    {templateApplyEvidence.correlation_id ? (
                      <Chip
                        label={t('platformAccess.accessModule.referenceRecorded')}
                        kind="info"
                        size="xs"
                        className="mono"
                      />
                    ) : null}
                  </div>
                  {templateApplyRoles.length > 0 ? (
                    <ul style={{ listStyle: 'none', padding: 0, margin: 0, display: 'grid', gap: '4px' }}>
                      {templateApplyRoles.map((role, index) => (
                        <li
                          key={`${role.template_key ?? 'template'}-${role.role_id ?? index}`}
                          style={{ display: 'flex', alignItems: 'center', gap: '8px', flexWrap: 'wrap' }}
                        >
                          <Dot kind={role.created ? 'good' : 'info'} />
                          <code className="mono" style={{ fontSize: '11px' }}>
                            {role.template_key ?? t('platformAccess.accessModule.template')}
                          </code>
                          <span className="mono" style={{ fontSize: '11px', color: 'var(--mute)' }}>
                            {role.role_id ?? t('platformAccess.accessModule.rolePending')}
                          </span>
                          <Chip
                            label={role.created ? t('platformAccess.accessModule.created2') : t('platformAccess.accessModule.existingRoleRefreshed')}
                            kind={role.created ? 'good' : 'neutral'}
                            size="xs"
                          />
                        </li>
                      ))}
                    </ul>
                  ) : (
                    <p className="state__hint" style={{ margin: 0 }}>
                      {t('platformAccess.accessModule.savedTemplateRequestConfirmed')}
                    </p>
                  )}
                </div>
              ) : null}
              {/* Inline Apply button per-template for direct (a11y/visual)
                  access without the row-actions palette. */}
              <div
                style={{ padding: '8px 16px 0', display: 'flex', flexWrap: 'wrap', gap: '6px' }}
                data-testid="rbac-template-apply-list"
              >
                {(templatesQuery.data?.rows ?? []).map((tpl) => (
                  <span key={tpl.id} data-testid={`rbac-template-apply-${tpl.key}`}>
                    <Button
                      label={fill(t('platformAccess.accessModule.apply2'), { key: String(tpl.key) })}
                      kind="ghost"
                      size="sm"
                      capability={CAP.ACCESS_POLICY_APPROVE}
                      onClick={() => openApplyTemplate(tpl)}
                    />
                  </span>
                ))}
              </div>
            </>
          )}
          {!canApprove ? (
            <p className="state__hint" style={{ padding: '0 16px 16px' }}>
              {t('platformAccess.accessModule.applyTemplateRequires')} <code className="mono">{t('platformAccess.accessModule.accessPolicyApprove')}</code>.
            </p>
          ) : null}
        </div>
      ) : null}

      {/* ------------------------ Tab: Requests ----------------------- */}
      {tab === 'requests' ? (
        <div data-testid="access-requests-pane">
          <div className="section-eyebrow">{t('platformAccess.accessModule.accessRequests')}</div>
          {!accessRead ? (
            <StateView
              kind="denied"
              capability={CAP.ACCESS_POLICY_READ}
              hint={t('platformAccess.accessModule.accessRequestReviewRequires')}
            />
          ) : grantRequestsQuery.error ? (
            <StateView
              kind="error"
              title={t('platformAccess.accessModule.accessRequestsUnavailable')}
              hint={accessQueryErrorHint(
                grantRequestsQuery.error,
                'Could not load access requests.',
              )}
            />
          ) : grantRequestsQuery.isLoading ? (
            <StateView kind="loading" />
          ) : (grantRequestsQuery.data?.rows ?? []).length === 0 ? (
            <StateView
              kind="empty"
              title={t('platformAccess.accessModule.noAccessRequests')}
              hint={t('platformAccess.accessModule.submittedCapabilityRequestsWill')}
            />
          ) : (
            <DataTable<CapabilityGrantRequestRow>
              columns={REQUEST_COLUMNS}
              rows={grantRequestsQuery.data?.rows ?? []}
              viewKey="capability_grant_requests"
              entityKind="capability_grant_requests"
              rowActions={[
                {
                  label: t('platformAccess.accessModule.approve'),
                  icon: 'check',
                  kind: 'primary',
                  capability: CAP.ACCESS_POLICY_APPROVE,
                  disabled: (request) => request.status !== 'pending',
                  disabledReason: 'Request is already reviewed.',
                  onClick: (request) => openReviewAccessRequest(request, 'approved'),
                },
                {
                  label: t('platformAccess.accessModule.deny'),
                  icon: 'close',
                  kind: 'danger',
                  capability: CAP.ACCESS_POLICY_APPROVE,
                  disabled: (request) => request.status !== 'pending',
                  disabledReason: 'Request is already reviewed.',
                  onClick: (request) => openReviewAccessRequest(request, 'denied'),
                },
              ]}
            />
          )}
          {accessRequestReviewEvidence ? (
            <div
              className="card"
              data-testid="access-request-review-evidence"
              style={{
                margin: '8px 16px 0',
                padding: '10px 12px',
                display: 'grid',
                gap: '8px',
                borderColor: 'var(--good)',
              }}
            >
              <div style={{ display: 'flex', alignItems: 'center', gap: '8px', flexWrap: 'wrap' }}>
                <div className="section-eyebrow" style={{ margin: 0 }}>
                  {t('platformAccess.accessModule.accessRequestReviewConfirmed')}
                </div>
                {accessRequestReviewEvidence.status ? (
                  <Chip
                    label={String(accessRequestReviewEvidence.status)}
                    kind={accessRequestReviewEvidence.status === 'approved' ? 'good' : 'warn'}
                    size="xs"
                  />
                ) : null}
              </div>
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: '6px' }}>
                {accessRequestReviewEvidence.capability_key ? (
                  <Chip
                    label={String(accessRequestReviewEvidence.capability_key)}
                    kind="neutral"
                    size="xs"
                    className="mono"
                  />
                ) : null}
                {accessRequestReviewEvidence.capability_grant_request_id ? (
                  <Chip
                    label={fill(t('platformAccess.accessModule.request2'), { capability_grant_request_id: String(accessRequestReviewEvidence.capability_grant_request_id) })}
                    kind="neutral"
                    size="xs"
                    className="mono"
                  />
                ) : null}
                {accessRequestReviewEvidence.rbac_role_id ? (
                  <Chip
                    label={fill(t('platformAccess.accessModule.role3'), { rbac_role_id: String(accessRequestReviewEvidence.rbac_role_id) })}
                    kind="neutral"
                    size="xs"
                    className="mono"
                  />
                ) : null}
                {accessRequestReviewEvidence.rbac_user_role_assignment_id ? (
                  <Chip
                    label={fill(t('platformAccess.accessModule.assignment2'), { rbac_user_role_assignment_id: String(accessRequestReviewEvidence.rbac_user_role_assignment_id) })}
                    kind="neutral"
                    size="xs"
                    className="mono"
                  />
                ) : null}
                {accessRequestReviewEvidence.correlation_id ? (
                  <Chip
                    label={t('platformAccess.accessModule.referenceRecorded')}
                    kind="info"
                    size="xs"
                    className="mono"
                  />
                ) : null}
              </div>
              {accessRequestReviewEvidence.decision_notes ? (
                <div className="state__hint mono" style={{ margin: 0 }}>
                  {accessRequestReviewEvidence.decision_notes}
                </div>
              ) : null}
            </div>
          ) : null}
          {!canApprove ? (
            <p className="state__hint" style={{ padding: '0 16px 16px' }}>
              {t('platformAccess.accessModule.approveDenyRequire')} <code className="mono">{t('platformAccess.accessModule.accessPolicyApprove')}</code>.
            </p>
          ) : null}
        </div>
      ) : null}

      {modal.node}
      {drawer.node}
    </div>
  );
}
