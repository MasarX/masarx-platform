// SessionsList.test.tsx — covers the reusable Phase E2 sessions roster.
//
// Coverage anchors (≥ 4)
//   1. Mounts and renders rows for the supplied user_id (own-sessions tab).
//   2. With no userId, renders every session in scope (admin tab).
//   3. Capability gate: caller without `users.read` sees the denied state.
//      Caller with `users.read` but without `users.manage` sees a capability
//      lock instead of a Revoke button.
//   4. Happy revoke: clicking Revoke fires `revoke_session_v1` with the
//      canonical `{target_user_id, session_id}` payload, and the same row
//      updates with revocation readback on the next list refetch.
//   5. Failure mode: when the underlying mutation rejects, the row stays
//      visible and a danger toast surfaces (no silent failure).

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { renderWithProviders } from '@/test/render';
import { SessionsList } from './SessionsList';
import * as apiMod from '@/lib/api';
import { clearToasts, getToasts } from './toastStore';

const TEST_USER_ID = 'usr_admin_rashed';
const OTHER_USER_ID = 'usr_acct_mgr_omar';

const DEFAULT_SESSION_ROWS: apiMod.UserSessionRow[] = [
  {
    id: 'ssn_8a3c1f04-0001-4000-8000-000000000001',
    user_id: TEST_USER_ID,
    user_email: 'rashed@rashed-logistics.example',
    user_agent: 'Chrome Test',
    ip: '127.0.0.1',
    aal: 'aal2',
    updated_at: new Date().toISOString(),
    is_current: true,
  },
  {
    id: 'ssn_8a3c1f04-0003-4000-8000-000000000004',
    user_id: OTHER_USER_ID,
    user_email: 'omar@rashed-logistics.example',
    user_agent: 'Chrome Test',
    ip: '127.0.0.1',
    aal: 'aal2',
    updated_at: new Date().toISOString(),
  },
];

function mockSessionList(rows: apiMod.UserSessionRow[] = DEFAULT_SESSION_ROWS) {
  return vi.spyOn(apiMod, 'ui_list_user_sessions_v1').mockImplementation(async (targetUserId, limit) => {
    const scoped = targetUserId ? rows.filter((row) => row.user_id === targetUserId) : rows;
    return {
      rows: scoped,
      total: scoped.length,
      page: 0,
      page_size: limit ?? 50,
    };
  });
}

afterEach(() => {
  vi.restoreAllMocks();
  clearToasts();
});

describe('components/SessionsList — render contract', () => {
  it('mounts and renders rows for the supplied userId (own-sessions tab)', async () => {
    mockSessionList();
    renderWithProviders(<SessionsList userId={TEST_USER_ID} />, {
      capabilities: ['users.read', 'users.manage'],
    });
    // Rows for the requested user appear once the query resolves.
    await waitFor(() => {
      expect(
        screen.getByTestId('sessions-list-item-ssn_8a3c1f04-0001-4000-8000-000000000001'),
      ).toBeInTheDocument();
    });
    // The "Current" chip is rendered for the active session and the user
    // email is shown alongside the row metadata.
    expect(screen.getByText('Current')).toBeInTheDocument();
    expect(screen.getAllByText('rashed@rashed-logistics.example').length).toBeGreaterThan(0);
    // Sessions belonging to other users are not rendered when userId is set.
    expect(
      screen.queryByTestId('sessions-list-item-ssn_8a3c1f04-0003-4000-8000-000000000004'),
    ).toBeNull();
  });

  it('renders every session when userId is omitted (admin tab)', async () => {
    mockSessionList();
    renderWithProviders(<SessionsList />, {
      capabilities: ['users.read', 'users.manage'],
    });
    // Rows from the seed for *any* user are visible. Pick one each from two
    // different users.
    await waitFor(() => {
      expect(
        screen.getByTestId('sessions-list-item-ssn_8a3c1f04-0001-4000-8000-000000000001'),
      ).toBeInTheDocument();
    });
    expect(
      screen.getByTestId('sessions-list-item-ssn_8a3c1f04-0003-4000-8000-000000000004'),
    ).toBeInTheDocument();
  });
});

describe('components/SessionsList — capability gating', () => {
  it('shows the denied state when the caller lacks users.read', async () => {
    renderWithProviders(<SessionsList userId={TEST_USER_ID} />, {
      capabilities: [], // no users.read
    });
    // Surface stays mounted, but the body is the canonical denied state.
    expect(screen.getByTestId('sessions-list')).toBeInTheDocument();
    // CapabilityLock chip carries the missing permission label without exposing the raw key.
    expect(screen.getByText('User Access permission required')).toBeInTheDocument();
    expect(screen.queryByText('users.read')).toBeNull();
  });

  it('hides the Revoke button when the caller has users.read but not users.manage', async () => {
    mockSessionList();
    renderWithProviders(<SessionsList userId={TEST_USER_ID} />, {
      capabilities: ['users.read'],
    });
    await waitFor(() => {
      expect(
        screen.getByTestId('sessions-list-item-ssn_8a3c1f04-0001-4000-8000-000000000001'),
      ).toBeInTheDocument();
    });
    // No Revoke button anywhere.
    expect(screen.queryByRole('button', { name: /^Revoke session/ })).toBeNull();
    // Lock chip surfaces the missing manage permission instead.
    expect(screen.getAllByText('User Management permission required').length).toBeGreaterThan(0);
    expect(screen.queryByText('users.manage')).toBeNull();
  });
});

describe('components/SessionsList — revoke flow', () => {
  // Cast to a loose unknown so the spy's mock.calls type widens — the narrow
  // signature emitted by `vi.spyOn` collides with the loose
  // `MockInstance<(this: unknown, ...args: unknown[]) => unknown>` type
  // when the module's export changes between minor versions. We assert against
  // recorded call args directly below.
  let revokeSpy: ReturnType<typeof vi.spyOn> & {
    mock: { calls: unknown[][] };
    mockRestore: () => void;
    mockResolvedValue: (value: unknown) => unknown;
    mockImplementation: (fn: (...args: unknown[]) => unknown) => unknown;
    mockRejectedValueOnce: (reason: unknown) => unknown;
  };

  beforeEach(() => {
    clearToasts();
    // Default to a successful canonical envelope. Tests can override per-call
    // via `revokeSpy.mockImplementationOnce(...)`.
    revokeSpy = vi.spyOn(apiMod, 'revoke_session_v1') as unknown as typeof revokeSpy;
    revokeSpy.mockResolvedValue({
      ok: true,
      revocation_audit_id: 'rva_test',
      target_user_id: TEST_USER_ID,
      status: 'pending',
      correlation_id: 'corr_test',
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
    clearToasts();
  });

  it('clicking Revoke fires revoke_session_v1 and refreshes pending revocation readback without remount', async () => {
    const user = userEvent.setup();
    const sessionId = 'ssn_8a3c1f04-0003-4000-8000-000000000004';
    let sessionRows: apiMod.UserSessionRow[] = [
      {
        id: sessionId,
        user_id: OTHER_USER_ID,
        user_email: 'omar@rashed-logistics.example',
        user_agent: 'Chrome Test',
        ip: '127.0.0.1',
        aal: 'aal2',
        updated_at: new Date().toISOString(),
      },
    ];
    const listSpy = vi.spyOn(apiMod, 'ui_list_user_sessions_v1').mockImplementation(async () => ({
      rows: sessionRows,
      total: sessionRows.length,
      page: 0,
      page_size: 50,
    }));
    revokeSpy.mockImplementation(async (args: unknown) => {
      const payload = args as { reason?: string };
      sessionRows = sessionRows.map((row) =>
        row.id === sessionId
          ? {
              ...row,
              revocation_status: 'pending',
              revocation_reason: payload.reason,
              revocation_requested_at: new Date().toISOString(),
            }
          : row,
      );
      return {
        ok: true,
        revocation_audit_id: 'rva_test',
        target_user_id: OTHER_USER_ID,
        status: 'pending',
        correlation_id: 'corr_test',
      };
    });
    renderWithProviders(<SessionsList userId={OTHER_USER_ID} />, {
      capabilities: ['users.read', 'users.manage'],
    });
    await waitFor(() => {
      expect(
        screen.getByTestId(`sessions-list-item-${sessionId}`),
      ).toBeInTheDocument();
    });
    expect(listSpy).toHaveBeenCalledWith(OTHER_USER_ID, 50);

    // Click the Revoke button on the first session row for OTHER_USER_ID.
    const revokeBtn = screen.getByLabelText(`Revoke session ${sessionId}`);
    await user.click(revokeBtn);
    const form = await screen.findByTestId(`sessions-list-revoke-form-${sessionId}`);
    await user.type(screen.getByLabelText(/Revocation reason/i), 'Security rotation');
    await user.click(within(form).getByRole('button', { name: /Confirm revoke/i }));

    await waitFor(() => {
      expect(revokeSpy).toHaveBeenCalledTimes(1);
    });
    const args = revokeSpy.mock.calls[0]?.[0] as
      | { target_user_id?: string; session_id?: string; reason?: string }
      | undefined;
    expect(args?.target_user_id).toBe(OTHER_USER_ID);
    expect(args?.session_id).toBe(sessionId);
    // A canonical revoke must also carry an audit reason for decision_log.
    expect(args?.reason).toBe('Security rotation');
    await waitFor(() => {
      expect(screen.getByTestId(`sessions-list-revocation-${sessionId}`)).toHaveTextContent('Revoke pending');
    });
    expect(screen.getByTestId(`sessions-list-revocation-${sessionId}`)).toHaveTextContent(
      /Security rotation/i,
    );
    expect(screen.getByRole('button', { name: 'Revoke pending' })).toBeDisabled();
  });

  it('surfaces a danger toast when revoke_session_v1 rejects (failure mode)', async () => {
    mockSessionList();
    revokeSpy.mockRejectedValueOnce(new Error('cross-tenant target rejected'));
    const user = userEvent.setup();
    renderWithProviders(<SessionsList userId={OTHER_USER_ID} />, {
      capabilities: ['users.read', 'users.manage'],
    });
    await waitFor(() => {
      expect(
        screen.getByTestId('sessions-list-item-ssn_8a3c1f04-0003-4000-8000-000000000004'),
      ).toBeInTheDocument();
    });
    const revokeBtn = screen.getByLabelText(
      'Revoke session ssn_8a3c1f04-0003-4000-8000-000000000004',
    );
    await user.click(revokeBtn);
    const form = await screen.findByTestId('sessions-list-revoke-form-ssn_8a3c1f04-0003-4000-8000-000000000004');
    await user.type(screen.getByLabelText(/Revocation reason/i), 'Security rotation');
    await user.click(within(form).getByRole('button', { name: /Confirm revoke/i }));

    await waitFor(() => {
      expect(revokeSpy).toHaveBeenCalled();
    });
    // The row remains in the list — no optimistic mutation on failure.
    expect(
      screen.getByTestId('sessions-list-item-ssn_8a3c1f04-0003-4000-8000-000000000004'),
    ).toBeInTheDocument();
    // The danger toast is queued through the global pub/sub store. The
    // <ToastRoot /> is not mounted in this test wrapper, so we assert
    // against the store directly.
    await waitFor(() => {
      const danger = getToasts().find((t) => t.tone === 'danger');
      expect(danger?.message).toMatch(/cross-tenant target rejected/);
    });
  });

  it('refetches session rows after a post-write revoke readback error', async () => {
    const user = userEvent.setup();
    const sessionId = 'ssn_8a3c1f04-0003-4000-8000-000000000004';
    let sessionRows: apiMod.UserSessionRow[] = [
      {
        id: sessionId,
        user_id: OTHER_USER_ID,
        user_email: 'omar@rashed-logistics.example',
        user_agent: 'Chrome Test',
        ip: '127.0.0.1',
        aal: 'aal2',
        updated_at: new Date().toISOString(),
      },
    ];
    const listSpy = vi.spyOn(apiMod, 'ui_list_user_sessions_v1').mockImplementation(async () => ({
      rows: sessionRows,
      total: sessionRows.length,
      page: 0,
      page_size: 50,
    }));
    revokeSpy.mockImplementationOnce(async (args: unknown) => {
      const payload = args as { reason?: string };
      sessionRows = sessionRows.map((row) =>
        row.id === sessionId
          ? {
              ...row,
              revocation_audit_id: 'rva_post_write_error',
              revocation_status: 'pending',
              revocation_reason: payload.reason,
              revocation_requested_at: new Date().toISOString(),
            }
          : row,
      );
      throw new Error('post-write security action readback timed out');
    });

    renderWithProviders(<SessionsList userId={OTHER_USER_ID} />, {
      capabilities: ['users.read', 'users.manage'],
    });
    const row = await screen.findByTestId(`sessions-list-item-${sessionId}`);
    await user.click(within(row).getByLabelText(`Revoke session ${sessionId}`));
    const form = await screen.findByTestId(`sessions-list-revoke-form-${sessionId}`);
    await user.type(within(form).getByLabelText(/Revocation reason/i), 'Security rotation');
    await user.click(within(form).getByRole('button', { name: /Confirm revoke/i }));

    await waitFor(() => expect(listSpy.mock.calls.length).toBeGreaterThanOrEqual(2));
    const updatedRow = await screen.findByTestId(`sessions-list-item-${sessionId}`);
    expect(updatedRow).toHaveTextContent('revoke pending');
    expect(within(updatedRow).getByTestId(`sessions-list-revocation-${sessionId}`))
      .toHaveTextContent('Security rotation');
    expect(screen.queryByTestId(`sessions-list-revoke-form-${sessionId}`)).toBeNull();
  });
});
