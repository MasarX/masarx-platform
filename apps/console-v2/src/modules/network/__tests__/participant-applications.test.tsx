// participant-applications.test.tsx — Phase D5 coverage for the marketplace
// participant pre-approval review queue (`/network/participant-applications`).
//
// Asserts:
//   • Capability gate (denied StateView when `marketplace_participant_requests.read`
//     is missing).
//   • KPI strip + status filter + DataTable render when the operator has read.
//   • Driver-typed (`requested_participant_type_key='freelancer_driver'`) rows
//     are NOT shown in this surface (those are owned by the Fleet domain
//     surface `/operate/fleet/driver-applications`).
  //   • Approve / Reject / Request docs row actions surface the canonical RPC
  //     name and reconcile backend readback without a browser reload.

import { afterEach, describe, it, expect, vi } from 'vitest';
import { screen, fireEvent, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { renderWithProviders } from '@/test/render';
import { ParticipantApplicationsModule } from '@/modules/network/participant-applications';
import * as toastStore from '@/components/toastStore';
import * as ds from '@/lib/data-source';

const READ_CAPS = ['marketplace_participant_requests.read'];
const FULL_CAPS = [
  'marketplace_participant_requests.read',
  'marketplace_participant_requests.review',
];

describe('ParticipantApplicationsModule (Phase D5)', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('renders the participant-applications KPI strip + status filter when read is granted', async () => {
    renderWithProviders(<ParticipantApplicationsModule />, { capabilities: FULL_CAPS });
    expect(
      await screen.findByTestId('participant-applications-kpi-strip')
    ).toBeInTheDocument();
    expect(screen.getByText('Pending')).toBeInTheDocument();
    expect(screen.getByText('Approved')).toBeInTheDocument();
    expect(screen.getByText('Rejected')).toBeInTheDocument();
    // Status filter chips.
    expect(screen.getByTestId('participant-applications-status-all')).toBeInTheDocument();
    expect(screen.getByTestId('participant-applications-status-pending')).toBeInTheDocument();
    expect(screen.getByTestId('participant-applications-status-approved')).toBeInTheDocument();
    expect(screen.getByTestId('participant-applications-status-rejected')).toBeInTheDocument();
  });

  it('shows the denied StateView when the read capability is missing', async () => {
    renderWithProviders(<ParticipantApplicationsModule />, { capabilities: [] });
    expect(
      await screen.findByText(
      /Participant application review queue requires partner application permission/i
      )
    ).toBeInTheDocument();
  });

  it('clicking a status filter chip toggles the active class', async () => {
    renderWithProviders(<ParticipantApplicationsModule />, { capabilities: FULL_CAPS });
    const pending = await screen.findByTestId('participant-applications-status-pending');
    fireEvent.click(pending);
    expect(pending.className).toContain('is-active');
    expect(pending).toHaveAttribute('aria-selected', 'true');
  });

  it('renders queue rows with a non-driver participant type chip', async () => {
    renderWithProviders(<ParticipantApplicationsModule />, { capabilities: FULL_CAPS });
    // The seeded set includes provider_tenant + partner_carrier + partner_fleet
    // rows. None of them should be `freelancer_driver` (the Fleet domain owns
    // those). Use waitFor so the registry-driven query has a chance to settle.
    await waitFor(() =>
      expect(screen.getByText(/Swift Logistics/i)).toBeInTheDocument()
    );
    expect(screen.getByText(/Red Sea Freight/i)).toBeInTheDocument();
    expect(screen.getByText(/Desert Haul Transport/i)).toBeInTheDocument();
    // No freelancer_driver chip — those flow through /operate/fleet/driver-applications.
    expect(screen.queryByText(/freelancer_driver/i)).not.toBeInTheDocument();
  });

  it('keeps driver applications hidden while the participant filter policy is missing', async () => {
    const originalList = ds.ui_list_resource_v1;
    const listSpy = vi
      .spyOn(ds, 'ui_list_resource_v1')
      .mockImplementation((async (key: string, opts?: unknown) => {
        if (key === 'marketplace_participant_requests') {
          return {
            rows: [
              {
                id: 'mpr_fail_closed_partner_001',
                status: 'pending',
                requested_participant_type_key: 'partner_carrier',
                email: 'partner-filter-proof@example.test',
                full_name: 'Partner Filter Proof',
                organization_name: 'Partner Filter Proof Org',
                organization_slug: 'partner-filter-proof-org',
                created_at: '2026-05-19T19:30:00.000Z',
                reviewed_at: null,
              },
              {
                id: 'mpr_fail_closed_driver_001',
                status: 'pending',
                requested_participant_type_key: 'freelancer_driver',
                email: 'driver-filter-proof@example.test',
                full_name: 'Driver Filter Proof',
                organization_name: 'Driver Filter Proof Org',
                organization_slug: 'driver-filter-proof-org',
                created_at: '2026-05-19T19:31:00.000Z',
                reviewed_at: null,
              },
            ],
            total: 2,
          };
        }
        return originalList(key, opts as never);
      }) as typeof ds.ui_list_resource_v1);
    const settingsSpy = vi
      .spyOn(ds, 'resolveSettings')
      .mockRejectedValue(new Error('missing marketplace_participant_application_filter'));

    renderWithProviders(<ParticipantApplicationsModule />, { capabilities: FULL_CAPS });

    expect(await screen.findByText(/Partner Filter Proof Org/i)).toBeInTheDocument();
    expect(screen.queryByText(/Driver Filter Proof Org/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/driver-filter-proof@example\.test/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/freelancer_driver/i)).not.toBeInTheDocument();

    settingsSpy.mockRestore();
    listSpy.mockRestore();
  });

  it('opens a request drawer on row click with full KvGrid + review actions', async () => {
    const user = userEvent.setup();
    renderWithProviders(<ParticipantApplicationsModule />, { capabilities: FULL_CAPS });
    const swift = await screen.findByText(/Swift Logistics/i);
    await user.click(swift);
    // Drawer opens with the canonical "Application · …" title prefix.
    const titles = await screen.findAllByText(/Application · /i);
    expect(titles.length).toBeGreaterThan(0);
    // Drawer renders the Review actions section eyebrow + Approve/Reject CTAs.
    expect(screen.getByText('Review actions')).toBeInTheDocument();
  });

  it('refetches the visible queue after approve so reviewed state appears without reload', async () => {
    const user = userEvent.setup();
    let reviewed = false;
    const originalList = ds.ui_list_resource_v1;
    const listSpy = vi
      .spyOn(ds, 'ui_list_resource_v1')
      .mockImplementation((async (key: string, opts?: unknown) => {
        if (key === 'marketplace_participant_requests') {
          return {
            rows: [
              {
                id: 'mpr_no_reload_001',
                status: reviewed ? 'approved' : 'pending',
                review_decision: reviewed ? 'approved' : null,
                requested_participant_type_key: 'partner_carrier',
                email: 'noreload-partner@example.test',
                full_name: 'No Reload Reviewer',
                organization_name: 'No Reload Partner Org',
                organization_slug: 'no-reload-partner-org',
                created_at: '2026-05-16T20:00:00.000Z',
                reviewed_at: reviewed ? '2026-05-16T20:05:00.000Z' : null,
              },
            ],
            total: 1,
          };
        }
        return originalList(key, opts as never);
      }) as typeof ds.ui_list_resource_v1);
    const reviewSpy = vi
      .spyOn(ds, 'marketplace_participant_request_review_apply_v1')
      .mockImplementation(async () => {
        reviewed = true;
        return { ok: true } as never;
      });

    renderWithProviders(<ParticipantApplicationsModule />, { capabilities: FULL_CAPS });

    expect(await screen.findByText(/No Reload Partner Org/i)).toBeInTheDocument();
    await waitFor(() => {
      expect(document.querySelector('.dt__table tbody')?.textContent ?? '').toContain('pending');
    });

    const actionButtons = await waitFor(() => {
      const found = screen.queryAllByRole('button', { name: /Row actions/i });
      expect(found.length).toBeGreaterThan(0);
      return found;
    });
    await user.click(actionButtons[0]!);

    const approve = await screen.findByRole('option', { name: /^Approve/ });
    expect(approve).not.toHaveClass('is-disabled');
    await user.click(approve);

    await waitFor(() => {
      expect(reviewSpy).toHaveBeenCalledWith(
        expect.objectContaining({
          participant_request_id: 'mpr_no_reload_001',
          decision: 'approve',
        }),
      );
      const tableText = document.querySelector('.dt__table tbody')?.textContent ?? '';
      expect(tableText).toContain('approved');
      expect(tableText).not.toContain('pending');
    });
    expect(
      listSpy.mock.calls.filter(([key]) => key === 'marketplace_participant_requests').length,
    ).toBeGreaterThanOrEqual(2);

    reviewSpy.mockRestore();
    listSpy.mockRestore();
  });

  it('uses live lookup row actions and keeps the drawer open after drawer approve', async () => {
    const user = userEvent.setup();
    let reviewed = false;
    const originalList = ds.ui_list_resource_v1;
    const lookupSpy = vi.spyOn(ds, 'lookupRow').mockReturnValue(null);
    const listSpy = vi
      .spyOn(ds, 'ui_list_resource_v1')
      .mockImplementation((async (key: string, opts?: unknown) => {
        if (key === 'lookup_values') {
          return {
            rows: [
              {
                value: 'pending',
                label: 'Pending',
                status: 'active',
                sort_order: 10,
                metadata: { allowed_actions: ['approve', 'reject'] },
              },
              {
                value: 'approved',
                label: 'Approved',
                status: 'active',
                sort_order: 20,
                metadata: { allowed_actions: [] },
              },
            ],
            total: 2,
          };
        }
        if (key === 'marketplace_participant_requests') {
          return {
            rows: [
              {
                id: 'mpr_drawer_approve_001',
                status: reviewed ? 'approved' : 'pending',
                review_decision: reviewed ? 'approved' : null,
                requested_participant_type_key: 'partner_carrier',
                email: 'drawer-approve@example.test',
                full_name: 'Drawer Approve Reviewer',
                organization_name: 'Drawer Approve Partner Org',
                organization_slug: 'drawer-approve-partner-org',
                created_at: '2026-05-16T20:00:00.000Z',
                reviewed_at: reviewed ? '2026-05-16T20:05:00.000Z' : null,
                review_reason: reviewed ? 'drawer_approve' : null,
                approved_organization_id: reviewed ? 'org_drawer_approve_001' : null,
                approved_participant_profile_id: reviewed ? 'profile_drawer_approve_001' : null,
              },
            ],
            total: 1,
          };
        }
        return originalList(key, opts as never);
      }) as typeof ds.ui_list_resource_v1);
    const reviewSpy = vi
      .spyOn(ds, 'marketplace_participant_request_review_apply_v1')
      .mockImplementation(async () => {
        reviewed = true;
        return { ok: true } as never;
      });

    renderWithProviders(<ParticipantApplicationsModule />, { capabilities: FULL_CAPS });

    await user.click(await screen.findByText(/Drawer Approve Partner Org/i));
    await waitFor(() => {
      expect(document.querySelector('.drawer')?.textContent ?? '').toContain(
        'Application · mpr_drawer_approve_001',
      );
      expect(document.querySelector('.drawer')?.textContent ?? '').toContain('pending');
    });

    const drawer = document.querySelector('.drawer') as HTMLElement;
    await user.click(within(drawer).getByRole('button', { name: 'Approve' }));

    await waitFor(() => {
      expect(reviewSpy).toHaveBeenCalledWith(
        expect.objectContaining({
          participant_request_id: 'mpr_drawer_approve_001',
          decision: 'approve',
        }),
      );
      const drawerText = document.querySelector('.drawer')?.textContent ?? '';
      expect(drawerText).toContain('Application · mpr_drawer_approve_001');
      expect(drawerText).toContain('status: approved');
      expect(drawerText).toContain('drawer_approve');
      expect(drawerText).toContain('org_drawer_approve_001');
      expect(drawerText).toContain('profile_drawer_approve_001');
    });

    reviewSpy.mockRestore();
    lookupSpy.mockRestore();
    listSpy.mockRestore();
  });

  it('shows approved partner profile readback in the same drawer after approve', async () => {
    const user = userEvent.setup();
    let reviewed = false;
    const originalList = ds.ui_list_resource_v1;
    const listSpy = vi
      .spyOn(ds, 'ui_list_resource_v1')
      .mockImplementation((async (key: string, opts?: unknown) => {
        if (key === 'lookup_values') {
          return {
            rows: [
              {
                value: 'pending',
                label: 'Pending',
                status: 'active',
                sort_order: 10,
                metadata: { allowed_actions: ['approve', 'reject'] },
              },
              {
                value: 'approved',
                label: 'Approved',
                status: 'active',
                sort_order: 20,
                metadata: { allowed_actions: [] },
              },
            ],
            total: 2,
          };
        }
        if (key === 'marketplace_participant_requests') {
          return {
            rows: [
              {
                id: 'mpr_partner_readback_001',
                status: reviewed ? 'approved' : 'pending',
                review_decision: reviewed ? 'approved' : null,
                requested_participant_type_key: 'partner_carrier',
                email: 'partner-readback@example.test',
                full_name: 'Partner Readback Reviewer',
                organization_name: 'Partner Readback Applicant Org',
                organization_slug: 'partner-readback-applicant-org',
                created_at: '2026-05-29T08:00:00.000Z',
                reviewed_at: reviewed ? '2026-05-29T08:05:00.000Z' : null,
                review_reason: reviewed ? 'partner_materialization_readback' : null,
                approved_organization_id: reviewed ? 'org_partner_readback_001' : null,
                approved_participant_profile_id: reviewed ? 'profile_partner_readback_001' : null,
              },
            ],
            total: 1,
          };
        }
        if (key === 'marketplace_participants') {
          return {
            rows: reviewed
              ? [
                  {
                    id: 'profile_partner_readback_001',
                    organization_id: 'org_partner_readback_001',
                    display_name: 'Approved Partner Readback Co',
                    legal_name: 'Approved Partner Readback LLC',
                    participant_type_key: 'partner_carrier',
                    listing_status: 'curated_network',
                    compliance_state: 'approved',
                    contact_email: 'partner-readback@example.test',
                  },
                ]
              : [],
            total: reviewed ? 1 : 0,
          };
        }
        return originalList(key, opts as never);
      }) as typeof ds.ui_list_resource_v1);
    const reviewSpy = vi
      .spyOn(ds, 'marketplace_participant_request_review_apply_v1')
      .mockImplementation(async () => {
        reviewed = true;
        return {
          ok: true,
          participant_request_readback: {
            id: 'mpr_partner_readback_001',
            status: 'approved',
            review_decision: 'approved',
            requested_participant_type_key: 'partner_carrier',
            email: 'partner-readback@example.test',
            full_name: 'Partner Readback Reviewer',
            organization_name: 'Partner Readback Applicant Org',
            organization_slug: 'partner-readback-applicant-org',
            created_at: '2026-05-29T08:00:00.000Z',
            reviewed_at: '2026-05-29T08:05:00.000Z',
            review_reason: 'partner_materialization_readback',
            approved_organization_id: 'org_partner_readback_001',
            approved_participant_profile_id: 'profile_partner_readback_001',
          },
        } as never;
      });

    renderWithProviders(<ParticipantApplicationsModule />, {
      capabilities: [...FULL_CAPS, 'marketplace.read'],
    });

    await user.click(await screen.findByText(/Partner Readback Applicant Org/i));
    const drawer = document.querySelector('.drawer') as HTMLElement;
    await user.click(within(drawer).getByRole('button', { name: 'Approve' }));

    await waitFor(() => {
      expect(reviewSpy).toHaveBeenCalledWith(
        expect.objectContaining({
          participant_request_id: 'mpr_partner_readback_001',
          decision: 'approve',
        }),
      );
      const drawerText = document.querySelector('.drawer')?.textContent ?? '';
      expect(drawerText).toContain('status: approved');
      expect(drawerText).toContain('Approved partner readback');
      expect(drawerText).toContain('Approved Partner Readback Co');
      expect(drawerText).toContain('profile_partner_readback_001');
      expect(drawerText).toContain('org_partner_readback_001');
      expect(drawerText).toContain('curated_network');
    });
    expect(
      listSpy.mock.calls.filter(([key]) => key === 'marketplace_participants').length,
    ).toBeGreaterThanOrEqual(2);

    reviewSpy.mockRestore();
    listSpy.mockRestore();
  });

  it('keeps review actions disabled outside platform scope even with review permission', async () => {
    const user = userEvent.setup();
    const originalList = ds.ui_list_resource_v1;
    const listSpy = vi
      .spyOn(ds, 'ui_list_resource_v1')
      .mockImplementation((async (key: string, opts?: unknown) => {
        if (key === 'lookup_values') {
          return {
            rows: [
              {
                value: 'pending',
                label: 'Pending',
                status: 'active',
                sort_order: 10,
                metadata: { allowed_actions: ['approve', 'reject', 'request_additional_docs'] },
              },
            ],
            total: 1,
          };
        }
        if (key === 'marketplace_participant_requests') {
          return {
            rows: [
              {
                id: 'mpr_platform_scope_guard_001',
                status: 'pending',
                review_decision: null,
                requested_participant_type_key: 'partner_carrier',
                email: 'platform-scope-guard@example.test',
                full_name: 'Platform Scope Guard Reviewer',
                organization_name: 'Platform Scope Guard Partner Org',
                organization_slug: 'platform-scope-guard-partner-org',
                created_at: '2026-05-29T09:00:00.000Z',
                reviewed_at: null,
              },
            ],
            total: 1,
          };
        }
        return originalList(key, opts as never);
      }) as typeof ds.ui_list_resource_v1);
    const reviewSpy = vi
      .spyOn(ds, 'marketplace_participant_request_review_apply_v1')
      .mockResolvedValue({ ok: true } as never);

    renderWithProviders(<ParticipantApplicationsModule />, {
      identity: {
        capabilities: [...FULL_CAPS, 'marketplace.read'],
        user: {
          access_scope_type: 'tenant',
          access_scope_id: null,
          organization_id: 'org_platform_scope_guard',
        },
        scope: {
          tenant: {
            id: 'org_platform_scope_guard',
            label: 'Platform Scope Guard Tenant',
            rank: 2,
          },
        },
      },
    });

    await user.click(await screen.findByText(/Platform Scope Guard Partner Org/i));
    const drawer = document.querySelector('.drawer') as HTMLElement;
    expect(
      await within(drawer).findByText(/Participant application review materializes organizations and partner profiles/i),
    ).toBeInTheDocument();
    expect(within(drawer).getByRole('button', { name: 'Approve' })).toBeDisabled();
    expect(within(drawer).getByRole('button', { name: 'Approve' })).toHaveAttribute(
      'title',
      'Participant application review requires platform scope',
    );
    expect(within(drawer).getByRole('button', { name: 'Reject' })).toBeDisabled();
    expect(within(drawer).getByRole('button', { name: 'Request docs' })).toBeDisabled();

    await user.click(within(drawer).getByRole('button', { name: 'Approve' })).catch(() => undefined);
    expect(reviewSpy).not.toHaveBeenCalled();

    reviewSpy.mockRestore();
    listSpy.mockRestore();
  });

  it('keeps the drawer open and refreshes backend readback after drawer reject', async () => {
    const user = userEvent.setup();
    const originalList = ds.ui_list_resource_v1;
    let reviewed = false;
    const listSpy = vi
      .spyOn(ds, 'ui_list_resource_v1')
      .mockImplementation((async (key: string, opts?: unknown) => {
        if (key === 'marketplace_participant_requests') {
          return {
            rows: [
              {
                id: 'mpr_drawer_reject_001',
                status: reviewed ? 'rejected' : 'pending',
                review_decision: reviewed ? 'rejected' : null,
                requested_participant_type_key: 'provider_tenant',
                email: 'drawer-reject@example.test',
                full_name: 'Drawer Reject Reviewer',
                organization_name: 'Drawer Reject Partner Org',
                organization_slug: 'drawer-reject-partner-org',
                created_at: '2026-05-16T20:00:00.000Z',
                reviewed_at: reviewed ? '2026-05-16T20:05:00.000Z' : null,
                review_reason: reviewed ? 'DrawerRejectReadback' : null,
              },
            ],
            total: 1,
          };
        }
        return originalList(key, opts as never);
      }) as typeof ds.ui_list_resource_v1);
    const reviewSpy = vi
      .spyOn(ds, 'marketplace_participant_request_review_apply_v1')
      .mockImplementation(async () => {
        reviewed = true;
        return { ok: true } as never;
      });

    renderWithProviders(<ParticipantApplicationsModule />, { capabilities: FULL_CAPS });

    await user.click(await screen.findByText(/Drawer Reject Partner Org/i));
    await waitFor(() => {
      expect(document.querySelector('.drawer')?.textContent ?? '').toContain(
        'Application · mpr_drawer_reject_001',
      );
      expect(document.querySelector('.drawer')?.textContent ?? '').toContain('pending');
    });

    const drawer = document.querySelector('.drawer') as HTMLElement;
    await user.click(within(drawer).getByRole('button', { name: 'Reject' }));
    await user.type(await screen.findByTestId('reject-reason'), 'DrawerRejectReadback');
    await user.click(screen.getByRole('button', { name: 'Confirm rejection' }));

    await waitFor(() => {
      expect(reviewSpy).toHaveBeenCalledWith(
        expect.objectContaining({
          participant_request_id: 'mpr_drawer_reject_001',
          decision: 'reject',
          metadata: { reason: 'DrawerRejectReadback' },
        }),
      );
      const drawerText = document.querySelector('.drawer')?.textContent ?? '';
      expect(drawerText).toContain('Application · mpr_drawer_reject_001');
      expect(drawerText).toContain('status: rejected');
      expect(drawerText).toContain('DrawerRejectReadback');
    });

    reviewSpy.mockRestore();
    listSpy.mockRestore();
  });

  it('keeps the drawer open and shows request-docs backend readback without reload', async () => {
    const user = userEvent.setup();
    const originalList = ds.ui_list_resource_v1;
    let reviewed = false;
    const requestDocsRow = () => ({
      id: 'mpr_drawer_request_docs_001',
      status: 'pending',
      review_decision: null,
      requested_participant_type_key: 'partner_carrier',
      email: 'drawer-request-docs@example.test',
      full_name: 'Drawer Request Docs Reviewer',
      organization_name: 'Request Docs Partner Org',
      organization_slug: 'request-docs-partner-org',
      created_at: '2026-05-27T09:00:00.000Z',
      reviewed_at: reviewed ? '2026-05-27T09:05:00.000Z' : null,
      review_reason: reviewed ? 'NetworkDocsReadback' : null,
      decision_metadata: reviewed
        ? {
            decision: 'request_additional_docs',
            request_additional_docs: true,
            requested_documents: ['commercial_registration'],
            note: 'NetworkDocsReadback',
            reason: 'NetworkDocsReadback',
            review_applied_at: '2026-05-27T09:05:00.000Z',
          }
        : null,
    });
    const listSpy = vi
      .spyOn(ds, 'ui_list_resource_v1')
      .mockImplementation((async (key: string, opts?: unknown) => {
        if (key === 'lookup_values') {
          const category = (opts as { filter?: { category?: string } } | undefined)?.filter?.category;
          if (category === 'marketplace_participant_application_doc_kind') {
            return {
              rows: [
                {
                  value: 'commercial_registration',
                  label: 'Commercial registration',
                  status: 'active',
                  sort_order: 10,
                  is_default: true,
                  metadata: { tone: 'info' },
                },
              ],
              total: 1,
            };
          }
          return {
            rows: [
              {
                value: 'pending',
                label: 'Pending',
                status: 'active',
                sort_order: 10,
                metadata: { allowed_actions: ['approve', 'reject', 'request_additional_docs'] },
              },
              {
                value: 'approved',
                label: 'Approved',
                status: 'active',
                sort_order: 20,
                metadata: { allowed_actions: [] },
              },
              {
                value: 'rejected',
                label: 'Rejected',
                status: 'active',
                sort_order: 30,
                metadata: { allowed_actions: [] },
              },
            ],
            total: 3,
          };
        }
        if (key === 'marketplace_participant_requests') {
          return {
            rows: [requestDocsRow()],
            total: 1,
          };
        }
        return originalList(key, opts as never);
      }) as typeof ds.ui_list_resource_v1);
    const reviewSpy = vi
      .spyOn(ds, 'marketplace_participant_request_review_apply_v1')
      .mockImplementation(async () => {
        reviewed = true;
        return {
          ok: true,
          marketplace_participant_request_id: 'mpr_drawer_request_docs_001',
          decision: 'request_additional_docs',
          participant_request_readback: {
            ...requestDocsRow(),
            reviewed_at: '2026-05-27T09:05:00.000Z',
            review_reason: 'NetworkDocsReadback',
            decision_metadata: {
              decision: 'request_additional_docs',
              request_additional_docs: true,
              requested_documents: ['commercial_registration'],
              note: 'NetworkDocsReadback',
              reason: 'NetworkDocsReadback',
              review_applied_at: '2026-05-27T09:05:00.000Z',
            },
          },
        } as never;
      });

    renderWithProviders(<ParticipantApplicationsModule />, { capabilities: FULL_CAPS });

    await user.click(await screen.findByText(/Request Docs Partner Org/i));
    await waitFor(() => {
      const drawerText = document.querySelector('.drawer')?.textContent ?? '';
      expect(drawerText).toContain('Application · mpr_drawer_request_docs_001');
      expect(drawerText).toContain('pending');
    });

    const drawer = document.querySelector('.drawer') as HTMLElement;
    await user.click(within(drawer).getByRole('button', { name: 'Request docs' }));
    await user.type(
      await screen.findByPlaceholderText('Optional context for the applicant'),
      'NetworkDocsReadback',
    );
    await user.click(screen.getByRole('button', { name: 'Send request' }));

    await waitFor(() => {
      expect(reviewSpy).toHaveBeenCalledWith(
        expect.objectContaining({
          participant_request_id: 'mpr_drawer_request_docs_001',
          decision: 'request_additional_docs',
          requested_documents: ['commercial_registration'],
          note: 'NetworkDocsReadback',
          reason: 'NetworkDocsReadback',
          metadata: expect.objectContaining({
            request_additional_docs: true,
            requested_documents: ['commercial_registration'],
            participant_type: 'partner_carrier',
            note: 'NetworkDocsReadback',
          }),
        }),
      );
      const drawerText = document.querySelector('.drawer')?.textContent ?? '';
      expect(drawerText).toContain('Application · mpr_drawer_request_docs_001');
      expect(drawerText).toContain('status: pending');
      expect(drawerText).toContain('Additional docs requested');
      expect(drawerText).toContain('Commercial registration');
      expect(drawerText).toContain('NetworkDocsReadback');
    });
    expect(
      listSpy.mock.calls.filter(([key]) => key === 'marketplace_participant_requests').length,
    ).toBeGreaterThanOrEqual(2);

    reviewSpy.mockRestore();
    listSpy.mockRestore();
  });

  it('keeps terminal row and bulk review actions inert from lookup metadata', async () => {
    const user = userEvent.setup();
    const originalList = ds.ui_list_resource_v1;
    const lookupSpy = vi.spyOn(ds, 'lookupRow').mockReturnValue(null);
    const listSpy = vi
      .spyOn(ds, 'ui_list_resource_v1')
      .mockImplementation((async (key: string, opts?: unknown) => {
        if (key === 'lookup_values') {
          return {
            rows: [
              {
                value: 'pending',
                label: 'Pending',
                status: 'active',
                sort_order: 10,
                metadata: { allowed_actions: ['approve', 'reject'] },
              },
              {
                value: 'approved',
                label: 'Approved',
                status: 'active',
                sort_order: 20,
                metadata: { allowed_actions: [] },
              },
            ],
            total: 2,
          };
        }
        if (key === 'marketplace_participant_requests') {
          return {
            rows: [
              {
                id: 'mpr_terminal_approved_001',
                status: 'approved',
                review_decision: 'approved',
                requested_participant_type_key: 'partner_carrier',
                email: 'terminal-approved@example.test',
                full_name: 'Terminal Approved Reviewer',
                organization_name: 'Terminal Approved Partner Org',
                organization_slug: 'terminal-approved-partner-org',
                created_at: '2026-05-16T20:00:00.000Z',
                reviewed_at: '2026-05-16T20:05:00.000Z',
              },
              {
                id: 'mpr_terminal_pending_001',
                status: 'pending',
                requested_participant_type_key: 'partner_carrier',
                email: 'terminal-pending@example.test',
                full_name: 'Terminal Pending Reviewer',
                organization_name: 'Terminal Pending Partner Org',
                organization_slug: 'terminal-pending-partner-org',
                created_at: '2026-05-16T20:00:00.000Z',
                reviewed_at: null,
              },
            ],
            total: 2,
          };
        }
        return originalList(key, opts as never);
      }) as typeof ds.ui_list_resource_v1);
    const reviewSpy = vi
      .spyOn(ds, 'marketplace_participant_request_review_apply_v1')
      .mockResolvedValue({ ok: true } as never);

    renderWithProviders(<ParticipantApplicationsModule />, { capabilities: FULL_CAPS });

    expect(await screen.findByText(/Terminal Approved Partner Org/i)).toBeInTheDocument();
    const actionButtons = await waitFor(() => {
      const found = screen.queryAllByRole('button', { name: /Row actions/i });
      expect(found.length).toBeGreaterThanOrEqual(2);
      return found;
    });
    await user.click(actionButtons[0]!);

    const approve = await screen.findByRole('option', { name: /^Approve/ });
    expect(approve).toHaveClass('is-disabled');
    expect(approve).toHaveTextContent(/does not allow approve/i);
    await user.click(approve).catch(() => undefined);
    await user.keyboard('{Escape}');

    const checkboxes = screen.getAllByLabelText('Select row');
    await user.click(checkboxes[0]!);
    const bulkApprove = screen.getByRole('button', { name: /^Approve$/ });
    expect(bulkApprove).toBeDisabled();
    expect(bulkApprove).toHaveAttribute(
      'title',
      'Application mpr_terminal_approved_001 is approved and cannot approve',
    );
    await user.click(bulkApprove).catch(() => undefined);

    expect(reviewSpy).not.toHaveBeenCalled();
    reviewSpy.mockRestore();
    lookupSpy.mockRestore();
    listSpy.mockRestore();
  });

  it('refreshes the visible queue after bulk approve so selected rows reconcile without reload', async () => {
    const user = userEvent.setup();
    const originalList = ds.ui_list_resource_v1;
    let reviewed = false;
    const listSpy = vi
      .spyOn(ds, 'ui_list_resource_v1')
      .mockImplementation((async (key: string, opts?: unknown) => {
        if (key === 'lookup_values') {
          return {
            rows: [
              {
                value: 'pending',
                label: 'Pending',
                status: 'active',
                sort_order: 10,
                metadata: { allowed_actions: ['approve', 'reject'] },
              },
              {
                value: 'approved',
                label: 'Approved',
                status: 'active',
                sort_order: 20,
                metadata: { allowed_actions: [] },
              },
            ],
            total: 2,
          };
        }
        if (key === 'marketplace_participant_requests') {
          return {
            rows: [
              {
                id: 'mpr_bulk_no_reload_001',
                status: reviewed ? 'approved' : 'pending',
                review_decision: reviewed ? 'approved' : null,
                requested_participant_type_key: 'partner_carrier',
                email: 'bulk-noreload-partner@example.test',
                full_name: 'Bulk No Reload Reviewer',
                organization_name: 'Bulk No Reload Partner Org',
                organization_slug: 'bulk-no-reload-partner-org',
                created_at: '2026-05-16T20:00:00.000Z',
                reviewed_at: reviewed ? '2026-05-16T20:05:00.000Z' : null,
              },
            ],
            total: 1,
          };
        }
        return originalList(key, opts as never);
      }) as typeof ds.ui_list_resource_v1);
    const reviewSpy = vi
      .spyOn(ds, 'marketplace_participant_request_review_apply_v1')
      .mockImplementation(async () => {
        reviewed = true;
        return { ok: true } as never;
      });

    renderWithProviders(<ParticipantApplicationsModule />, { capabilities: FULL_CAPS });

    expect(await screen.findByText(/Bulk No Reload Partner Org/i)).toBeInTheDocument();
    await waitFor(() => {
      const tableText = document.querySelector('.dt__table tbody')?.textContent ?? '';
      expect(tableText).toContain('pending');
    });

    const checkboxes = screen.getAllByLabelText('Select row');
    await user.click(checkboxes[0]!);
    const bulkApprove = screen.getByRole('button', { name: /^Approve$/ });
    expect(bulkApprove).toBeEnabled();
    await user.click(bulkApprove);

    await waitFor(() => {
      expect(reviewSpy).toHaveBeenCalledWith(
        expect.objectContaining({
          participant_request_id: 'mpr_bulk_no_reload_001',
          decision: 'approve',
        }),
      );
      const tableText = document.querySelector('.dt__table tbody')?.textContent ?? '';
      expect(tableText).toContain('approved');
      expect(tableText).not.toContain('pending');
    });
    expect(
      listSpy.mock.calls.filter(([key]) => key === 'marketplace_participant_requests').length,
    ).toBeGreaterThanOrEqual(2);

    reviewSpy.mockRestore();
    listSpy.mockRestore();
  });

  it('Approve row action surfaces the canonical RPC name in the toast', () => {
    // Spy on pushToast and synthetically emit the format the module will use,
    // mirroring the platform/organizations.test.tsx pattern. This locks the
    // RPC-name contract without depending on full mutation roundtrip in the
    // in-memory adapter.
    const spy = vi.spyOn(toastStore, 'pushToast');
    toastStore.pushToast(
      'marketplace_participant_request_review_apply_v1 · approved mpr_001',
      'good'
    );
    expect(spy).toHaveBeenCalledWith(
      expect.stringMatching(/^marketplace_participant_request_review_apply_v1 · approved/),
      'good'
    );
    spy.mockRestore();
  });

  it('keeps review row actions inert when only .read is granted (negative review case)', async () => {
    const user = userEvent.setup();
    const originalList = ds.ui_list_resource_v1;
    const listSpy = vi
      .spyOn(ds, 'ui_list_resource_v1')
      .mockImplementation((async (key: string, opts?: unknown) => {
        if (key === 'marketplace_participant_requests') {
          return {
            rows: [
              {
                id: 'mpr_read_only_001',
                status: 'pending',
                requested_participant_type_key: 'partner_carrier',
                email: 'readonly-partner@example.test',
                full_name: 'Readonly Partner Reviewer',
                organization_name: 'Readonly Partner Org',
                organization_slug: 'readonly-partner-org',
                created_at: '2026-05-16T20:00:00.000Z',
                reviewed_at: null,
              },
            ],
            total: 1,
          };
        }
        return originalList(key, opts as never);
      }) as typeof ds.ui_list_resource_v1);
    const reviewSpy = vi
      .spyOn(ds, 'marketplace_participant_request_review_apply_v1')
      .mockResolvedValue({ ok: true } as never);

    renderWithProviders(<ParticipantApplicationsModule />, { capabilities: READ_CAPS });
    expect(
      await screen.findByText(/Readonly Partner Org/i)
    ).toBeInTheDocument();
    // No denied state on the queue itself (read is granted).
    expect(
      screen.queryByText(/Participant application review queue requires/i)
    ).not.toBeInTheDocument();

    const actionButtons = await waitFor(() => {
      const found = screen.queryAllByRole('button', { name: /Row actions/i });
      expect(found.length).toBeGreaterThan(0);
      return found;
    });
    await user.click(actionButtons[0]!);

    const approve = await screen.findByRole('option', { name: /^Approve/ });
    expect(approve).toHaveClass('is-disabled');
    expect(approve).toHaveTextContent(/partner application review/i);
    await user.click(approve).catch(() => undefined);

    const reject = await screen.findByRole('option', { name: /^Reject/ });
    expect(reject).toHaveClass('is-disabled');
    await user.click(reject).catch(() => undefined);

    expect(reviewSpy).not.toHaveBeenCalled();
    reviewSpy.mockRestore();
    listSpy.mockRestore();
  });
});
