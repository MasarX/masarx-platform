// access.test.tsx — verifies capability cards render with grant state, the
// search filter narrows results, and the capability catalog originates from
// the canonical override-ladder resolver `resolve_access_control_policy_v1`
// (NOT the FE seed). The resolver is mocked so each test pins a deterministic
// AccessPolicyResolution payload and asserts both:
//
//   - positive case: a capability present in the resolved policy renders a
//     card and (when held by the user) shows the "granted" chip.
//   - negative case: a capability present in the resolved policy but NOT
//     held by the user renders a "Request" button instead.
//
// And critically:
//   - a capability that exists in the FE seed but NOT in the resolved policy
//     is absent from the matrix — proving the surface reads from the
//     resolver, not from the static seed.

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { screen, fireEvent, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { renderWithProviders } from '@/test/render';
import { AccessModule } from '@/modules/platform/access';
import * as queries from '@/lib/queries';
import * as api from '@/lib/api';
import * as toastStore from '@/components/toastStore';
import type { AccessPolicyResolution } from '@/lib/queries';

// Build a deterministic resolver payload mirroring the canonical
// `resolve_access_control_policy_v1` SQL contract:
//   (policy JSONB, settings_id UUID, settings_version_id UUID,
//    scope_type TEXT, scope_id UUID, scope_path JSONB,
//    settings_resolution_id UUID)
function makeResolution(overrides: Partial<AccessPolicyResolution> = {}): AccessPolicyResolution {
  return {
    policy: {
      capabilities: [
        { key: 'shipments.read', label: 'Shipments read' },
        { key: 'shipments.write', label: 'Shipments write' },
        { key: 'access_policy.read', label: 'Access policy read' },
        { key: 'audit_log.read', label: 'Audit log read' },
      ],
      roles: [],
      assignments: { user_type: {} },
      resource_map: {
        shipments: { read: 'shipments.read', write: 'shipments.write' },
        audit_log: { read: 'audit_log.read' },
      },
      denies: [],
    },
    settings_id: 'set_test_demo',
    settings_version_id: 'sv_test_demo',
    scope_type: 'tenant',
    scope_id: 'org_rashed',
    scope_path: [
      { scope_type: 'tenant', scope_id: 'org_rashed' },
      { scope_type: 'global', scope_id: null },
    ],
    settings_resolution_id: 'srlv_test_1234',
    ...overrides,
  };
}

function mockResolver(resolution: AccessPolicyResolution) {
  // Wrap the hook return so the module sees an immediate resolved payload.
  // Cast through the structural shape the module reads (`access.data`).
  return vi.spyOn(queries, 'useResolveAccessPolicy').mockReturnValue({
    data: resolution,
    isLoading: false,
    isSuccess: true,
    isError: false,
  } as unknown as ReturnType<typeof queries.useResolveAccessPolicy>);
}

function mockResolverError(message: string) {
  vi.spyOn(queries, 'useResolveAccessPolicy').mockReturnValue({
    data: undefined,
    isLoading: false,
    isSuccess: false,
    isError: true,
    error: new Error(message),
  } as unknown as ReturnType<typeof queries.useResolveAccessPolicy>);
}

function failResourceList(resource: string, message: string) {
  const actualList = api.ui_list_resource_v1;
  const actualCompleteList = api.ui_list_resource_complete;
  const calls = vi.fn();
  vi.spyOn(api, 'ui_list_resource_v1').mockImplementation((key, opts) => {
    calls(key, opts);
    if (key === resource) {
      return Promise.reject(new Error(message));
    }
    return actualList(key, opts);
  });
  vi.spyOn(api, 'ui_list_resource_complete').mockImplementation((key, opts) => {
    calls(key, opts);
    if (key === resource) {
      return Promise.reject(new Error(message));
    }
    return actualCompleteList(key, opts);
  });
  return calls;
}

function renderWithTenantAccess(capabilities = ['access_policy.read', 'access_policy.approve']) {
  return renderWithProviders(<AccessModule />, {
    identity: {
      capabilities,
      user: { access_scope_type: 'platform', organization_id: 'org_platform' },
      scope: {
        tenant: { id: 'org_rashed', label: 'Rashed Logistics', rank: 2 },
      },
    },
  });
}

describe('AccessModule', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    window.history.pushState(null, '', '/platform/access');
  });

  // -------------------------------------------------------------------------
  // SSOT invariant — capability list flows from resolver, not from FE seed.
  // -------------------------------------------------------------------------

  it('renders capability cards from the resolver-resolved policy', async () => {
    mockResolver(makeResolution());
    renderWithProviders(<AccessModule />, { capabilities: ['access_policy.read', 'shipments.read'] });
    expect(await screen.findByTestId('access-cap-shipments.read')).toBeInTheDocument();
    expect(await screen.findByTestId('access-cap-shipments.write')).toBeInTheDocument();
  });

  it('fails closed when the operator cannot read the access policy resolver', async () => {
    const resolverSpy = vi.spyOn(api, 'resolve_access_control_policy_v1');
    const listSpy = vi.spyOn(api, 'ui_list_resource_v1');
    const completeListSpy = vi.spyOn(api, 'ui_list_resource_complete');
    const settingsSpy = vi.spyOn(api, 'resolveSettings');
    renderWithProviders(<AccessModule />, { capabilities: [] });
    expect(await screen.findByText(/Access policy resolution requires access policy permission/i)).toBeInTheDocument();
    expect(screen.queryByTestId('access-cap-shipments.read')).toBeNull();
    expect(screen.queryByTestId('access-ladder')).toBeNull();
    expect(screen.queryByText('Policy enforced')).toBeNull();
    await waitFor(() => {
      expect(resolverSpy).not.toHaveBeenCalled();
      const completeResources = completeListSpy.mock.calls.map(([resource]) => resource);
      expect(completeResources).not.toContain('rbac_roles');
      expect(completeResources).not.toContain('rbac_role_permissions');
      expect(completeResources).not.toContain('rbac_user_role_assignments');
      expect(completeResources).not.toContain('users');
      expect(completeResources).not.toContain('rbac_role_summary');
      expect(completeResources).not.toContain('capability_grant_requests');

      const listResources = listSpy.mock.calls.map(([resource]) => resource);
      expect(listResources).not.toContain('rbac_role_templates');
      expect(listResources).not.toContain('scope_type_registry');

      const settingsCategories = settingsSpy.mock.calls.map(([category]) => category);
      expect(settingsCategories).not.toContain('capability_grant_policy');
    });
    listSpy.mockRestore();
    completeListSpy.mockRestore();
    settingsSpy.mockRestore();
    resolverSpy.mockRestore();
  });

  it('surfaces resolver failures instead of treating missing policy data as success', async () => {
    mockResolverError('resolver unavailable');
    renderWithProviders(<AccessModule />, { capabilities: ['access_policy.read'] });
    expect(await screen.findByText(/Access policy unavailable/i)).toBeInTheDocument();
    expect(screen.getByText(/resolver unavailable/i)).toBeInTheDocument();
    expect(screen.queryByTestId('access-cap-shipments.read')).toBeNull();
    expect(screen.queryByTestId('access-ladder')).toBeNull();
    expect(screen.queryByText('Policy enforced')).toBeNull();
  });

  it('only renders capabilities present in the resolver — not those only in the FE seed', async () => {
    // Resolver returns a constrained catalog (3 entries). The FE seed has
    // many more capabilities (e.g. `routes.read`); a seed-driven implementation
    // would still render those — we assert they are absent.
    mockResolver(
      makeResolution({
        policy: {
          capabilities: [
            { key: 'shipments.read' },
            { key: 'access_policy.read' },
            { key: 'audit_log.read' },
          ],
          resource_map: {},
        },
      }),
    );
    renderWithProviders(<AccessModule />, { capabilities: ['access_policy.read', 'shipments.read'] });
    expect(await screen.findByTestId('access-cap-shipments.read')).toBeInTheDocument();
    // `routes.read` is in the FE seed registry but excluded from the
    // resolver payload above — should NOT appear.
    expect(screen.queryByTestId('access-cap-routes.read')).toBeNull();
    // Likewise `shipments.write` is omitted — should NOT appear.
    expect(screen.queryByTestId('access-cap-shipments.write')).toBeNull();
  });

  it('renders the resource × capability matrix from policy.resource_map (resolver-driven)', async () => {
    mockResolver(makeResolution());
    renderWithProviders(<AccessModule />, { capabilities: ['access_policy.read', 'shipments.read'] });
    expect(await screen.findByTestId('access-resource-shipments')).toBeInTheDocument();
    expect(await screen.findByTestId('access-resource-audit_log')).toBeInTheDocument();
    expect(screen.getByText('Scope policy')).toBeInTheDocument();
    expect(screen.queryByText('RLS')).not.toBeInTheDocument();
  });

  it('exposes the override-ladder scope_path so operators can see how the policy resolved', async () => {
    mockResolver(makeResolution());
    renderWithProviders(<AccessModule />, { capabilities: ['access_policy.read', 'shipments.read'] });
    // Both ladder steps from the mocked resolution should be visible.
    const tenantStep = await screen.findByTestId('access-ladder-step-tenant');
    const globalStep = await screen.findByTestId('access-ladder-step-global');
    expect(tenantStep).toBeInTheDocument();
    expect(globalStep).toBeInTheDocument();
    expect(tenantStep).toHaveTextContent(/Tenant scope/i);
    expect(globalStep).toHaveTextContent(/Global default/i);
    expect(tenantStep).not.toHaveTextContent(/org_rashed/i);
  });

  it('honors tenant scope_id from organization drawer handoff for policy and RBAC reads', async () => {
    window.history.pushState(
      null,
      '',
      '/platform/access?scope_type=tenant&scope_id=org_tabuk_logistics',
    );
    const resolverSpy = mockResolver(
      makeResolution({
        scope_id: 'org_tabuk_logistics',
        scope_path: [
          { scope_type: 'tenant', scope_id: 'org_tabuk_logistics' },
          { scope_type: 'global', scope_id: null },
        ],
      }),
    );
    const listSpy = vi.spyOn(api, 'ui_list_resource_complete');

    renderWithProviders(<AccessModule />, {
      capabilities: ['access_policy.read', 'access_policy.approve'],
      identity: {
        capabilities: ['access_policy.read', 'access_policy.approve'],
        user: { access_scope_type: 'platform', organization_id: 'org_platform' },
        scope: {
          tenant: { id: 'org_rashed', label: 'Rashed Logistics', rank: 2 },
        },
      },
    });

    expect(await screen.findByTestId('access-cap-shipments.read')).toBeInTheDocument();
    expect(resolverSpy).toHaveBeenCalledWith('tenant', 'org_tabuk_logistics', { enabled: true });
    await waitFor(() => {
      expect(listSpy).toHaveBeenCalledWith('rbac_roles', {
        filter: { organization_id: 'org_tabuk_logistics' },
      });
      expect(listSpy).toHaveBeenCalledWith('rbac_role_permissions', {
        filter: { organization_id: 'org_tabuk_logistics' },
      });
      expect(listSpy).toHaveBeenCalledWith('rbac_user_role_assignments', {
        filter: { organization_id: 'org_tabuk_logistics' },
      });
      expect(listSpy).toHaveBeenCalledWith('users', {
        filter: { organization_id: 'org_tabuk_logistics' },
      });
      expect(listSpy).toHaveBeenCalledWith('rbac_role_summary', {
        filter: { organization_id: 'org_tabuk_logistics' },
      });
    });
  });

  it('ignores tenant scope_id route override for tenant-scoped operators', async () => {
    window.history.pushState(
      null,
      '',
      '/platform/access?scope_type=tenant&scope_id=org_external_spoof',
    );
    const resolverSpy = mockResolver(makeResolution());
    const listSpy = vi.spyOn(api, 'ui_list_resource_complete');

    renderWithProviders(<AccessModule />, {
      capabilities: ['access_policy.read', 'access_policy.approve'],
      identity: {
        capabilities: ['access_policy.read', 'access_policy.approve'],
        user: {
          access_scope_type: 'tenant',
          access_scope_id: null,
          organization_id: 'org_rashed',
        },
        scope: {
          tenant: { id: 'org_rashed', label: 'Rashed Logistics', rank: 2 },
        },
      },
    });

    expect(await screen.findByTestId('access-cap-shipments.read')).toBeInTheDocument();
    expect(resolverSpy).toHaveBeenCalledWith('tenant', 'org_rashed', { enabled: true });
    expect(resolverSpy).not.toHaveBeenCalledWith('tenant', 'org_external_spoof', { enabled: true });
    await waitFor(() => {
      expect(listSpy).toHaveBeenCalledWith('rbac_roles', {
        filter: { organization_id: 'org_rashed' },
      });
      expect(listSpy).toHaveBeenCalledWith('rbac_role_permissions', {
        filter: { organization_id: 'org_rashed' },
      });
      expect(listSpy).toHaveBeenCalledWith('rbac_user_role_assignments', {
        filter: { organization_id: 'org_rashed' },
      });
      expect(listSpy).toHaveBeenCalledWith('users', {
        filter: { organization_id: 'org_rashed' },
      });
      expect(listSpy).toHaveBeenCalledWith('rbac_role_summary', {
        filter: { organization_id: 'org_rashed' },
      });
    });
    expect(listSpy).not.toHaveBeenCalledWith('rbac_roles', {
      filter: { organization_id: 'org_external_spoof' },
    });
    expect(listSpy).not.toHaveBeenCalledWith('users', {
      filter: { organization_id: 'org_external_spoof' },
    });
  });

  it('uses the active shell tenant for RBAC reads when no route scope override is present', async () => {
    mockResolver(makeResolution());
    const listSpy = vi.spyOn(api, 'ui_list_resource_complete');

    renderWithTenantAccess();

    expect(await screen.findByTestId('access-cap-shipments.read')).toBeInTheDocument();
    await waitFor(() => {
      expect(listSpy).toHaveBeenCalledWith('rbac_roles', {
        filter: { organization_id: 'org_rashed' },
      });
      expect(listSpy).toHaveBeenCalledWith('rbac_role_permissions', {
        filter: { organization_id: 'org_rashed' },
      });
      expect(listSpy).toHaveBeenCalledWith('rbac_user_role_assignments', {
        filter: { organization_id: 'org_rashed' },
      });
      expect(listSpy).toHaveBeenCalledWith('users', {
        filter: { organization_id: 'org_rashed' },
      });
      expect(listSpy).toHaveBeenCalledWith('rbac_role_summary', {
        filter: { organization_id: 'org_rashed' },
      });
    });
  });

  // -------------------------------------------------------------------------
  // Capability grant state — positive + negative cases.
  // -------------------------------------------------------------------------

  it('positive case: a capability held by the user shows the "granted" chip', async () => {
    mockResolver(makeResolution());
    renderWithProviders(<AccessModule />, { capabilities: ['access_policy.read', 'shipments.read'] });
    const card = await screen.findByTestId('access-cap-shipments.read');
    expect(card.textContent).toMatch(/granted/i);
  });

  it('negative case: a capability NOT held by the user shows a "Request" button', async () => {
    mockResolver(makeResolution());
    renderWithProviders(<AccessModule />, { capabilities: ['access_policy.read'] });
    // shipments.write is in the resolver catalog but NOT in the user's
    // capability set — should render a Request button.
    const card = await screen.findByTestId('access-cap-shipments.write');
    expect(card.textContent).toMatch(/Request/i);
    // Sanity: the "granted" chip must NOT appear on a denied capability.
    expect(card.textContent).not.toMatch(/granted/i);
  });

  // -------------------------------------------------------------------------
  // Search filter still narrows the resolver-driven catalog.
  // -------------------------------------------------------------------------

  it('search filter narrows the capability + resource lists from the resolver catalog', async () => {
    mockResolver(makeResolution());
    renderWithProviders(<AccessModule />, { capabilities: ['access_policy.read', 'shipments.read'] });
    const search = await screen.findByTestId('access-filter');
    fireEvent.change(search, { target: { value: 'shipments' } });
    expect(await screen.findByTestId('access-cap-shipments.read')).toBeInTheDocument();
    // `audit_log.read` is in the resolver catalog but doesn't match the
    // filter and should now be hidden.
    expect(screen.queryByTestId('access-cap-audit_log.read')).toBeNull();
  });

  // -------------------------------------------------------------------------
  // Capability request modal — Phase C6 wires through canonical
  // request_capability_grant_v1 RPC (no longer PREVIEW-only).
  // -------------------------------------------------------------------------

  it('Request capability modal routes through request_capability_grant_v1 and shows backend row readback evidence', async () => {
    mockResolver(makeResolution());
    vi.spyOn(api, 'request_capability_grant_v1').mockResolvedValue({
      ok: true,
      capability_grant_request_id: 'cgr_test_123',
      status: 'pending',
      correlation_id: 'corr_test_request_123',
      idempotent: false,
      request_readback: {
        id: 'cgr_test_123',
        capability_key: 'backend.confirmed.write',
        scope_type: 'tenant',
        scope_id: 'org_rashed',
        reason: 'Backend persisted request reason.',
        duration_hours: 4,
        status: 'pending',
        correlation_id: 'corr_test_request_123',
        decision_log_id: 'decision_test_request_123',
        created_at: '2026-05-19T21:00:00.000Z',
      },
    });
    renderWithProviders(<AccessModule />, { capabilities: ['access_policy.read'] });
    const card = await screen.findByTestId('access-cap-shipments.write');
    const requestBtn = card.querySelector('button');
    expect(requestBtn).not.toBeNull();
    fireEvent.click(requestBtn!);
    // Modal body renders — Submit request button is present (no longer
    // labelled "(preview)" since the RPC is now real).
    expect(await screen.findByTestId('access-request-modal-body')).toBeInTheDocument();
    fireEvent.change(screen.getByPlaceholderText(/Required for incident response/i), {
      target: { value: 'Need temporary shipment write access for incident review.' },
    });
    fireEvent.click(screen.getByRole('button', { name: /^Submit request$/i }));

    const evidence = await screen.findByTestId('access-request-evidence');
    expect(evidence).toHaveTextContent(/Access request confirmed/i);
    expect(evidence).toHaveTextContent(/backend.confirmed.write/i);
    expect(evidence).toHaveTextContent(/Backend persisted request reason/i);
    expect(evidence).toHaveTextContent(/pending/i);
    expect(evidence).toHaveTextContent(/reference recorded/i);
    expect(evidence).toHaveTextContent(/4h requested/i);
    expect(api.request_capability_grant_v1).toHaveBeenCalledWith(
      expect.objectContaining({
        capability_key: 'shipments.write',
        scope_type: 'tenant',
        duration_hours: expect.any(Number),
        reason: 'Need temporary shipment write access for incident review.',
        justification: 'Need temporary shipment write access for incident review.',
      }),
    );
  });

  it('Request capability modal rejects mutation success without backend row readback evidence', async () => {
    mockResolver(makeResolution());
    const toastSpy = vi.spyOn(toastStore, 'pushToast');
    vi.spyOn(api, 'request_capability_grant_v1').mockResolvedValue({
      ok: true,
      capability_grant_request_id: 'cgr_missing_readback',
      status: 'pending',
      correlation_id: 'corr_missing_readback',
    });
    renderWithProviders(<AccessModule />, { capabilities: ['access_policy.read'] });
    const card = await screen.findByTestId('access-cap-shipments.write');
    const requestBtn = card.querySelector('button');
    expect(requestBtn).not.toBeNull();
    fireEvent.click(requestBtn!);
    expect(await screen.findByTestId('access-request-modal-body')).toBeInTheDocument();
    fireEvent.change(screen.getByPlaceholderText(/Required for incident response/i), {
      target: { value: 'Need access, but backend readback is missing.' },
    });
    fireEvent.click(screen.getByRole('button', { name: /^Submit request$/i }));

    await waitFor(() => {
      expect(toastSpy).toHaveBeenCalledWith(
        'Access request submitted, but the saved result could not be confirmed.',
        'danger',
      );
    });
    expect(screen.queryByTestId('access-request-evidence')).toBeNull();
    expect(await screen.findByTestId('access-request-modal-body')).toBeInTheDocument();
  });

  // ===========================================================================
  // CLAIM-IDENTITY-RBAC (Phase E3) — RBAC role-management lifecycle tests.
  //
  // Coverage matrix (12 tests across the 4 canonical RBAC tables × CRUD verbs):
  //   - rbac_roles                  : list / create / edit / delete  (4)
  //   - rbac_user_role_assignments  : list / grant / revoke           (3)
  //   - rbac_role_templates         : list / apply                    (2)
  //   - rbac_role_permissions       : list (drawer projection)        (1)
  //   - tab navigation + capability gating                             (2)
  // ===========================================================================

  describe('RBAC role-management lifecycle', () => {
    it('renders 5 tabs (Policy / Roles / Assignments / Templates / Requests) gated by access_policy.read', async () => {
      mockResolver(makeResolution());
      renderWithProviders(<AccessModule />, { capabilities: ['access_policy.read'] });
      expect(await screen.findByTestId('access-tab-policy')).toBeInTheDocument();
      expect(screen.getByTestId('access-tab-roles')).toBeInTheDocument();
      expect(screen.getByTestId('access-tab-assignments')).toBeInTheDocument();
      expect(screen.getByTestId('access-tab-templates')).toBeInTheDocument();
      expect(screen.getByTestId('access-tab-requests')).toBeInTheDocument();
    });

    it('Requests tab approves a pending capability grant and shows backend row readback without reload', async () => {
      const user = userEvent.setup();
      mockResolver(makeResolution());
      const actualList = api.ui_list_resource_complete;
      let reviewed = false;
      const pendingRequest = {
        id: 'cgr_review_001',
        organization_id: 'org_rashed',
        requested_by: 'usr_client_admin_exampleparcel',
        requested_by_email: 'fleet-admin@exampleparcel-ksa.example',
        requested_by_full_name: 'Mona Al-Hashimi',
        target_user_id: 'usr_client_admin_exampleparcel',
        target_user_email: 'fleet-admin@exampleparcel-ksa.example',
        target_user_full_name: 'Mona Al-Hashimi',
        capability_key: 'shipments.write',
        scope_type: 'tenant',
        scope_id: 'org_rashed',
        reason: 'Need shipment write access for exception closeout.',
        duration_hours: 8,
        status: 'pending',
        decided_by: null,
        decided_by_email: null,
        decided_at: null,
        decision_notes: null,
        correlation_id: 'corr_request_pending',
        decision_log_id: 'decision_request_pending',
        approved_role_id: null,
        approved_permission_id: null,
        approved_assignment_id: null,
        created_at: '2026-05-27T10:00:00.000Z',
        updated_at: '2026-05-27T10:00:00.000Z',
      };
      const approvedRequest = {
        ...pendingRequest,
        status: 'approved',
        decided_by: 'usr_admin_rashed',
        decided_by_email: 'rashed@rashed-logistics.example',
        decided_at: '2026-05-27T10:05:00.000Z',
        decision_notes: 'Approved from request review test.',
        correlation_id: 'corr_review_approved',
        decision_log_id: 'decision_review_approved',
        approved_role_id: 'rol_request_shipments_write',
        approved_permission_id: 'perm_shipments_write',
        approved_assignment_id: 'ura_request_shipments_write',
        updated_at: '2026-05-27T10:05:00.000Z',
      };
      vi.spyOn(api, 'ui_list_resource_complete').mockImplementation(async (key, opts) => {
        const result = await actualList(key, opts);
        if (key === 'capability_grant_requests') {
          const rows = [reviewed ? approvedRequest : pendingRequest];
          return { ...result, rows, total: rows.length, count: rows.length, page: 0, page_size: rows.length };
        }
        if (key === 'rbac_user_role_assignments' && reviewed) {
          const rows = [
            ...((result.rows ?? []) as Array<Record<string, unknown>>),
            {
              id: 'ura_request_shipments_write',
              organization_id: 'org_rashed',
              user_id: 'usr_client_admin_exampleparcel',
              user_email: 'fleet-admin@exampleparcel-ksa.example',
              user_full_name: 'Mona Al-Hashimi',
              role_id: 'rol_request_shipments_write',
              role_key: 'access_request_shipments_write',
              role_name: 'Shipments Write access request',
              assigned_by_user_id: 'usr_admin_rashed',
              assigned_at: '2026-05-27T10:05:00.000Z',
              revoked_by_user_id: null,
              revoked_at: null,
              metadata: { source: 'test-readback' },
              created_at: '2026-05-27T10:05:00.000Z',
              updated_at: '2026-05-27T10:05:00.000Z',
            },
          ];
          return { ...result, rows, total: rows.length, count: rows.length, page: 0, page_size: rows.length };
        }
        return result;
      });
      const reviewSpy = vi.spyOn(api, 'ui_review_capability_grant_request_v1').mockImplementation(async () => {
        reviewed = true;
        return {
          ok: true,
          capability_grant_request_id: 'cgr_review_001',
          status: 'approved',
          decision: 'approved',
          correlation_id: 'corr_review_approved',
          decision_log_id: 'decision_review_approved',
          rbac_role_id: 'rol_request_shipments_write',
          rbac_role_permission_id: 'rperm_request_shipments_write',
          rbac_user_role_assignment_id: 'ura_request_shipments_write',
          request_readback: approvedRequest,
        };
      });

      renderWithTenantAccess();
      await user.click(await screen.findByTestId('access-tab-requests'));
      const pane = await screen.findByTestId('access-requests-pane');
      expect(await within(pane).findByText(/shipments\.write/i)).toBeInTheDocument();
      const actionButtons = within(pane)
        .getAllByLabelText('Row actions')
        .filter((node) => node.tagName === 'BUTTON');
      await user.click(actionButtons[0]!);
      await user.click(await screen.findByRole('option', { name: /^Approve/ }));
      expect(await screen.findByTestId('access-request-review-body')).toBeInTheDocument();
      await user.type(
        screen.getByTestId('access-request-review-notes'),
        'Approved from request review test.',
      );
      await user.click(screen.getByRole('button', { name: /^Approve$/i }));

      await waitFor(() => expect(reviewSpy).toHaveBeenCalled());
      expect(reviewSpy).toHaveBeenCalledWith(
        expect.objectContaining({
          request_id: 'cgr_review_001',
          decision: 'approved',
          decision_notes: 'Approved from request review test.',
        }),
      );
      const evidence = await screen.findByTestId('access-request-review-evidence');
      expect(evidence).toHaveTextContent(/Access request review confirmed/i);
      expect(evidence).toHaveTextContent(/approved/i);
      expect(evidence).toHaveTextContent(/shipments\.write/i);
      expect(evidence).toHaveTextContent(/role rol_request_shipments_write/i);
      expect(evidence).toHaveTextContent(/assignment ura_request_shipments_write/i);
      expect(evidence).toHaveTextContent(/Approved from request review test/i);
      await waitFor(() => {
        expect(pane).toHaveTextContent(/approved/i);
        expect(pane).not.toHaveTextContent(/pending/i);
      });
    });

    it('Requests tab keeps review actions visible but disabled without access_policy.approve', async () => {
      const user = userEvent.setup();
      mockResolver(makeResolution());
      const actualList = api.ui_list_resource_complete;
      vi.spyOn(api, 'ui_list_resource_complete').mockImplementation(async (key, opts) => {
        const result = await actualList(key, opts);
        if (key !== 'capability_grant_requests') return result;
        return {
          ...result,
          rows: [
            {
              id: 'cgr_review_readonly',
              organization_id: 'org_rashed',
              requested_by_email: 'fleet-admin@exampleparcel-ksa.example',
              target_user_email: 'fleet-admin@exampleparcel-ksa.example',
              capability_key: 'shipments.write',
              scope_type: 'tenant',
              scope_id: 'org_rashed',
              reason: 'Readonly operator cannot approve this.',
              status: 'pending',
              created_at: '2026-05-27T10:00:00.000Z',
            },
          ],
          total: 1,
          count: 1,
          page: 0,
          page_size: 1,
        };
      });
      const reviewSpy = vi.spyOn(api, 'ui_review_capability_grant_request_v1');

      renderWithTenantAccess(['access_policy.read']);
      await user.click(await screen.findByTestId('access-tab-requests'));
      const pane = await screen.findByTestId('access-requests-pane');
      expect(await within(pane).findByText(/shipments\.write/i)).toBeInTheDocument();
      expect(within(pane).getByText(/Approve \/ Deny require/i)).toBeInTheDocument();
      const actionButtons = within(pane)
        .getAllByLabelText('Row actions')
        .filter((node) => node.tagName === 'BUTTON');
      await user.click(actionButtons[0]!);
      const approve = await screen.findByRole('option', { name: /^Approve/ });
      expect(approve).toHaveClass('is-disabled');
      expect(approve).toHaveTextContent(/access approval permission/i);
      await user.click(approve).catch(() => undefined);
      expect(reviewSpy).not.toHaveBeenCalled();
    });

    it('Requests tab prevents re-review of terminal access requests', async () => {
      const user = userEvent.setup();
      mockResolver(makeResolution());
      const actualList = api.ui_list_resource_complete;
      vi.spyOn(api, 'ui_list_resource_complete').mockImplementation(async (key, opts) => {
        const result = await actualList(key, opts);
        if (key !== 'capability_grant_requests') return result;
        return {
          ...result,
          rows: [
            {
              id: 'cgr_review_terminal',
              organization_id: 'org_rashed',
              requested_by_email: 'fleet-admin@exampleparcel-ksa.example',
              target_user_email: 'fleet-admin@exampleparcel-ksa.example',
              capability_key: 'shipments.write',
              scope_type: 'tenant',
              scope_id: 'org_rashed',
              reason: 'Already reviewed.',
              status: 'approved',
              decided_at: '2026-05-27T10:05:00.000Z',
              created_at: '2026-05-27T10:00:00.000Z',
            },
          ],
          total: 1,
          count: 1,
          page: 0,
          page_size: 1,
        };
      });
      const reviewSpy = vi.spyOn(api, 'ui_review_capability_grant_request_v1');

      renderWithTenantAccess();
      await user.click(await screen.findByTestId('access-tab-requests'));
      const pane = await screen.findByTestId('access-requests-pane');
      expect(await within(pane).findByText(/approved/i)).toBeInTheDocument();
      const actionButtons = within(pane)
        .getAllByLabelText('Row actions')
        .filter((node) => node.tagName === 'BUTTON');
      await user.click(actionButtons[0]!);
      const approve = await screen.findByRole('option', { name: /^Approve/ });
      expect(approve).toHaveClass('is-disabled');
      expect(approve).toHaveTextContent(/already reviewed/i);
      await user.click(approve).catch(() => undefined);
      expect(reviewSpy).not.toHaveBeenCalled();
    });

    it('Roles tab lists rbac_roles rows from useResourceList', async () => {
      mockResolver(makeResolution());
      renderWithTenantAccess();
      fireEvent.click(await screen.findByTestId('access-tab-roles'));
      // Pane renders + at least one canonical seed row appears (e.g. ops_admin).
      expect(await screen.findByTestId('access-roles-pane')).toBeInTheDocument();
      expect(await screen.findByRole('columnheader', { name: /^Role slug$/i })).toBeInTheDocument();
      expect(screen.queryByRole('columnheader', { name: /^Key$/i })).toBeNull();
      // Multiple ops_admin matches expected (role slug + assignee role chip);
      // findAllByText asserts at least one match.
      const matches = await screen.findAllByText(/ops_admin/i);
      expect(matches.length).toBeGreaterThan(0);
    });

    it('Roles tab surfaces rbac_roles read failures as an operator error', async () => {
      mockResolver(makeResolution());
      const spy = failResourceList('rbac_roles', 'rbac roles backend rejected');
      renderWithTenantAccess();
      fireEvent.click(await screen.findByTestId('access-tab-roles'));
      expect(await screen.findByText(/Access roles unavailable/i)).toBeInTheDocument();
      expect(screen.getByText(/This section could not load/i)).toBeInTheDocument();
      expect(screen.queryByText(/rbac roles backend rejected/i)).toBeNull();
      expect(screen.queryByText(/ops_admin/i)).toBeNull();
      expect(screen.queryByRole('columnheader', { name: /^Role slug$/i })).toBeNull();
      expect(spy).toHaveBeenCalledWith('rbac_roles', {
        filter: { organization_id: 'org_rashed' },
      });
    });

    it('Roles tab Create button gates on access_policy.approve and opens the role editor modal', async () => {
      mockResolver(makeResolution());
      renderWithTenantAccess();
      fireEvent.click(await screen.findByTestId('access-tab-roles'));
      const createWrap = await screen.findByTestId('rbac-create-role-btn');
      // Click the inner button (span wrapper carries the testid; the click
      // target is the actual button element).
      const innerBtn = createWrap.querySelector('button');
      expect(innerBtn).not.toBeNull();
      fireEvent.click(innerBtn!);
      expect(await screen.findByTestId('rbac-role-editor-body')).toBeInTheDocument();
      expect(screen.getByRole('button', { name: /^Create$/i })).toBeInTheDocument();
    });

    it('Create role editor treats key as a custom slug, not a lookup, and auto-generates it from the name', async () => {
      mockResolver(makeResolution());
      const ds = await import('@/lib/data-source');
      const actualList = api.ui_list_resource_complete;
      let includeCreatedRole = false;
      vi.spyOn(api, 'ui_list_resource_complete').mockImplementation(async (key, opts) => {
        const result = await actualList(key, opts);
        if (key !== 'rbac_roles' || !includeCreatedRole) return result;
        const rows = [
          ...((result.rows ?? []) as Array<Record<string, unknown>>),
          {
            id: 'rol_browser_audit',
            organization_id: 'org_rashed',
            key: 'browser_audit_lead',
            name: 'Browser Audit Lead',
            description: 'Temporary role created from the live role editor.',
            is_active: true,
            metadata: {},
            created_at: '2026-05-11T10:00:00.000Z',
            updated_at: '2026-05-11T10:00:00.000Z',
            permission_count: 0,
            assignment_count: 0,
          },
        ];
        return { ...result, rows, count: rows.length, total: rows.length };
      });
      const spy = vi.spyOn(ds, 'rbac_create_role_v1').mockImplementation(async () => {
        includeCreatedRole = true;
        return {
          ok: true,
          rbac_role_id: 'rol_browser_audit',
          correlation_id: 'cor_browser_audit',
        } as never;
      });
      renderWithTenantAccess();
      fireEvent.click(await screen.findByTestId('access-tab-roles'));
      const createWrap = await screen.findByTestId('rbac-create-role-btn');
      const innerBtn = createWrap.querySelector('button');
      expect(innerBtn).not.toBeNull();
      fireEvent.click(innerBtn!);
      expect(await screen.findByText(/Saves a tenant-scoped access role/i)).toBeInTheDocument();
      expect(screen.getByText(/Permissions attached to the role are lookup-backed/i)).toBeInTheDocument();
      expect(screen.getByText(/Custom role slug/i)).toBeInTheDocument();
      expect(screen.getByTestId('rbac-role-editor-key')).toHaveValue('');
      fireEvent.change(screen.getByTestId('rbac-role-editor-name'), {
        target: { value: 'Browser Audit Lead' },
      });
      expect(screen.getByTestId('rbac-role-editor-key')).toHaveValue('browser_audit_lead');
      fireEvent.click(screen.getByRole('button', { name: /^Create$/i }));
      await waitFor(() => expect(spy).toHaveBeenCalled());
      const callArgs = spy.mock.calls[0]?.[0] as Record<string, unknown>;
      expect(callArgs?.key).toBe('browser_audit_lead');
      expect(callArgs?.name).toBe('Browser Audit Lead');
      expect(await screen.findByText('browser_audit_lead')).toBeInTheDocument();
      expect(screen.getByText('Browser Audit Lead')).toBeInTheDocument();
      await waitFor(() => {
        expect(screen.queryByRole('dialog', { name: /Create access role/i })).toBeNull();
      });
    });

    it('Edit role modal calls rbac_update_role_v1 with the role_id + edited fields', async () => {
      mockResolver(makeResolution());
      const ds = await import('@/lib/data-source');
      const actualList = api.ui_list_resource_complete;
      let renamed = false;
      vi.spyOn(api, 'ui_list_resource_complete').mockImplementation(async (key, opts) => {
        const result = await actualList(key, opts);
        if (key !== 'rbac_roles' || !renamed) return result;
        return {
          ...result,
          rows: (result.rows ?? []).map((row: Record<string, unknown>) =>
            row.id === 'rol_8a3c1f04-0001-4000-8000-000000000001'
              ? { ...row, name: 'Ops Admin (renamed)' }
              : row,
          ),
        };
      });
      const spy = vi.spyOn(ds, 'rbac_update_role_v1').mockImplementation(async () => {
        renamed = true;
        return {
          ok: true,
          rbac_role_id: 'rol_8a3c1f04-0001-4000-8000-000000000001',
          correlation_id: 'cor_test_1',
        } as never;
      });
      renderWithTenantAccess();
      fireEvent.click(await screen.findByTestId('access-tab-roles'));
      // Wait for table to render then click first ops_admin match (role slug
      // cell) to open drawer.
      const opsMatches = await screen.findAllByText(/ops_admin/i);
      expect(opsMatches.length).toBeGreaterThan(0);
      fireEvent.click(opsMatches[0]!);
      // Drawer opens with Edit button — click it.
      const editBtn = await screen.findByRole('button', { name: /^Edit$/i });
      fireEvent.click(editBtn);
      // Edit modal renders with the role's name pre-populated.
      const nameField = await screen.findByTestId('rbac-role-editor-name');
      fireEvent.change(nameField, { target: { value: 'Ops Admin (renamed)' } });
      fireEvent.click(screen.getByRole('button', { name: /^Save$/i }));
      // Mutation called with the correct role_id.
      await new Promise((r) => setTimeout(r, 50));
      expect(spy).toHaveBeenCalled();
      const callArgs = spy.mock.calls[0]?.[0] as Record<string, unknown>;
      expect(callArgs?.role_id).toBe('rol_8a3c1f04-0001-4000-8000-000000000001');
      expect(callArgs?.name).toBe('Ops Admin (renamed)');
      expect(await screen.findByText('Ops Admin (renamed)')).toBeInTheDocument();
    });

    it('Deactivate role action calls rbac_delete_role_v1 with role_id + organization_id', async () => {
      mockResolver(makeResolution());
      const ds = await import('@/lib/data-source');
      const actualList = api.ui_list_resource_complete;
      let deactivated = false;
      vi.spyOn(api, 'ui_list_resource_complete').mockImplementation(async (key, opts) => {
        const result = await actualList(key, opts);
        if (key !== 'rbac_roles' || !deactivated) return result;
        const rows = (result.rows ?? []).map((row: Record<string, unknown>) =>
          row.key === 'incident_response_oncall'
            ? {
                ...row,
                is_active: false,
                assignment_count: 0,
                active_assignment_count: 0,
                updated_at: '2026-05-12T15:55:00.000Z',
              }
            : row,
        );
        return { ...result, rows, count: rows.length, total: rows.length };
      });
      const spy = vi.spyOn(ds, 'rbac_delete_role_v1').mockImplementation(async () => {
        deactivated = true;
        return {
          ok: true,
          rbac_role_id: 'rol_8a3c1f04-0001-4000-8000-000000000007',
          correlation_id: 'cor_test_2',
        } as never;
      });
      renderWithTenantAccess();
      fireEvent.click(await screen.findByTestId('access-tab-roles'));
      // Open drawer for the custom role then delete.
      const customMatches = await screen.findAllByText(/incident_response_oncall/i);
      fireEvent.click(customMatches[0]!);
      const deactivateBtns = await screen.findAllByRole('button', { name: /^Deactivate$/i });
      // Drawer has a Deactivate button; click it.
      fireEvent.click(deactivateBtns[0]!);
      expect(await screen.findByText(/stays in the access history as inactive/i)).toBeInTheDocument();
      // Confirm dialog: click Deactivate to fire mutation.
      const confirmBtns = await screen.findAllByRole('button', { name: /^Deactivate$/i });
      fireEvent.click(confirmBtns[confirmBtns.length - 1]!);
      await new Promise((r) => setTimeout(r, 50));
      expect(spy).toHaveBeenCalled();
      const callArgs = spy.mock.calls[0]?.[0] as Record<string, unknown>;
      expect(callArgs?.role_id).toBe('rol_8a3c1f04-0001-4000-8000-000000000007');
      expect(callArgs?.organization_id).toBeDefined();
      await waitFor(() => {
        expect(screen.getByText(/incident_response_oncall/i)).toBeInTheDocument();
        expect(screen.getByText(/^inactive$/i)).toBeInTheDocument();
      });
      const inactiveMatches = await screen.findAllByText(/incident_response_oncall/i);
      fireEvent.click(inactiveMatches[0]!);
      const drawerBody = await screen.findByTestId('rbac-role-drawer-body');
      const inactiveDeactivate = within(drawerBody).getByRole('button', {
        name: /^Deactivate$/i,
      });
      expect(inactiveDeactivate).toBeDisabled();
      expect(inactiveDeactivate).toHaveAttribute('title', 'Role is already inactive.');
    });

    it('Assignments tab lists rbac_user_role_assignments rows', async () => {
      mockResolver(makeResolution());
      renderWithTenantAccess();
      fireEvent.click(await screen.findByTestId('access-tab-assignments'));
      expect(await screen.findByTestId('access-assignments-pane')).toBeInTheDocument();
      // Canonical seed row: rashed@rashed-logistics.example with ops_admin role.
      expect(await screen.findByText(/rashed@rashed-logistics\.example/i)).toBeInTheDocument();
    });

    it('Assignments tab surfaces assignment read failures as an operator error', async () => {
      mockResolver(makeResolution());
      const spy = failResourceList(
        'rbac_user_role_assignments',
        'assignments backend rejected',
      );
      renderWithTenantAccess();
      fireEvent.click(await screen.findByTestId('access-tab-assignments'));
      expect(await screen.findByText(/User-role assignments unavailable/i)).toBeInTheDocument();
      expect(screen.getByText(/This section could not load/i)).toBeInTheDocument();
      expect(screen.queryByText(/assignments backend rejected/i)).toBeNull();
      expect(screen.queryByText(/rashed@rashed-logistics\.example/i)).toBeNull();
      expect(screen.queryByRole('columnheader', { name: /^User$/i })).toBeNull();
      expect(spy).toHaveBeenCalledWith('rbac_user_role_assignments', {
        filter: { organization_id: 'org_rashed' },
      });
    });

    it('Grant role explains when the user picker cannot load', async () => {
      mockResolver(makeResolution());
      const spy = failResourceList('users', 'users backend rejected');
      renderWithTenantAccess();
      fireEvent.click(await screen.findByTestId('access-tab-assignments'));
      const pane = await screen.findByTestId('access-assignments-pane');
      expect(await within(pane).findByText(/Grant role unavailable/i)).toBeInTheDocument();
      expect(within(pane).getByText(/This section could not load/i)).toBeInTheDocument();
      expect(within(pane).queryByText(/users backend rejected/i)).toBeNull();
      const grantBtn = screen.getByTestId('rbac-grant-role-btn').querySelector('button');
      expect(grantBtn).not.toBeNull();
      await waitFor(() => expect(grantBtn).toBeDisabled());
      expect(spy).toHaveBeenCalled();
    });

    it('Grant role explains when no users are available in scope', async () => {
      mockResolver(makeResolution());
      const actualList = api.ui_list_resource_complete;
      vi.spyOn(api, 'ui_list_resource_complete').mockImplementation(async (key, opts) => {
        const result = await actualList(key, opts);
        if (key !== 'users') return result;
        return { ...result, rows: [], count: 0, total: 0 };
      });
      renderWithTenantAccess();
      fireEvent.click(await screen.findByTestId('access-tab-assignments'));
      const pane = await screen.findByTestId('access-assignments-pane');
      expect(
        await within(pane).findByText(/No users are available to grant a role in this scope/i),
      ).toBeInTheDocument();
      const grantBtn = screen.getByTestId('rbac-grant-role-btn').querySelector('button');
      expect(grantBtn).not.toBeNull();
      await waitFor(() => expect(grantBtn).toBeDisabled());
    });

    it('Grant role explains when no roles are available in scope', async () => {
      mockResolver(makeResolution());
      const actualList = api.ui_list_resource_complete;
      vi.spyOn(api, 'ui_list_resource_complete').mockImplementation(async (key, opts) => {
        const result = await actualList(key, opts);
        if (key !== 'rbac_roles') return result;
        return { ...result, rows: [], count: 0, total: 0 };
      });
      renderWithTenantAccess();
      fireEvent.click(await screen.findByTestId('access-tab-assignments'));
      const pane = await screen.findByTestId('access-assignments-pane');
      expect(
        await within(pane).findByText(/No active roles are available to grant in this scope/i),
      ).toBeInTheDocument();
      const grantBtn = screen.getByTestId('rbac-grant-role-btn').querySelector('button');
      expect(grantBtn).not.toBeNull();
      await waitFor(() => expect(grantBtn).toBeDisabled());
    });

    it('Grant role modal hides inactive backend roles from grantable options', async () => {
      mockResolver(makeResolution());
      const actualList = api.ui_list_resource_complete;
      vi.spyOn(api, 'ui_list_resource_complete').mockImplementation(async (key, opts) => {
        const result = await actualList(key, opts);
        if (key !== 'rbac_roles') return result;
        return {
          ...result,
          rows: ((result.rows ?? []) as Array<Record<string, unknown>>).map((row) =>
            row.key === 'incident_response_oncall'
              ? { ...row, is_active: false }
              : row,
          ),
        };
      });
      renderWithTenantAccess();
      fireEvent.click(await screen.findByTestId('access-tab-assignments'));
      const grantWrap = await screen.findByTestId('rbac-grant-role-btn');
      const grantBtn = grantWrap.querySelector('button');
      expect(grantBtn).not.toBeNull();
      await waitFor(() => expect(grantBtn).not.toBeDisabled());
      fireEvent.click(grantBtn!);
      const roleField = await screen.findByTestId('rbac-grant-role-select') as HTMLSelectElement;
      const optionLabels = Array.from(roleField.options).map((option) => option.textContent ?? '');
      expect(optionLabels.join(' ')).not.toMatch(/incident_response_oncall/i);
      expect(optionLabels.join(' ')).toMatch(/ops_admin/i);
    });

    it('Grant role modal shows the new backend-read assignment without a reload', async () => {
      const user = userEvent.setup();
      mockResolver(makeResolution());
      const ds = await import('@/lib/data-source');
      const actualList = api.ui_list_resource_complete;
      let grantPersisted = false;
      vi.spyOn(api, 'ui_list_resource_complete').mockImplementation(async (key, opts) => {
        const result = await actualList(key, opts);
        if (key !== 'rbac_user_role_assignments' || !grantPersisted) return result;
        const rows = [
          ...((result.rows ?? []) as Array<Record<string, unknown>>).filter(
            (row) => row.id !== 'ura_new',
          ),
          {
            id: 'ura_new',
            organization_id: 'org_rashed',
            user_id: 'usr_client_admin_exampleparcel',
            user_email: 'fleet-admin@exampleparcel-ksa.example',
            user_full_name: 'Mona Al-Hashimi',
            role_id: 'rol_8a3c1f04-0001-4000-8000-000000000001',
            role_key: 'ops_admin',
            role_name: 'Ops Admin',
            assigned_by_user_id: 'usr_admin_rashed',
            assigned_at: '2026-05-12T00:45:00.000Z',
            revoked_by_user_id: null,
            revoked_at: null,
            metadata: { source: 'test-readback' },
            created_at: '2026-05-12T00:45:00.000Z',
            updated_at: '2026-05-12T00:45:00.000Z',
          },
        ];
        return { ...result, rows, count: rows.length, total: rows.length };
      });
      const spy = vi.spyOn(ds, 'rbac_grant_role_v1').mockImplementation(async () => {
        grantPersisted = true;
        return {
          ok: true,
          rbac_user_role_assignment_id: 'ura_new',
          correlation_id: 'cor_test_3',
        } as never;
      });
      renderWithTenantAccess();
      await user.click(await screen.findByTestId('access-tab-assignments'));
      const grantWrap = await screen.findByTestId('rbac-grant-role-btn');
      const grantBtn = grantWrap.querySelector('button');
      expect(grantBtn).not.toBeNull();
      await waitFor(() => expect(grantBtn).not.toBeDisabled());
      await user.click(grantBtn!);
      // Modal opens — fill user_id + click Grant.
      const userField = await screen.findByTestId('rbac-grant-user-id') as HTMLSelectElement;
      const selectedUserId = 'usr_client_admin_exampleparcel';
      expect(selectedUserId).toBeTruthy();
      await user.selectOptions(userField, selectedUserId);
      const roleField = screen.getByTestId('rbac-grant-role-select') as HTMLSelectElement;
      await user.selectOptions(roleField, 'rol_8a3c1f04-0001-4000-8000-000000000001');
      await user.click(screen.getByRole('button', { name: /^Grant$/i }));
      await waitFor(() => expect(spy).toHaveBeenCalled());
      const callArgs = spy.mock.calls[0]?.[0] as Record<string, unknown>;
      expect(callArgs?.user_id).toBe(selectedUserId);
      expect(callArgs?.role_id).toBe('rol_8a3c1f04-0001-4000-8000-000000000001');
      await waitFor(() => expect(screen.queryByTestId('rbac-grant-modal-body')).toBeNull());
      const pane = screen.getByTestId('access-assignments-pane');
      const grantedMatches = await within(pane).findAllByText(
        /fleet-admin@exampleparcel-ksa\.example/i,
        {},
        { timeout: 3000 },
      );
      const grantedCell = grantedMatches.find((el) => el.closest('td'));
      expect(grantedCell).toBeTruthy();
      expect(grantedCell!.closest('tr')).toHaveTextContent(/ops_admin/i);
      expect(grantedCell!.closest('tr')).toHaveTextContent(/active/i);
      const evidence = await screen.findByTestId('rbac-assignment-mutation-evidence');
      expect(evidence).toHaveTextContent(/Assignment confirmed/i);
      expect(evidence).toHaveTextContent(/granted/i);
      expect(evidence).toHaveTextContent(/active/i);
      expect(evidence).toHaveTextContent(/fleet-admin@exampleparcel-ksa\.example/i);
      expect(evidence).toHaveTextContent(/role ops_admin/i);
      expect(evidence).toHaveTextContent(/assignment ura_new/i);
      expect(evidence).toHaveTextContent(/reference recorded/i);
    });

    it('Revoke assignment action refreshes visible assignment state without a reload', async () => {
      const user = userEvent.setup();
      mockResolver(makeResolution());
      const ds = await import('@/lib/data-source');
      const actualList = api.ui_list_resource_complete;
      let revokePersisted = false;
      vi.spyOn(api, 'ui_list_resource_complete').mockImplementation(async (key, opts) => {
        const result = await actualList(key, opts);
        if (!revokePersisted) return result;
        if (key === 'rbac_user_role_assignments') {
          const rows = ((result.rows ?? []) as Array<Record<string, unknown>>).map((row) =>
            row.id === 'ura_0001'
              ? {
                  ...row,
                  revoked_by_user_id: 'usr_admin_rashed',
                  revoked_at: '2026-05-12T00:50:00.000Z',
                  updated_at: '2026-05-12T00:50:00.000Z',
                  metadata: {
                    ...((row.metadata as Record<string, unknown> | undefined) ?? {}),
                    revocation_reason: 'Ops handoff complete',
                  },
                }
              : row,
          );
          return { ...result, rows, count: rows.length, total: rows.length };
        }
        if (key === 'rbac_roles') {
          return {
            ...result,
            rows: ((result.rows ?? []) as Array<Record<string, unknown>>).map((row) =>
              row.id === 'rol_8a3c1f04-0001-4000-8000-000000000001'
                ? { ...row, assignment_count: 2 }
                : row,
            ),
          };
        }
        if (key === 'rbac_role_summary') {
          return {
            ...result,
            rows: ((result.rows ?? []) as Array<Record<string, unknown>>).map((row) =>
              row.id === 'rol_8a3c1f04-0001-4000-8000-000000000001'
                ? {
                    ...row,
                    assignment_count: 2,
                    active_assignment_count: 2,
                    revoked_assignment_count: Number(row.revoked_assignment_count ?? 0) + 1,
                  }
                : row,
            ),
          };
        }
        return result;
      });
      const spy = vi.spyOn(ds, 'rbac_revoke_role_v1').mockImplementation(async () => {
        revokePersisted = true;
        return {
          ok: true,
          rbac_user_role_assignment_id: 'ura_0001',
          correlation_id: 'cor_test_4',
        } as never;
      });
      const { queryClient } = renderWithTenantAccess();
      // Open the role drawer via Roles tab — drawer surfaces per-assignee
      // Revoke buttons that route to rbac_revoke_role_v1.
      await user.click(await screen.findByTestId('access-tab-roles'));
      await waitFor(() => {
        const assignments = queryClient.getQueryData<{ rows?: Array<{ id?: string }> }>(
          queries.qk.completeList('rbac_user_role_assignments', {
            filter: { organization_id: 'org_rashed' },
          }),
        );
        expect(assignments?.rows?.some((row) => row.id === 'ura_0001')).toBe(true);
      });
      const opsMatches = await screen.findAllByText(/ops_admin/i);
      await user.click(opsMatches[0]!);
      // Drawer renders with assignee Revoke button.
      const drawerBody = await screen.findByTestId('rbac-role-drawer-body');
      expect(drawerBody).toBeInTheDocument();
      const revokeButtons = await screen.findAllByRole('button', { name: /^Revoke$/i });
      expect(revokeButtons.length).toBeGreaterThan(0);
      await user.click(revokeButtons[0]!);
      // Confirm modal renders.
      expect(await screen.findByTestId('rbac-revoke-modal-body')).toBeInTheDocument();
      await user.type(screen.getByTestId('rbac-revoke-reason'), 'Ops handoff complete');
      // Click Revoke in the modal footer.
      const allRevokeBtns = screen.getAllByRole('button', { name: /^Revoke$/i });
      await user.click(allRevokeBtns[allRevokeBtns.length - 1]!);
      await waitFor(() => expect(spy).toHaveBeenCalled());
      const callArgs = spy.mock.calls[0]?.[0] as Record<string, unknown>;
      expect(callArgs?.assignment_id).toBeDefined();
      expect(callArgs?.reason).toBe('Ops handoff complete');
      await waitFor(() => expect(screen.queryByTestId('rbac-revoke-modal-body')).toBeNull());
      await waitFor(() => expect(screen.queryByTestId('rbac-role-drawer-body')).toBeNull());
      await user.click(await screen.findByTestId('access-tab-assignments'));
      const pane = await screen.findByTestId('access-assignments-pane');
      const revokedMatches = await within(pane).findAllByText(
        /rashed@rashed-logistics\.example/i,
        {},
        { timeout: 3000 },
      );
      const revokedCell = revokedMatches.find((el) => el.closest('td'));
      expect(revokedCell).toBeTruthy();
      expect(revokedCell!.closest('tr')).toHaveTextContent(/ops_admin/i);
      expect(revokedCell!.closest('tr')).toHaveTextContent(/revoked/i);
      const evidence = await screen.findByTestId('rbac-assignment-mutation-evidence');
      expect(evidence).toHaveTextContent(/Assignment confirmed/i);
      expect(evidence).toHaveTextContent(/revoked/i);
      expect(evidence).toHaveTextContent(/rashed@rashed-logistics\.example/i);
      expect(evidence).toHaveTextContent(/role ops_admin/i);
      expect(evidence).toHaveTextContent(/assignment ura_0001/i);
      expect(evidence).toHaveTextContent(/Ops handoff complete/i);
      expect(evidence).toHaveTextContent(/reference recorded/i);
    });

    it('Templates tab lists rbac_role_templates rows', async () => {
      mockResolver(makeResolution());
      renderWithTenantAccess();
      fireEvent.click(await screen.findByTestId('access-tab-templates'));
      expect(await screen.findByTestId('access-templates-pane')).toBeInTheDocument();
      // Canonical seed templates: ops_admin + finance + agreements_admin + ...
      expect(await screen.findByText(/Warehouse Operator/i)).toBeInTheDocument();
    });

    it('Template rows open details without triggering the apply mutation modal', async () => {
      mockResolver(makeResolution());
      renderWithTenantAccess();
      fireEvent.click(await screen.findByTestId('access-tab-templates'));
      expect(await screen.findByRole('columnheader', { name: /^Template key$/i })).toBeInTheDocument();
      expect(screen.queryByRole('columnheader', { name: /^Key$/i })).toBeNull();
      const driverCells = await screen.findAllByText(/^driver$/i);
      fireEvent.click(driverCells[0]!);

      const drawerBody = await screen.findByTestId('rbac-template-drawer-body');
      expect(drawerBody).toBeInTheDocument();
      expect(drawerBody).toHaveTextContent(/Driver task execution and scanning/i);
      expect(within(drawerBody).getByTestId('rbac-template-drawer-permissions')).toHaveTextContent(
        /tasks\.read/i,
      );
      expect(screen.queryByTestId('rbac-template-apply-body')).toBeNull();
    });

    it('Templates tab surfaces template read failures as an operator error', async () => {
      mockResolver(makeResolution());
      const spy = failResourceList('rbac_role_templates', 'templates backend rejected');
      renderWithTenantAccess();
      fireEvent.click(await screen.findByTestId('access-tab-templates'));
      expect(await screen.findByText(/Role templates unavailable/i)).toBeInTheDocument();
      expect(screen.getByText(/This section could not load/i)).toBeInTheDocument();
      expect(screen.queryByText(/templates backend rejected/i)).toBeNull();
      expect(screen.queryByText(/Warehouse Operator/i)).toBeNull();
      expect(screen.queryByTestId('rbac-template-apply-list')).toBeNull();
      expect(spy).toHaveBeenCalledWith('rbac_role_templates', undefined);
    });

    it('Apply template modal calls provision_rbac_roles_from_templates_v1 and shows backend-refetched role without a reload', async () => {
      mockResolver(makeResolution());
      const ds = await import('@/lib/data-source');
      const actualList = api.ui_list_resource_complete;
      let templateApplied = false;
      vi.spyOn(api, 'ui_list_resource_complete').mockImplementation(async (key, opts) => {
        const result = await actualList(key, opts);
        if (!templateApplied) return result;
        if (key === 'rbac_roles') {
          const rows = [
            ...((result.rows ?? []) as Array<Record<string, unknown>>).filter(
              (row) => row.id !== 'rol_provisioned',
            ),
            {
              id: 'rol_provisioned',
              organization_id: 'org_rashed',
              key: 'driver',
              name: 'Driver (template readback)',
              description: 'Backend-refetched role created from the driver template.',
              is_active: true,
              metadata: { source: 'template-readback' },
              created_at: '2026-05-12T01:15:00.000Z',
              updated_at: '2026-05-12T01:15:00.000Z',
              permission_count: 3,
              assignment_count: 0,
            },
          ];
          return { ...result, rows, count: rows.length, total: rows.length };
        }
        if (key === 'rbac_role_summary') {
          const rows = [
            ...((result.rows ?? []) as Array<Record<string, unknown>>).filter(
              (row) => row.id !== 'rol_provisioned',
            ),
            {
              id: 'rol_provisioned',
              organization_id: 'org_rashed',
              key: 'driver',
              name: 'Driver (template readback)',
              description: 'Backend-refetched role created from the driver template.',
              is_active: true,
              metadata: { source: 'template-readback' },
              created_at: '2026-05-12T01:15:00.000Z',
              updated_at: '2026-05-12T01:15:00.000Z',
              organization_label: 'Rashed Logistics',
              organization_slug: 'rashed-logistics',
              role_tier: 'functional',
              permission_count: 3,
              permission_values: ['tasks.read', 'routes.read', 'scans.write'],
              assignment_count: 0,
              active_assignment_count: 0,
              revoked_assignment_count: 0,
              last_assigned_at: null,
            },
          ];
          return { ...result, rows, count: rows.length, total: rows.length };
        }
        return result;
      });
      const spy = vi
        .spyOn(ds, 'provision_rbac_roles_from_templates_v1')
        .mockImplementation(async () => {
          templateApplied = true;
          return {
          ok: true,
          rbac_role_id: 'rol_provisioned',
          rbac_roles: [{ template_key: 'driver', role_id: 'rol_provisioned', created: false }],
          organization_id: 'org_rashed',
          template_keys: ['driver'],
          correlation_id: 'cor_test_5',
          } as never;
        });
      renderWithTenantAccess();
      fireEvent.click(await screen.findByTestId('access-tab-templates'));
      // Use the per-template direct Apply button (rendered inline below the
      // DataTable for a11y + test access without palette).
      const applyWraps = await screen.findAllByTestId(/^rbac-template-apply-/);
      const inlineApplyWrap = applyWraps.find((el) =>
        el.getAttribute('data-testid')?.startsWith('rbac-template-apply-') &&
        el.getAttribute('data-testid') !== 'rbac-template-apply-list' &&
        el.getAttribute('data-testid') !== 'rbac-template-apply-body',
      );
      expect(inlineApplyWrap).toBeDefined();
      const applyBtn = inlineApplyWrap!.querySelector('button');
      expect(applyBtn).not.toBeNull();
      fireEvent.click(applyBtn!);
      // Confirm modal renders.
      expect(await screen.findByTestId('rbac-template-apply-body')).toBeInTheDocument();
      // Submit Apply.
      const allApplyBtns = screen.getAllByRole('button', { name: /^Apply$/i });
      fireEvent.click(allApplyBtns[allApplyBtns.length - 1]!);
      await new Promise((r) => setTimeout(r, 50));
      expect(spy).toHaveBeenCalled();
      const callArgs = spy.mock.calls[0]?.[0] as Record<string, unknown>;
      expect(Array.isArray(callArgs?.template_keys)).toBe(true);
      expect((callArgs?.template_keys as string[]).length).toBeGreaterThan(0);
      const evidence = await screen.findByTestId('rbac-template-apply-evidence');
      expect(evidence).toHaveTextContent(/Template application confirmed/i);
      expect(evidence).toHaveTextContent(/driver/i);
      expect(evidence).toHaveTextContent(/rol_provisioned/i);
      expect(evidence).toHaveTextContent(/existing role refreshed/i);
      expect(evidence).toHaveTextContent(/reference recorded/i);
      expect(evidence).toHaveTextContent(/Organization recorded/i);
      expect(screen.queryByTestId('rbac-template-apply-body')).toBeNull();
      fireEvent.click(await screen.findByTestId('access-tab-roles'));
      const rolePane = await screen.findByTestId('access-roles-pane');
      const refreshedRole = await within(rolePane).findByText(/Driver \(template readback\)/i);
      expect(refreshedRole.closest('tr')).toHaveTextContent(/^driver/i);
      expect(refreshedRole.closest('tr')).toHaveTextContent(/active/i);
    });

    it('Role drawer (Permissions tab projection) lists rbac_role_permissions for the selected role', async () => {
      mockResolver(makeResolution());
      renderWithTenantAccess();
      fireEvent.click(await screen.findByTestId('access-tab-roles'));
      // Click first ops_admin row to open drawer.
      const opsMatches = await screen.findAllByText(/ops_admin/i);
      fireEvent.click(opsMatches[0]!);
      // Drawer renders with permissions list (canonical seed: 14 perms for ops_admin).
      const drawerBody = await screen.findByTestId('rbac-role-drawer-body');
      expect(drawerBody).toBeInTheDocument();
      expect(drawerBody).toHaveTextContent(/Permissions/i);
      expect(drawerBody).toHaveTextContent(/Active assignees/i);
      expect(drawerBody).not.toHaveTextContent(/rbac_role_permissions|rbac_user_role_assignments/i);
      const permsList = screen.getByTestId('rbac-role-drawer-permissions');
      // Ops admin seed contains shipments.read among 14 permissions.
      expect(permsList.textContent).toMatch(/shipments\.read/);
    });

    it('Roles tab denies access without access_policy.read capability', async () => {
      mockResolver(makeResolution());
      renderWithProviders(<AccessModule />, { capabilities: [] });
      fireEvent.click(await screen.findByTestId('access-tab-roles'));
      // Without access_policy.read the StateView shows the denied hint.
      // (The pane still renders for tab navigation — the StateView replaces
      //  the DataTable with a denied notice.)
      const pane = await screen.findByTestId('access-roles-pane');
      expect(pane.textContent).toMatch(/Access policy permission required/i);
    });

    it('Roles tab Create / Edit / Deactivate buttons stay capability-gated on access_policy.approve', async () => {
      mockResolver(makeResolution());
      // Granted only `access_policy.read` — Create button must render disabled
      // and the hint must mention the missing capability.
      renderWithProviders(<AccessModule />, { capabilities: ['access_policy.read'] });
      fireEvent.click(await screen.findByTestId('access-tab-roles'));
      // Wait for the pane to render
      const pane = await screen.findByTestId('access-roles-pane');
      // Button is still in DOM (wrapped span), but the inner button is
      // disabled by Button's capability gate.
      const createBtnWrap = await screen.findByTestId('rbac-create-role-btn');
      const innerBtn = createBtnWrap.querySelector('button');
      expect(innerBtn).not.toBeNull();
      expect(innerBtn).toBeDisabled();
      // Hint paragraph mentions the missing capability.
      expect(pane.textContent).toMatch(/Role changes require/i);
      expect(pane.textContent).toMatch(/Access Approval permission required/i);
    });

    it('Lower-permission access reader can inspect RBAC but cannot grant roles or apply templates', async () => {
      mockResolver(makeResolution());
      renderWithTenantAccess(['access_policy.read']);

      fireEvent.click(await screen.findByTestId('access-tab-roles'));
      const rolesPane = await screen.findByTestId('access-roles-pane');
      const createBtn = screen.getByTestId('rbac-create-role-btn').querySelector('button');
      expect(createBtn).not.toBeNull();
      expect(createBtn).toBeDisabled();
      expect(rolesPane).toHaveTextContent(/Role changes require/i);
      expect(rolesPane).toHaveTextContent(/Access Approval permission required/i);

      fireEvent.click(await screen.findByTestId('access-tab-assignments'));
      const assignmentsPane = await screen.findByTestId('access-assignments-pane');
      const grantBtn = screen.getByTestId('rbac-grant-role-btn').querySelector('button');
      expect(grantBtn).not.toBeNull();
      expect(grantBtn).toBeDisabled();
      expect(assignmentsPane).toHaveTextContent(/Grant \/ Revoke require/i);
      expect(assignmentsPane).toHaveTextContent(/access_policy\.approve/i);

      fireEvent.click(await screen.findByTestId('access-tab-templates'));
      const templatesPane = await screen.findByTestId('access-templates-pane');
      const applyWraps = await screen.findAllByTestId(/^rbac-template-apply-/);
      const inlineApplyWrap = applyWraps.find((el) =>
        el.getAttribute('data-testid')?.startsWith('rbac-template-apply-') &&
        el.getAttribute('data-testid') !== 'rbac-template-apply-list' &&
        el.getAttribute('data-testid') !== 'rbac-template-apply-body',
      );
      expect(inlineApplyWrap).toBeDefined();
      const applyBtn = inlineApplyWrap!.querySelector('button');
      expect(applyBtn).not.toBeNull();
      expect(applyBtn).toBeDisabled();
      fireEvent.click(applyBtn!);
      expect(screen.queryByTestId('rbac-template-apply-body')).toBeNull();
      expect(templatesPane).toHaveTextContent(/Apply template requires/i);
      expect(templatesPane).toHaveTextContent(/access_policy\.approve/i);
    });
  });

  // ===========================================================================
  // W23 paired projection (v_rbac_role_summary)
  //
  // Promotes the W19-3 `permission_count` / `assignment_count` derivations
  // from FE-side counter math to canonical projection columns. The role
  // drawer renders permission/assignment/revoked rollups + role_tier +
  // organization_label + last_assigned_at chips sourced from
  // `v_rbac_role_summary` instead of `.length`-on-filtered-arrays. SSOT:
  //   • supabase/migrations/202604302210_v_rbac_role_summary.sql
  //   • apps/console-v2/src/lib/data-source.ts → _projectRbacRoleSummary
  // ===========================================================================
  describe('AccessModule · paired projection wiring (W23)', () => {
    it('Role drawer surfaces v_rbac_role_summary chips (permissions / assignees / tier / org)', async () => {
      mockResolver(makeResolution());
      renderWithTenantAccess();
      fireEvent.click(await screen.findByTestId('access-tab-roles'));
      // Open the ops_admin role drawer (canonical seed:
      // rol_8a3c1f04-0001-4000-8000-000000000001 with 14 permissions and 1
      // active assignment per `lib/seed-raw/rbac.js`).
      const opsMatches = await screen.findAllByText(/ops_admin/i);
      fireEvent.click(opsMatches[0]!);
      const drawerBody = await screen.findByTestId('rbac-role-drawer-body');
      expect(drawerBody).toBeInTheDocument();
      // Counter chips rendered through the canonical projection seam — match
      // the displayed shape rather than exact counts (counts are seed-driven
      // and the projection helper computes from the rollup, not FE filter
      // .length).
      const permCount = await within(drawerBody).findByTestId(
        'rbac-role-drawer-permission-count',
      );
      expect(permCount.textContent).toMatch(/\d+ permissions/);
      const assignCount = within(drawerBody).getByTestId(
        'rbac-role-drawer-assignment-count',
      );
      expect(assignCount.textContent).toMatch(/\d+ assignees/);
      // Tier chip is sourced from metadata.tier projection (default
      // 'functional'; ops_admin metadata declares `tier: 'admin'`).
      const tierChip = within(drawerBody).getByTestId('rbac-role-drawer-tier');
      expect(tierChip.textContent).toMatch(/tier · /);
      // Organization label sourced from organizations.name via FK join.
      const orgLabel = within(drawerBody).queryByTestId(
        'rbac-role-drawer-org-label',
      );
      expect(orgLabel).not.toBeNull();
    });
  });
});
