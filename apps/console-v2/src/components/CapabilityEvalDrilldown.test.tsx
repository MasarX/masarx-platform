// CapabilityEvalDrilldown.test.tsx — verifies the per-capability "Why?"
// drilldown chip wires through the canonical
// `public.user_capability_eval_v1` RPC (defined in
// supabase/migrations/202601022113_access_control_policy_core.sql:764) and
// renders the override-ladder scope_path walk + role grants.
//
// Coverage (4+ scenarios per Phase E4 contract):
//   1. mount — chip + Why? button render before any RPC fires (lazy).
//   2. with-grant render — expanded panel shows allowed reason + role chip.
//   3. without-grant render — expanded panel shows denied reason.
//   4. click-to-expand — toggle calls the evaluator and renders ladder.
//   5. capability gate — denied users see the lock chip (no RPC, no panel).
//   6. lazy fetch — RPC is NOT invoked until the operator opens the drawer.
//   7. SSOT shape — capability key + scope_path round-trip unchanged.

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { screen, fireEvent } from '@testing-library/react';
import { renderWithProviders } from '@/test/render';
import { CapabilityEvalDrilldown } from './CapabilityEvalDrilldown';
import * as queries from '@/lib/queries';
import type { UserCapabilityEvalResult } from '@/lib/api';

// Build a deterministic evaluator payload mirroring the canonical
// `user_capability_eval_v1` SQL contract:
//   { allowed, reason, capability_key, scope_type, scope_id, role_keys,
//     granted_capabilities, policy_source: { settings_id, settings_version_id,
//     policy_scope_type, policy_scope_id, scope_path } }
function makeEval(overrides: Partial<UserCapabilityEvalResult> = {}): UserCapabilityEvalResult {
  return {
    allowed: true,
    reason: 'allowed_by_role',
    capability_key: 'shipments.read',
    scope_type: 'tenant',
    scope_id: 'org_rashed',
    role_keys: ['ops_admin'],
    granted_capabilities: ['shipments.read', 'shipments.write'],
    policy_source: {
      settings_id: 'set_acp_demo',
      settings_version_id: 'sv_acp_demo',
      policy_scope_type: 'tenant',
      policy_scope_id: 'org_rashed',
      scope_path: [
        { scope_type: 'tenant', scope_id: 'org_rashed' },
        { scope_type: 'global', scope_id: null },
      ],
    },
    ...overrides,
  };
}

interface MockEvalQueryShape {
  data: UserCapabilityEvalResult | undefined;
  isLoading: boolean;
  isSuccess: boolean;
  isError: boolean;
  error?: Error;
}

function mockEval(payload?: UserCapabilityEvalResult, opts: Partial<MockEvalQueryShape> = {}) {
  // Cast through the structural shape the component reads (`evalQuery.data`
  // + isLoading/isError). Mirrors the same pattern used in access.test.tsx
  // for `useResolveAccessPolicy`.
  vi.spyOn(queries, 'useUserCapabilityEval').mockReturnValue({
    data: payload,
    isLoading: opts.isLoading ?? false,
    isSuccess: !!payload,
    isError: opts.isError ?? false,
    error: opts.error,
  } as unknown as ReturnType<typeof queries.useUserCapabilityEval>);
}

describe('CapabilityEvalDrilldown', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  // ---------------------------------------------------------------------------
  // 1. mount — chip + Why? button render before any RPC fires.
  // ---------------------------------------------------------------------------
  it('renders the granted chip + Why? toggle on mount', () => {
    mockEval(makeEval());
    renderWithProviders(
      <CapabilityEvalDrilldown userId="usr_demo" capabilityKey="shipments.read" />,
      { capabilities: ['access_policy.read', 'shipments.read'] },
    );
    // Wrapper visible.
    expect(screen.getByTestId('capability-eval-shipments.read')).toBeInTheDocument();
    // Why? toggle visible (collapsed by default).
    const toggle = screen.getByTestId('capability-eval-shipments.read-toggle');
    expect(toggle).toBeInTheDocument();
    expect(toggle.getAttribute('aria-expanded')).toBe('false');
    // Cheap-path "granted" chip is visible BEFORE expansion.
    const wrapper = screen.getByTestId('capability-eval-shipments.read');
    expect(wrapper.textContent).toMatch(/granted/i);
    // Panel is NOT yet rendered (lazy).
    expect(screen.queryByTestId('capability-eval-shipments.read-panel')).toBeNull();
  });

  // ---------------------------------------------------------------------------
  // 2. with-grant render — expanded panel shows allowed reason + role chip.
  // ---------------------------------------------------------------------------
  it('expanded panel renders allow reason + role chips + ladder for a granted capability', () => {
    mockEval(makeEval());
    renderWithProviders(
      <CapabilityEvalDrilldown
        userId="usr_demo"
        capabilityKey="shipments.read"
        defaultExpanded
      />,
      { capabilities: ['access_policy.read', 'shipments.read'] },
    );
    // Panel visible.
    const panel = screen.getByTestId('capability-eval-shipments.read-panel');
    expect(panel).toBeInTheDocument();
    // Access evidence is operator-labeled without exposing internal identifiers.
    expect(panel).toHaveTextContent(/Reason: Allowed By Role \(allowed_by_role\)/);
    expect(panel).toHaveTextContent(/Role: Ops Admin \(ops_admin\)/);
    expect(panel).toHaveTextContent(/Capability: Shipment Access/);
    // Ladder renders both scope_path steps.
    expect(screen.getByTestId('capability-eval-shipments.read-ladder')).toBeInTheDocument();
    expect(screen.getByTestId('capability-eval-shipments.read-ladder-step-tenant')).toBeInTheDocument();
    expect(screen.getByTestId('capability-eval-shipments.read-ladder-step-global')).toBeInTheDocument();
    expect(panel).toHaveTextContent(/Policy source: Recorded/);
    expect(panel).toHaveTextContent(/Policy set: Applied policy/);
    expect(panel).toHaveTextContent(/Policy revision: Recorded/);
  });

  // ---------------------------------------------------------------------------
  // 3. without-grant render — expanded panel shows denied reason.
  // ---------------------------------------------------------------------------
  it('expanded panel renders denied reason for a non-granted capability', () => {
    mockEval(
      makeEval({
        allowed: false,
        reason: 'denied_no_role_grant',
        capability_key: 'finance.write',
        granted_capabilities: ['shipments.read'],
        role_keys: ['sender_user'],
      }),
    );
    renderWithProviders(
      <CapabilityEvalDrilldown
        userId="usr_demo"
        capabilityKey="finance.write"
        defaultExpanded
      />,
      { capabilities: ['access_policy.read'] }, // operator can read policy but not finance.write
    );
    // Cheap-path chip says "denied".
    const wrapper = screen.getByTestId('capability-eval-finance.write');
    expect(wrapper.textContent).toMatch(/denied/i);
    // Panel renders the canonical reason.
    const panel = screen.getByTestId('capability-eval-finance.write-panel');
    expect(panel).toHaveTextContent(/Reason: Denied No Role Grant \(denied_no_role_grant\)/);
    // Role chip still surfaced (operator role under which the deny applies).
    expect(panel).toHaveTextContent(/Role: Sender User \(sender_user\)/);
  });

  // ---------------------------------------------------------------------------
  // 4. click-to-expand — toggle invokes evaluator + renders ladder.
  // ---------------------------------------------------------------------------
  it('click on Why? toggles aria-expanded and renders the ladder panel', () => {
    mockEval(makeEval());
    renderWithProviders(
      <CapabilityEvalDrilldown userId="usr_demo" capabilityKey="shipments.read" />,
      { capabilities: ['access_policy.read', 'shipments.read'] },
    );
    const toggle = screen.getByTestId('capability-eval-shipments.read-toggle');
    expect(toggle.getAttribute('aria-expanded')).toBe('false');
    // Panel not yet rendered.
    expect(screen.queryByTestId('capability-eval-shipments.read-panel')).toBeNull();

    fireEvent.click(toggle);

    // After click: aria-expanded flips and panel renders.
    expect(toggle.getAttribute('aria-expanded')).toBe('true');
    expect(screen.getByTestId('capability-eval-shipments.read-panel')).toBeInTheDocument();
    expect(screen.getByTestId('capability-eval-shipments.read-ladder')).toBeInTheDocument();

    // Second click collapses.
    fireEvent.click(toggle);
    expect(toggle.getAttribute('aria-expanded')).toBe('false');
    expect(screen.queryByTestId('capability-eval-shipments.read-panel')).toBeNull();
  });

  // ---------------------------------------------------------------------------
  // 5. capability gate — denied users see the lock chip; no RPC, no panel.
  // ---------------------------------------------------------------------------
  it('renders a lock chip when the operator lacks access_policy.read', () => {
    const spy = vi.spyOn(queries, 'useUserCapabilityEval').mockReturnValue({
      data: undefined,
      isLoading: false,
      isSuccess: false,
      isError: false,
    } as unknown as ReturnType<typeof queries.useUserCapabilityEval>);
    renderWithProviders(
      <CapabilityEvalDrilldown userId="usr_demo" capabilityKey="shipments.read" />,
      // No access_policy.read in the operator's capability list.
      { capabilities: ['shipments.read'] },
    );
    // Lock chip visible.
    expect(screen.getByTestId('capability-eval-shipments.read-denied')).toBeInTheDocument();
    // No toggle, no panel.
    expect(screen.queryByTestId('capability-eval-shipments.read-toggle')).toBeNull();
    expect(screen.queryByTestId('capability-eval-shipments.read-panel')).toBeNull();
    // The hook itself should be invoked (it always returns; the `enabled`
    // flag inside the hook prevents network traffic). We only assert that
    // we never reached the data path.
    spy.mockRestore();
  });

  // ---------------------------------------------------------------------------
  // 6. lazy fetch — RPC is NOT invoked until expanded (audit-driven; surface
  //    /platform/access renders ~60 capabilities so eager fetch is forbidden).
  // ---------------------------------------------------------------------------
  it('does not invoke the evaluator hook with enabled=true until expanded', () => {
    const spy = vi.spyOn(queries, 'useUserCapabilityEval').mockReturnValue({
      data: undefined,
      isLoading: false,
      isSuccess: false,
      isError: false,
    } as unknown as ReturnType<typeof queries.useUserCapabilityEval>);
    renderWithProviders(
      <CapabilityEvalDrilldown userId="usr_demo" capabilityKey="shipments.read" />,
      { capabilities: ['access_policy.read', 'shipments.read'] },
    );
    // The hook is called on every render but with `enabled=false` while the
    // panel is collapsed. Inspect the last call to confirm.
    const lastCall = spy.mock.calls[spy.mock.calls.length - 1];
    // Signature: (capability_key, scope_type, scope_id, enabled, user_id)
    expect(lastCall?.[0]).toBe('shipments.read');
    expect(lastCall?.[3]).toBe(false);
    expect(lastCall?.[4]).toBe('usr_demo');

    // Click expands; subsequent call passes enabled=true.
    fireEvent.click(screen.getByTestId('capability-eval-shipments.read-toggle'));
    const afterCall = spy.mock.calls[spy.mock.calls.length - 1];
    expect(afterCall?.[3]).toBe(true);
    expect(afterCall?.[4]).toBe('usr_demo');

    spy.mockRestore();
  });

  it('uses knownAllowed for target-user chips instead of current-operator capabilities', () => {
    mockEval(
      makeEval({
        allowed: false,
        reason: 'missing_capability',
        capability_key: 'integration_plugins.write',
        role_keys: ['tenant_integrations_approver'],
        granted_capabilities: [
          'integration_plugins.read',
          'integration_plugins.test',
          'integration_plugins.approve',
          'integration_plugins.activate',
        ],
      }),
    );
    renderWithProviders(
      <CapabilityEvalDrilldown
        userId="usr_plugin_approver"
        capabilityKey="integration_plugins.write"
        knownAllowed={false}
        defaultExpanded
      />,
      { capabilities: ['access_policy.read', 'integration_plugins.write'] },
    );

    const wrapper = screen.getByTestId('capability-eval-integration_plugins.write');
    expect(wrapper.textContent).toMatch(/denied/i);
    const panel = screen.getByTestId('capability-eval-integration_plugins.write-panel');
    expect(panel).toHaveTextContent(/Reason: Missing Capability \(missing_capability\)/);
    expect(panel).toHaveTextContent(/Role: Tenant Integrations Approver \(tenant_integrations_approver\)/);
  });

  // ---------------------------------------------------------------------------
  // 7. loading state — when expanded but data is still loading.
  // ---------------------------------------------------------------------------
  it('renders an "Evaluating…" hint while the evaluator is loading', () => {
    mockEval(undefined, { isLoading: true });
    renderWithProviders(
      <CapabilityEvalDrilldown
        userId="usr_demo"
        capabilityKey="shipments.read"
        defaultExpanded
      />,
      { capabilities: ['access_policy.read', 'shipments.read'] },
    );
    expect(screen.getByTestId('capability-eval-shipments.read-loading')).toBeInTheDocument();
    expect(screen.queryByTestId('capability-eval-shipments.read-ladder')).toBeNull();
  });

  // ---------------------------------------------------------------------------
  // 8. error state — when the evaluator fails (e.g. network/auth error).
  // ---------------------------------------------------------------------------
  it('renders an error hint when the evaluator query fails', () => {
    mockEval(undefined, {
      isLoading: false,
      isError: true,
      error: new Error('eval RPC unreachable'),
    });
    renderWithProviders(
      <CapabilityEvalDrilldown
        userId="usr_demo"
        capabilityKey="shipments.read"
        defaultExpanded
      />,
      { capabilities: ['access_policy.read', 'shipments.read'] },
    );
    const errorEl = screen.getByTestId('capability-eval-shipments.read-error');
    expect(errorEl).toBeInTheDocument();
    expect(errorEl).toHaveTextContent(/Access details could not be loaded/i);
    expect(errorEl.textContent).not.toMatch(/eval RPC unreachable/);
  });

  // ---------------------------------------------------------------------------
  // 9. SSOT — capability key + ladder steps round-trip through the canonical
  //    payload unchanged (no surface synthesis).
  // ---------------------------------------------------------------------------
  it('renders capability and scope path as operator-facing labels', () => {
    mockEval(
      makeEval({
        capability_key: 'audit_log.read',
        policy_source: {
          settings_id: 'set_x',
          settings_version_id: 'sv_x',
          policy_scope_type: 'client',
          policy_scope_id: 'cli_42',
          scope_path: [
            { scope_type: 'client', scope_id: 'cli_42' },
            { scope_type: 'tenant', scope_id: 'org_rashed' },
            { scope_type: 'global', scope_id: null },
          ],
        },
      }),
    );
    renderWithProviders(
      <CapabilityEvalDrilldown
        userId="usr_demo"
        capabilityKey="audit_log.read"
        defaultExpanded
      />,
      { capabilities: ['access_policy.read', 'audit_log.read'] },
    );
    const panel = screen.getByTestId('capability-eval-audit_log.read-panel');
    expect(panel).toHaveTextContent(/Audit Activity/);
    expect(panel.textContent).not.toMatch(/audit_log\.read|scope_id=cli_42|scope_id=org_rashed/);
    expect(panel).toHaveTextContent(/Selected scope/);
    expect(panel).toHaveTextContent(/Global policy/);
    // All three ladder steps render (most-specific -> root).
    expect(screen.getByTestId('capability-eval-audit_log.read-ladder-step-client')).toBeInTheDocument();
    expect(screen.getByTestId('capability-eval-audit_log.read-ladder-step-tenant')).toBeInTheDocument();
    expect(screen.getByTestId('capability-eval-audit_log.read-ladder-step-global')).toBeInTheDocument();
  });
});
