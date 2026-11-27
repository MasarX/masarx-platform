// access.arabic.test.tsx: the access page renders its own copy in Arabic (issue #302).
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { renderWithProviders } from '@/test/render';
import { findUntranslated } from '@/test/helpers/untranslated';
import { AccessModule } from '@/modules/platform/access';
import { englishT, fill } from '@/lib/i18n';
import * as api from '@/lib/api';
import * as queries from '@/lib/queries';
import * as toastStore from '@/components/toastStore';
import type { AccessPolicyResolution } from '@/lib/queries';
import ar from '@/lib/seed-raw/i18n/areas/ar/platform-access';
import en from '@/lib/seed-raw/i18n/areas/en/platform-access';
import arShell from '@/lib/seed-raw/i18n/areas/ar/shell';

const AR = ar.platformAccess.accessModule;
// Copy moved into the catalog: each Arabic sentence is Latin-free and keeps the English placeholders.
const MOVED_KEYS = [
  'couldNotLoadUsersForRoleGrants', 'couldNotLoadRolesForRoleGrants', 'selectTenantBeforeGranting',
  'loadingUsersAndRolesForGrants', 'noUsersToGrantInScope', 'noActiveRolesToGrantInScope', 'selectTenantBeforeChanging',
  'accessRequestApproved', 'accessRequestDenied', 'selectedUser', 'assignmentIsAlreadyRevoked',
  'roleIsAlreadyInactive', 'requestIsAlreadyReviewed', 'couldNotLoadAccessPolicy', 'couldNotLoadAccessRoles',
  'couldNotLoadAssignments', 'couldNotLoadRoleTemplates', 'couldNotLoadAccessRequests', 'resourceFallback',
  'globalDefault', 'scopeReference', 'policyDenied', 'policyUnavailable', 'policyLoading', 'policyEnforced',
  'rolesUnavailable', 'roleCount',
] as const;

function lookup(catalog: unknown, path: string): unknown {
  return path.split('.').reduce<unknown>((node, part) => (node as Record<string, unknown> | undefined)?.[part], catalog);
}

function placeholders(text: string): string[] {
  return [...text.matchAll(/\{(\w+)\}/g)].map((match) => match[1]!).sort();
}

function resolution(): AccessPolicyResolution {
  return {
    policy: {
      capabilities: [{ key: 'shipments.write', label: 'Shipments write' }],
      roles: [],
      assignments: { user_type: {} },
      resource_map: { shipments: { write: 'shipments.write' } },
      denies: [],
    },
    settings_id: 'set_test_demo',
    settings_version_id: 'sv_test_demo',
    scope_type: 'tenant',
    scope_id: 'org_rashed',
    scope_path: [{ scope_type: 'tenant', scope_id: 'org_rashed' }],
    settings_resolution_id: 'srlv_test_1234',
  } as AccessPolicyResolution;
}

function renderTenantAccessInArabic() {
  vi.spyOn(queries, 'useResolveAccessPolicy').mockReturnValue({
    data: resolution(),
    isLoading: false,
    isSuccess: true,
    isError: false,
  } as unknown as ReturnType<typeof queries.useResolveAccessPolicy>);
  return renderWithProviders(<AccessModule />, {
    locale: 'ar',
    identity: {
      capabilities: ['access_policy.read', 'access_policy.approve'],
      user: { access_scope_type: 'platform', organization_id: 'org_platform' },
      scope: { tenant: { id: 'org_rashed', label: 'Rashed Logistics', rank: 2 } },
    },
  });
}

const request = {
  id: 'cgr_review_ar',
  organization_id: 'org_rashed',
  requested_by_email: 'requester@example.test',
  target_user_email: 'requester@example.test',
  capability_key: 'shipments.write',
  scope_type: 'tenant',
  scope_id: 'org_rashed',
  reason: 'synthetic',
  status: 'pending',
  created_at: '2026-05-27T10:00:00.000Z',
};

function mockRequests(rows: () => Array<Record<string, unknown>>) {
  const actualList = api.ui_list_resource_complete;
  vi.spyOn(api, 'ui_list_resource_complete').mockImplementation(async (key, opts) => {
    const result = await actualList(key, opts);
    if (key !== 'capability_grant_requests') return result;
    const list = rows();
    return { ...result, rows: list, total: list.length, count: list.length, page: 0, page_size: list.length };
  });
}

async function openApproveOption(user: ReturnType<typeof userEvent.setup>) {
  await user.click(await screen.findByTestId('access-tab-requests'));
  const pane = await screen.findByTestId('access-requests-pane');
  expect(await within(pane).findByText(/shipments\.write/)).toBeInTheDocument();
  const [actions] = within(pane)
    .getAllByLabelText(arShell.shell.table.rowActions)
    .filter((node) => node.tagName === 'BUTTON');
  await user.click(actions!);
  return screen.findByRole('option', { name: new RegExp(`^${AR.approve}`) });
}

describe('AccessModule in Arabic', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    window.history.pushState(null, '', '/platform/access');
  });

  it('renders the page copy in Arabic', async () => {
    renderWithProviders(<AccessModule />, { locale: 'ar', capabilities: ['access_policy.read'] });

    const [title] = await screen.findAllByText(ar.platformAccess.accessModule.titleAccent);
    expect(findUntranslated(title)).toEqual([]);
    const [copy] = await screen.findAllByText(ar.platformAccess.accessModule.assignments);
    expect(findUntranslated(copy)).toEqual([]);
  });

  it('shows the denied state in Arabic', async () => {
    renderWithProviders(<AccessModule />, { locale: 'ar', capabilities: [] });
    expect(await screen.findByText(ar.platformAccess.accessModule.accessPolicyResolutionRequires)).toBeInTheDocument();
  });

  it('keeps the English copy and reads Arabic from the catalog', () => {
    expect(englishT('platformAccess.accessModule.titlePlain')).toBe('control');
    expect(englishT('platformAccess.accessModule.grantRevokeRequire')).toBe('Grant / Revoke require');
    expect(lookup(ar, 'platformAccess.accessModule.titleAccent')).toMatch(/[؀-ۿ]/);
  });

  it('explains a blocked role grant in Arabic', async () => {
    const actualList = api.ui_list_resource_complete;
    vi.spyOn(api, 'ui_list_resource_complete').mockImplementation(async (key, opts) => {
      const result = await actualList(key, opts);
      return key === 'users' ? { ...result, rows: [], count: 0, total: 0 } : result;
    });
    const user = userEvent.setup();
    renderTenantAccessInArabic();
    await user.click(await screen.findByTestId('access-tab-assignments'));
    const pane = await screen.findByTestId('access-assignments-pane');
    const reason = await within(pane).findByText(AR.noUsersToGrantInScope);
    expect(findUntranslated(reason)).toEqual([]);
  });

  it('gives the already-reviewed reason in Arabic on a terminal request', async () => {
    mockRequests(() => [{ ...request, status: 'approved', decided_at: '2026-05-27T10:05:00.000Z' }]);
    const user = userEvent.setup();
    renderTenantAccessInArabic();
    const approve = await openApproveOption(user);
    expect(approve).toHaveClass('is-disabled');
    expect(approve).toHaveTextContent(AR.requestIsAlreadyReviewed);
    expect(findUntranslated(approve)).toEqual([]);
  });

  it('confirms an approved access request with a whole Arabic sentence', async () => {
    let reviewed = false;
    mockRequests(() => [reviewed ? { ...request, status: 'approved', decided_at: '2026-05-27T10:05:00.000Z' } : request]);
    vi.spyOn(api, 'ui_review_capability_grant_request_v1').mockImplementation(async () => {
      reviewed = true;
      return {
        ok: true,
        capability_grant_request_id: 'cgr_review_ar',
        status: 'approved',
        decision: 'approved',
        correlation_id: 'corr_review_ar',
        decision_log_id: 'decision_review_ar',
        rbac_role_id: 'rol_review_ar',
        rbac_role_permission_id: 'rperm_review_ar',
        rbac_user_role_assignment_id: 'ura_review_ar',
        request_readback: { ...request, status: 'approved' },
      } as unknown as Awaited<ReturnType<typeof api.ui_review_capability_grant_request_v1>>;
    });
    const toastSpy = vi.spyOn(toastStore, 'pushToast');
    const user = userEvent.setup();
    renderTenantAccessInArabic();
    await user.click(await openApproveOption(user));
    await screen.findByTestId('access-request-review-body');
    await user.click(screen.getByRole('button', { name: AR.approve }));

    const expected = fill(AR.accessRequestApproved, { capability_key: 'shipments.write' });
    await waitFor(() => expect(toastSpy).toHaveBeenCalledWith(expected, 'good'));
    expect(expected.replace('shipments.write', '')).not.toMatch(/[A-Za-z]{2,}/);
  });

  it('keeps every moved sentence Arabic, Latin-free and placeholder-aligned with English', () => {
    for (const key of MOVED_KEYS) {
      const arabic = AR[key];
      expect(arabic, key).toMatch(/[؀-ۿ]/);
      expect(arabic.replace(/\{\w+\}/g, ''), key).not.toMatch(/[A-Za-z]{2,}/);
      expect(placeholders(arabic), key).toEqual(placeholders(en.platformAccess.accessModule[key]));
    }
    expect(englishT('platformAccess.accessModule.policyEnforced')).toBe('Policy enforced');
    expect(englishT('platformAccess.accessModule.selectTenantBeforeChanging')).toBe('Select a tenant before changing tenant RBAC roles.');
    expect(englishT('platformAccess.accessModule.accessRequestDenied')).toBe('Access request denied - {capability_key}');
  });
});
