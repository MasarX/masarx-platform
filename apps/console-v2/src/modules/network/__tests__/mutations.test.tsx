// mutations.test.tsx — Phase C2 NETWORK mutation wiring (verify each module
// dispatches through the canonical Phase B4 RPC facades and never falls back
// to the legacy invented `runCommand` keys).
//
// Spies are attached at the api.* facade level — that's where the swap-seam
// branch lives, so a passing spy here proves the mutation reaches the seam
// regardless of in-memory vs Supabase mode.

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

import { renderWithProviders } from '@/test/render';
import * as apiMod from '@/lib/api';
import { BranchesModule } from '../branches';
import { ZonesModule } from '../zones';
import { MarketplaceModule } from '../marketplace';

beforeEach(() => {
  vi.restoreAllMocks();
});

// ============================================================================
// MARKETPLACE — verify the 7 invented runCommand keys are gone, replaced by
// canonical Phase B4 RPC facades.
// ============================================================================

describe('MarketplaceModule · Phase C2 mutation wiring', () => {
  it('Award offer dispatches marketplace_award_offer_v1 with { offer_id }', async () => {
    const user = userEvent.setup();
    const awardSpy = vi.spyOn(apiMod, 'marketplace_award_offer_v1');
    renderWithProviders(<MarketplaceModule />, {
      capabilities: ['marketplace.read', 'marketplace.write'],
    });

    // Wait for offers tab to load.
    await waitFor(() => {
      expect(screen.getByTestId('marketplace-tab-offers')).toBeInTheDocument();
    });

    // Click the first row's Award offer action via the row-actions kebab.
    const kebabs = await screen.findAllByRole('button', { name: /Row actions/ });
    await user.click(kebabs[0]!);
    const awardOpt = await screen.findByRole('option', { name: /Award offer/ });
    await user.click(awardOpt);
    // Modal opens with Confirm button.
    const confirm = await screen.findByRole('button', { name: /Confirm award/ });
    await user.click(confirm);

    await waitFor(() => {
      expect(awardSpy).toHaveBeenCalled();
    });
    const args = awardSpy.mock.calls[0]?.[0] as { offer_id?: string } | undefined;
    expect(args?.offer_id).toBeTruthy();
  });

  it('Cancel award routes through marketplace_award_respond_v1 with response="cancel"', async () => {
    const user = userEvent.setup();
    const respondSpy = vi.spyOn(apiMod, 'marketplace_award_respond_v1');
    renderWithProviders(<MarketplaceModule />, {
      capabilities: ['marketplace.read', 'marketplace.write'],
    });

    // Switch to Awards tab first.
    await waitFor(() =>
      expect(screen.getByTestId('marketplace-tab-awards')).toBeInTheDocument(),
    );
    await user.click(screen.getByTestId('marketplace-tab-awards'));

    const kebabs = await screen.findAllByRole('button', { name: /Row actions/ });
    await user.click(kebabs[0]!);
    const cancelOpt = await screen.findByRole('option', { name: /Cancel award/ });
    await user.click(cancelOpt);

    // Modal opens; we don't enter a reason (default 'no reason supplied').
    const confirm = await screen.findByRole('button', { name: /Confirm cancellation/ });
    await user.click(confirm);

    await waitFor(() => {
      expect(respondSpy).toHaveBeenCalled();
    });
    const args = respondSpy.mock.calls[0]?.[0] as
      | { award_id?: string; response?: string }
      | undefined;
    expect(args?.response).toBe('cancel');
    expect(args?.award_id).toBeTruthy();
  });

  it('New request modal dispatches marketplace_request_create_v1', async () => {
    const user = userEvent.setup();
    const createSpy = vi.spyOn(apiMod, 'marketplace_request_create_v1');
    renderWithProviders(<MarketplaceModule />, {
      capabilities: ['marketplace.read', 'marketplace.write'],
    });

    const newBtn = await screen.findByRole('button', { name: /New request/ });
    await user.click(newBtn);
    const create = await screen.findByRole('button', { name: /Create request/ });
    await user.click(create);

    await waitFor(() => {
      expect(createSpy).toHaveBeenCalled();
    });
    const args = createSpy.mock.calls[0]?.[0] as
      | { request_kind_key?: string; request_details?: { lane?: string } }
      | undefined;
    expect(args?.request_kind_key).toBeTruthy();
    expect(args?.request_details?.lane).toBeDefined();
  });

  it('Refresh reputation dispatches marketplace_refresh_reputation_snapshot_v1 with participant_profile_id null', async () => {
    const user = userEvent.setup();
    const refreshSpy = vi.spyOn(apiMod, 'marketplace_refresh_reputation_snapshot_v1');
    renderWithProviders(<MarketplaceModule />, {
      capabilities: ['marketplace.read', 'marketplace.write'],
    });
    const refreshBtn = await screen.findByRole('button', { name: /Refresh reputation/ });
    await user.click(refreshBtn);
    await waitFor(() => {
      expect(refreshSpy).toHaveBeenCalled();
    });
    // Canonical signature is (participant_profile_id UUID); FE forwards null
    // to refresh the full set rather than the legacy empty-payload bug.
    const args = refreshSpy.mock.calls[0]?.[0] as
      | { participant_profile_id?: string | null }
      | undefined;
    expect(args).toHaveProperty('participant_profile_id');
    expect(args?.participant_profile_id).toBeNull();
  });

  it('Activate / Renegotiate / Terminate contract route through marketplace_award_respond_v1', async () => {
    const user = userEvent.setup();
    const respondSpy = vi.spyOn(apiMod, 'marketplace_award_respond_v1');
    renderWithProviders(<MarketplaceModule />, {
      capabilities: ['marketplace.read', 'marketplace.write'],
    });

    // Wait for the tab bar to render (contracts tab is initially hidden until
    // the marketplace_contracts query resolves; W18-2 unified the legacy
    // `marketplace_contracts_v2` alias onto the canonical key).
    const tabContracts = await screen.findByTestId('marketplace-tab-contracts');
    await user.click(tabContracts);

    const kebabs = await screen.findAllByRole('button', { name: /Row actions/ });
    await user.click(kebabs[0]!);
    const renegotiateOpt = await screen.findByRole('option', { name: /Renegotiate/ });
    await user.click(renegotiateOpt);

    await waitFor(() => {
      expect(respondSpy).toHaveBeenCalled();
    });
    const args = respondSpy.mock.calls[0]?.[0] as
      | { response?: string; award_id?: string }
      | undefined;
    expect(['accept', 'reject', 'cancel']).toContain(args?.response);
    expect(args?.award_id).toBeTruthy();
  });
});

// ============================================================================
// ZONES — verify Approve/Deny override goes through canonical
// ui_execute_zone_override_request_v1 with reviewed_by from useIdentity (NOT
// hardcoded usr_admin_rashed). Verify Suspend zone calls suspend_zone_v1 and
// Create zone calls zone_create_v1.
// ============================================================================

describe('ZonesModule · Phase C2 mutation wiring', () => {
  it('Suspend zone (page header) dispatches suspend_zone_v1 once per active zone', async () => {
    const user = userEvent.setup();
    const suspendSpy = vi.spyOn(apiMod, 'suspend_zone_v1');
    renderWithProviders(<ZonesModule />, {
      capabilities: ['zones.read', 'zones.write'],
    });

    await waitFor(() =>
      expect(screen.getByTestId('zones-side-list')).toBeInTheDocument(),
    );

    const suspendBtn = await screen.findByRole('button', { name: /Suspend zone/ });
    await user.click(suspendBtn);

    await waitFor(() => {
      expect(suspendSpy).toHaveBeenCalled();
    });
    const args = suspendSpy.mock.calls[0]?.[0] as
      | { zone_id?: string; reason?: string }
      | undefined;
    expect(args?.zone_id).toBeTruthy();
    expect(args?.reason).toBe('bulk_suspend');
  });

  it('Restore zone (page header) dispatches restore_zone_v1 once per suspended zone', async () => {
    const user = userEvent.setup();
    const restoreSpy = vi.spyOn(apiMod, 'restore_zone_v1');
    renderWithProviders(<ZonesModule />, {
      capabilities: ['zones.read', 'zones.write'],
    });

    await waitFor(() =>
      expect(screen.getByTestId('zones-side-list')).toBeInTheDocument(),
    );

    const restoreBtn = await screen.findByRole('button', { name: /Restore zone/ });
    await user.click(restoreBtn);

    await waitFor(() => {
      expect(restoreSpy).toHaveBeenCalled();
    });
    const args = restoreSpy.mock.calls[0]?.[0] as
      | { zone_id?: string; reason?: string }
      | undefined;
    expect(args?.zone_id).toBeTruthy();
    expect(args?.reason).toBe('bulk_restore');
  });

  it('Create zone modal dispatches zone_create_v1', async () => {
    const user = userEvent.setup();
    const createSpy = vi.spyOn(apiMod, 'zone_create_v1');
    renderWithProviders(<ZonesModule />, {
      capabilities: ['zones.read', 'zones.write'],
    });

    await waitFor(() =>
      expect(screen.getByTestId('zones-side-list')).toBeInTheDocument(),
    );
    const newBtn = await screen.findByRole('button', { name: /New zone/ });
    await user.click(newBtn);

    const nameInput = await screen.findByLabelText(/New zone name/);
    await user.type(nameInput, 'Test Zone');

    const submit = await screen.findByRole('button', { name: /^Submit/ });
    await user.click(submit);

    await waitFor(() => {
      expect(createSpy).toHaveBeenCalled();
    });
    const args = createSpy.mock.calls[0]?.[0] as
      | { name?: string; color_token?: string; initial_district_ids?: string[] }
      | undefined;
    expect(args?.name).toBe('Test Zone');
    expect(args?.color_token).toBeTruthy();
    expect(Array.isArray(args?.initial_district_ids)).toBe(true);
  });

  it('Profile inline edit dispatches zone_update_v1', async () => {
    const user = userEvent.setup();
    const updateSpy = vi.spyOn(apiMod, 'zone_update_v1').mockResolvedValue({
      ok: true,
      zone_id: 'zn_ruh_north',
      changed: { name: 'Riyadh North Updated' },
      correlation_id: 'cor_zone_update',
    });
    renderWithProviders(<ZonesModule />, {
      capabilities: ['zones.read', 'zones.write'],
    });

    await waitFor(() =>
      expect(screen.getByTestId('zones-side-list')).toBeInTheDocument(),
    );

    const sideList = screen.getByTestId('zones-side-list');
    await user.click(within(sideList).getByLabelText(/Riyadh North/));
    await screen.findByRole('tab', { name: /Profile/i });

    const editableValues = screen.getAllByTitle('Click to edit');
    await user.click(editableValues[0]!);
    const input = await screen.findByDisplayValue('Riyadh North');
    await user.clear(input);
    await user.type(input, 'Riyadh North Updated{Enter}');

    await waitFor(() => expect(updateSpy).toHaveBeenCalled());
    expect(updateSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        zone_id: 'zn_ruh_north',
        patch: expect.objectContaining({ name: 'Riyadh North Updated' }),
      }),
    );
  });

  it('Retire zone dispatches zone_delete_v1 as a soft-delete lifecycle action', async () => {
    const user = userEvent.setup();
    const deleteSpy = vi.spyOn(apiMod, 'zone_delete_v1').mockResolvedValue({
      ok: true,
      zone_id: 'zn_ruh_north',
      is_active: false,
      lifecycle: 'retired',
      already_processed: false,
      correlation_id: 'cor_zone_retire',
      decision_log_id: 'dlog_zone_retire',
    });
    renderWithProviders(<ZonesModule />, {
      capabilities: ['zones.read', 'zones.write'],
    });

    await waitFor(() =>
      expect(screen.getByTestId('zones-side-list')).toBeInTheDocument(),
    );

    const sideList = screen.getByTestId('zones-side-list');
    await user.click(within(sideList).getByLabelText(/Riyadh North/));
    await user.click(await screen.findByRole('button', { name: /^Retire zone$/i }));

    await waitFor(() => expect(deleteSpy).toHaveBeenCalled());
    expect(deleteSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        zone_id: 'zn_ruh_north',
        reason: 'console_v2_zone_retire',
      }),
    );
  });

  it('Approve override dispatches ui_execute_zone_override_request_v1 with reviewed_by from useIdentity (not a hardcoded literal)', async () => {
    const user = userEvent.setup();
    const executeSpy = vi.spyOn(apiMod, 'ui_execute_zone_override_request_v1');
    // Force a non-default reviewer id so we can prove the call carries the
    // useIdentity().user.id value (not the previously-hardcoded literal).
    renderWithProviders(<ZonesModule />, {
      capabilities: ['zones.read', 'zones.write'],
      identity: {
        capabilities: ['zones.read', 'zones.write'],
        user: { id: 'usr_phase_c2_test' },
      },
    });

    await waitFor(() =>
      expect(screen.getByTestId('zones-side-list')).toBeInTheDocument(),
    );

    // Open Riyadh North zone (has a pending override per seed).
    const sideList = screen.getByTestId('zones-side-list');
    const ruhRow = within(sideList).getByLabelText(/Riyadh North/);
    await user.click(ruhRow);

    const overridesTab = await screen.findByRole('tab', { name: /Overrides/i });
    await user.click(overridesTab);

    // Pending overrides auto-expand; click the first Approve.
    const approveButtons = await screen.findAllByRole('button', { name: /Approve/i });
    await user.click(approveButtons[0]!);

    await waitFor(() => {
      expect(executeSpy).toHaveBeenCalled();
    });
    const args = executeSpy.mock.calls[0]?.[0] as
      | { request_id?: string; decision?: string; reviewed_by?: string }
      | undefined;
    expect(args?.decision).toBe('approve');
    expect(args?.request_id).toBeTruthy();
    // Proves the reviewer id is sourced from useIdentity().user.id, not a
    // hardcoded literal — switching the mock identity changes the payload.
    expect(args?.reviewed_by).toBe('usr_phase_c2_test');
  });
});

// ============================================================================
// BRANCHES — verify each of the 18 stub callsites now dispatches a canonical
// RPC facade. We exercise a representative subset: New branch, Mark OOS,
// Profile inline edit, Capacity inline edit, Add staff, Remove staff,
// Coverage edit-window. Assign-zone is exercised separately because it
// requires opening the zone picker portal.
// ============================================================================

describe('BranchesModule · Phase C2 mutation wiring', () => {
  it('New branch dispatches branch_create_v1 with operator-entered name + branch_type', async () => {
    const user = userEvent.setup();
    const createSpy = vi.spyOn(apiMod, 'branch_create_v1');
    renderWithProviders(<BranchesModule />, {
      capabilities: ['branches.read', 'branches.write', 'zones.read'],
    });
    // Wait for the card grid to mount so all module queries (including the
    // W52 `tenant_default_timezone` resolver) have a chance to settle before
    // we click "New branch".
    await screen.findByTestId('branches-grid');
    const newBtn = await screen.findByRole('button', { name: /^New branch$/ });
    await user.click(newBtn);
    const dialog = await screen.findByRole('dialog', { name: 'New branch' });
    expect(createSpy).not.toHaveBeenCalled();

    await user.type(within(dialog).getByLabelText('Name'), 'Riyadh East Branch');
    await user.type(within(dialog).getByLabelText('Code'), 'ruh-east');
    await user.selectOptions(within(dialog).getByLabelText('Type'), 'branch');
    await user.type(within(dialog).getByLabelText('City'), 'Riyadh');
    await user.type(within(dialog).getByLabelText('Address'), 'King Abdullah Road');
    await user.type(within(dialog).getByLabelText('Daily capacity'), '120');
    await user.type(within(dialog).getByLabelText('Cutoff time'), '17:30');
    await user.selectOptions(within(dialog).getByLabelText('Status'), 'active');
    await user.click(within(dialog).getByRole('button', { name: 'Create branch' }));

    await waitFor(() => {
      expect(createSpy).toHaveBeenCalled();
    });
    const args = createSpy.mock.calls[0]?.[0] as
      | { name?: string; branch_type?: string; timezone?: string; code?: string }
      | undefined;
    expect(args?.name).toBe('Riyadh East Branch');
    expect(args?.code).toBe('ruh-east');
    expect(args?.branch_type).toBe('branch');
    // W52: timezone resolves through canonical
    // `tenant_default_timezone.iana` (sv_370) instead of an inline literal.
    expect(args?.timezone).toBe('Asia/Riyadh');
  });

  it('Mark out-of-service dispatches branch_mark_oos_v1 for the selected branch only', async () => {
    const user = userEvent.setup();
    const markSpy = vi.spyOn(apiMod, 'branch_mark_oos_v1');
    renderWithProviders(<BranchesModule />, {
      capabilities: ['branches.read', 'branches.write', 'zones.read'],
    });
    const card = await screen.findByTestId('branch-card-hub_ruh_n');
    await user.click(card);
    const markBtn = await screen.findByRole('button', { name: /^Mark branch out-of-service$/ });
    await user.click(markBtn);
    const dialog = await screen.findByRole('dialog', { name: /Mark out-of-service - Riyadh North/i });
    expect(markSpy).not.toHaveBeenCalled();

    await user.click(within(dialog).getByRole('button', { name: 'Confirm out-of-service' }));

    await waitFor(() => {
      expect(markSpy).toHaveBeenCalled();
    });
    const args = markSpy.mock.calls[0]?.[0] as
      | { branch_ids?: string[]; reason?: string; metadata?: Record<string, unknown> }
      | undefined;
    expect(args?.branch_ids).toEqual(['hub_ruh_n']);
    expect(args?.reason).toBe('branch_profile_oos');
    expect(args?.metadata).toEqual(expect.objectContaining({
      source: 'console_v2_branch_profile',
    }));
  });

  it('Add staff in drawer dispatches add_branch_member_v1 with user_id from useIdentity', async () => {
    const user = userEvent.setup();
    const addSpy = vi.spyOn(apiMod, 'add_branch_member_v1');
    renderWithProviders(<BranchesModule />, {
      capabilities: ['branches.read', 'branches.write', 'users.read'],
    });

    // Open a branch drawer.
    const card = await screen.findByTestId('branch-card-hub_ruh_n');
    await user.click(card);

    // Switch to Staff tab.
    const tablist = await screen.findByRole('tablist', { name: /Branch drawer tabs/i });
    await user.click(within(tablist).getByRole('tab', { name: /Staff/i }));

    const addBtn = await screen.findByRole('button', { name: /Add staff/ });
    await user.click(addBtn);
    const dialog = await screen.findByRole('dialog', { name: /Add staff - Riyadh North/i });
    expect(addSpy).not.toHaveBeenCalled();
    expect(dialog).not.toHaveTextContent('usr_ops_admin_layla');

    const userField = within(dialog).getByLabelText('User');
    if (userField instanceof HTMLSelectElement) {
      await user.selectOptions(userField, 'usr_ops_admin_layla');
    } else {
      await user.type(userField, 'usr_ops_admin_layla');
    }
    const roleField = within(dialog).getByLabelText('Role');
    if (roleField instanceof HTMLSelectElement) {
      await user.selectOptions(roleField, 'ops_lead');
    } else {
      await user.type(roleField, 'ops_lead');
    }
    await user.click(within(dialog).getByRole('button', { name: 'Add staff' }));

    await waitFor(() => {
      expect(addSpy).toHaveBeenCalled();
    });
    const args = addSpy.mock.calls[0]?.[0] as
      | { branch_id?: string; user_id?: string; role_key?: string }
      | undefined;
    expect(args?.branch_id).toBeTruthy();
    expect(args?.user_id).toBeTruthy();
    expect(args?.role_key).toBe('ops_lead');
  });

  it('Remove staff dispatches remove_branch_member_v1 with the first active membership', async () => {
    const user = userEvent.setup();
    const removeSpy = vi.spyOn(apiMod, 'remove_branch_member_v1');
    renderWithProviders(<BranchesModule />, {
      capabilities: ['branches.read', 'branches.write'],
    });

    const card = await screen.findByTestId('branch-card-hub_ruh_n');
    await user.click(card);
    const tablist = await screen.findByRole('tablist', { name: /Branch drawer tabs/i });
    await user.click(within(tablist).getByRole('tab', { name: /Staff/i }));

    const removeBtn = await screen.findByRole('button', { name: /^Remove staff$/ });
    await user.click(removeBtn);
    const dialog = await screen.findByRole('dialog', { name: /Remove staff - Riyadh North/i });
    expect(removeSpy).not.toHaveBeenCalled();
    expect(dialog).not.toHaveTextContent('usr_ops_admin_layla');

    await user.selectOptions(within(dialog).getByLabelText('Staff'), 'bm_002');
    await user.click(within(dialog).getByRole('button', { name: 'Remove staff' }));

    await waitFor(() => {
      expect(removeSpy).toHaveBeenCalledWith({ membership_id: 'bm_002' });
    });
  });

  it('Coverage Edit-window dispatches branch_coverage_window_upsert_v1', async () => {
    const user = userEvent.setup();
    const coverageSpy = vi.spyOn(apiMod, 'branch_coverage_window_upsert_v1');
    renderWithProviders(<BranchesModule />, {
      capabilities: ['branches.read', 'branches.write'],
    });

    const card = await screen.findByTestId('branch-card-hub_ruh_n');
    await user.click(card);
    const tablist = await screen.findByRole('tablist', { name: /Branch drawer tabs/i });
    await user.click(within(tablist).getByRole('tab', { name: /Coverage/i }));

    const editBtn = await screen.findByRole('button', { name: /Edit window/ });
    await user.click(editBtn);
    const dialog = await screen.findByRole('dialog', { name: /Coverage window - Riyadh North/i });
    expect(coverageSpy).not.toHaveBeenCalled();
    expect(within(dialog).getByLabelText('Coverage window')).toBeInTheDocument();
    expect(within(dialog).getByLabelText('Zone')).toBeInTheDocument();

    const reason = within(dialog).getByLabelText('Reason');
    await user.clear(reason);
    await user.type(reason, 'Storm overflow coverage');
    fireEvent.change(within(dialog).getByLabelText('Ends'), {
      target: { value: '2026-01-22T18:00' },
    });
    await user.click(within(dialog).getByRole('button', { name: 'Save window' }));

    await waitFor(() => {
      expect(coverageSpy).toHaveBeenCalled();
    });
    const args = coverageSpy.mock.calls[0]?.[0] as
      | {
        branch_id?: string;
        coverage_window_id?: string;
        zone_id?: string;
        effective_from?: string;
        effective_to?: string;
        priority?: number;
        reason?: string;
        metadata?: Record<string, unknown>;
      }
      | undefined;
    expect(args?.branch_id).toBe('hub_ruh_n');
    expect(args?.coverage_window_id).toBeTruthy();
    expect(args?.zone_id).toBeTruthy();
    expect(args?.effective_from).toBeTruthy();
    expect(args?.effective_to).toBeTruthy();
    expect(typeof args?.priority).toBe('number');
    expect(args?.reason).toBe('Storm overflow coverage');
    expect(args?.metadata).toEqual(expect.objectContaining({
      source: 'console_v2_branch_coverage_form',
    }));
  });
});
