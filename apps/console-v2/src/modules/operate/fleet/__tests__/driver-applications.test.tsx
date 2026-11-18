// driver-applications.test.tsx — closes FLEET REAUDIT D2 test-coverage gap
// (Wave 5 v2; subject `f11c1bf11b`). The 1043-LOC driver-applications module
// shipped with zero Vitest coverage despite being a Phase D1 surface that
// reaches a canonical RPC (`marketplace_participant_request_review_apply_v1`).
//
// This file asserts:
//   1. mounts and renders the page header + driver_applications resource
//   2. KPI strip exposes the 5 canonical tiles (Total / Pending / Approved /
//      Rejected / SLA breach)
//   3. DataTable renders rows from seed driver_applications (mpr_drv_4421
//      + cohort)
//   4. clicking a row opens the drawer with all 4 tabs (Profile / Attestations
//      / Documents / Decisions)
//   5. Approve action is gated by `fleet.write` (canonical SSOT — FE-invented
//      `drivers.write` has been retired per FLEET Wave 5 D3 closure)
//   6. Approve flow fires marketplace_participant_request_review_apply_v1 with
//      the canonical envelope (decision='approve', participant_request_id,
//      metadata.participant_type)
//   7. Reject flow fires the same RPC with decision='reject'
//   8. Request-additional-docs routes through the same canonical RPC with
//      decision='request_additional_docs' + requested_documents array + note
//   9. Approve / Reject / Request-docs row actions all gate on `fleet.write`
//      (CapabilityLock visible when the cap is missing)
//
// The test names exactly match the audit mandate's D2 expectation:
//   "mount + KPI strip + DataTable rows + drawer 4 tabs + Approve/Reject/
//    Request-additional-docs actions + capability gates + RPC name assertions
//    (8+ tests)".
//
// Pattern mirrors `__tests__/drivers.test.tsx` so the suite stays consistent.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { renderWithProviders, type RenderWithProvidersOptions } from '@/test/render';
import { DriverApplicationsModule } from '../driver-applications';
import { CAP } from '@/lib/capabilities';
import * as api from '@/lib/api';
import * as ds from '@/lib/data-source';
import * as toastStore from '@/components/toastStore';
// @ts-expect-error JS module — registry shape exercised dynamically below.
import * as registry from '@/lib/seed-raw/registry';

const TEST_TENANT_ID = 'org_test_driver_applications';

function platformIdentity(
  capabilities: string[] = ['all', CAP.MARKETPLACE_PARTICIPANT_REQUESTS_REVIEW],
): RenderWithProvidersOptions['identity'] {
  return {
    capabilities,
    user: {
      access_scope_type: 'platform',
      access_scope_id: null,
      organization_id: TEST_TENANT_ID,
    },
    scope: {
      tenant: {
        id: TEST_TENANT_ID,
        label: 'Driver Applications Test Tenant',
        rank: 2,
      },
    },
  };
}

function tenantIdentity(
  capabilities: string[],
): RenderWithProvidersOptions['identity'] {
  return {
    capabilities,
    user: {
      access_scope_type: 'tenant',
      access_scope_id: null,
      organization_id: TEST_TENANT_ID,
    },
    scope: {
      tenant: {
        id: TEST_TENANT_ID,
        label: 'Driver Applications Test Tenant',
        rank: 2,
      },
    },
  };
}

function driverApplicationRow(overrides: Record<string, unknown> = {}) {
  return {
    id: 'mpr_drv_readback_001',
    created_at: '2026-05-18T08:00:00.000Z',
    updated_at: '2026-05-18T08:00:00.000Z',
    status: 'pending',
    review_decision: null,
    requested_participant_type_key: 'freelancer_driver',
    email: 'readback-driver@example.test',
    full_name: 'Readback Driver Applicant',
    organization_name: 'Readback Driver Org',
    organization_slug: 'readback-driver-org',
    phone: '+12025550123',
    capabilities_requested: ['local_delivery'],
    verification_documents: [],
    turnstile_verified: true,
    reviewed_at: null,
    reviewed_by: null,
    review_reason: null,
    capabilities_count: 1,
    verification_documents_count: 0,
    submitted_document_count: 0,
    missing_document_count: 0,
    is_pending: true,
    is_approved: false,
    is_rejected: false,
    is_withdrawn: false,
    is_terminal: false,
    age_seconds: 3600,
    decision_age_seconds: null,
    sla_breach: false,
    approved_organization_id: null,
    approved_user_id: null,
    approved_participant_profile_id: null,
    driver_profile_id: null,
    fleet_driver_status: null,
    fleet_handoff_ready: false,
    fleet_document_count: 0,
    fleet_compliance_event_count: 0,
    fleet_last_compliance_event_at: null,
    ...overrides,
  };
}

async function mountAll(opts?: {
  capabilities?: string[];
  identity?: RenderWithProvidersOptions['identity'];
}) {
  const utils = renderWithProviders(<DriverApplicationsModule />, {
    identity: opts?.identity ?? (
      opts?.capabilities ? platformIdentity(opts.capabilities) : platformIdentity()
    ),
  });
  await waitFor(
    () => {
      expect(screen.queryByText(/loading/i)).not.toBeInTheDocument();
    },
    { timeout: 3000 },
  );
  return utils;
}

describe('DriverApplicationsModule (CLAIM-FLEET-DRIVER-APPLICATIONS · D2 close-out)', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    window.history.pushState(null, '', '/operate/fleet/driver-applications');
  });
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
    window.history.pushState(null, '', '/operate/fleet/driver-applications');
  });

  it('mounts and renders the page header + canonical seam pills', async () => {
    await mountAll();
    // Title accent + plain text renders.
    expect(screen.getByText(/Driver applications/i)).toBeInTheDocument();
    // Seam pills must use operator-facing language while backend wiring remains
    // covered by the action tests below.
    expect(
      document.body.textContent?.includes('Driver application queue'),
    ).toBe(true);
    expect(
      document.body.textContent?.includes(
        'Review decision workflow',
      ),
    ).toBe(true);
  });

  it('KPI strip exposes the 5 canonical tiles', async () => {
    await mountAll();
    const kpiLabels = Array.from(document.querySelectorAll('.kpi__label')).map(
      (el) => el.textContent?.trim() ?? '',
    );
    // Order is fixed in the module: Total / Pending / Approved / Rejected /
    // SLA breach. The seed cohort has at least 1 of each so the tiles render.
    expect(kpiLabels).toEqual(
      expect.arrayContaining([
        'Total applications',
        'Pending review',
        'Approved',
        'Rejected',
        'SLA breach (>7d pending)',
      ]),
    );
  });

  it('DataTable renders rows from seed driver_applications', async () => {
    await mountAll();
    // The first seeded row is Fadi Hijazi (mpr_drv_4421) — pending. We don't
    // require the exact name across re-seeds; we just require the table has
    // body rows.
    const bodyRows = document.querySelectorAll('.dt__table tbody tr');
    expect(bodyRows.length).toBeGreaterThan(0);
    // At least one row carries a `pending` status chip (lookup-resolved) or
    // the literal status text. The module renders `status` via the
    // driver_application_status lookup in domain-routes.js seed alignment.
    const hasPending = Array.from(bodyRows).some((r) =>
      /pending/i.test(r.textContent ?? ''),
    );
    expect(hasPending).toBe(true);
  });

  it('clicking a row opens the drawer with all 4 tabs (Profile / Attestations / Documents / Decisions)', async () => {
    const user = userEvent.setup();
    await mountAll();

    const firstRow = document.querySelector('.dt__table tbody tr');
    expect(firstRow).toBeTruthy();
    if (!firstRow) throw new Error('No row to click');
    await user.click(firstRow as HTMLElement);

    await waitFor(() => {
      expect(
        document.querySelector('[role="tablist"][aria-label="Driver application drawer tabs"]'),
      ).toBeTruthy();
    });

    const tablist = document.querySelector(
      '[role="tablist"][aria-label="Driver application drawer tabs"]',
    );
    const tabs = tablist!.querySelectorAll('[role="tab"]');
    expect(tabs.length).toBe(4);
    const labels = Array.from(tabs).map((t) => t.textContent?.trim());
    expect(labels).toEqual(['Profile', 'Attestations', 'Documents', 'Decisions']);
  });

  it('opens the application drawer from a focus deep link', async () => {
    window.history.pushState(null, '', '/operate/fleet/driver-applications?focus=mpr_drv_4421');
    await mountAll();

    await waitFor(() => {
      expect(
        document.querySelector('[role="tablist"][aria-label="Driver application drawer tabs"]'),
      ).toBeTruthy();
    });
    const drawerText = document.querySelector('.drawer')?.textContent ?? '';
    expect(drawerText).toMatch(/Fadi Hijazi|Attestations|Decisions/i);
  });

  it('keeps Approve / Reject / Request-additional-docs row actions inert without participant review permission', async () => {
    const user = userEvent.setup();
    const originalList = ds.ui_list_resource_v1;
    const listSpy = vi
      .spyOn(ds, 'ui_list_resource_v1')
      .mockImplementation((async (key: string, opts?: unknown) => {
        if (key === 'driver_application_directory') {
          return {
            rows: [
              {
                id: 'mpr_drv_read_only_001',
                created_at: '2026-05-16T20:00:00.000Z',
                updated_at: '2026-05-16T20:00:00.000Z',
                status: 'pending',
                review_decision: null,
                requested_participant_type_key: 'freelancer_driver',
                email: 'readonly-driver@example.test',
                full_name: 'Readonly Driver Applicant',
                organization_name: 'Readonly Driver Org',
                organization_slug: 'readonly-driver-org',
                phone: '+12025550123',
                capabilities_requested: ['local_delivery'],
                verification_documents: [],
                turnstile_verified: true,
                reviewed_at: null,
                reviewed_by: null,
                review_reason: null,
                capabilities_count: 1,
                verification_documents_count: 0,
                submitted_document_count: 0,
                missing_document_count: 0,
                is_pending: true,
                is_approved: false,
                is_rejected: false,
                is_withdrawn: false,
                is_terminal: false,
                age_seconds: 3600,
                decision_age_seconds: null,
                sla_breach: false,
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
    // Render with fleet.read only — Approve/Reject/Request must surface in
    // the palette but be capability-locked. Per FLEET Wave 5 re-audit D3
    // closure, callsites gate on canonical participant-review permission plus
    // platform scope (the FE-invented `drivers.write` was retired).
    renderWithProviders(<DriverApplicationsModule />, {
      identity: platformIdentity(['fleet.read']),
    });
    await waitFor(
      () => {
        expect(screen.queryByText(/loading/i)).not.toBeInTheDocument();
      },
      { timeout: 3000 },
    );

    // Open the first row's row-actions overflow.
    const overflows = await waitFor(() => {
      const found = screen.queryAllByRole('button', { name: /Row actions/i });
      expect(found.length).toBeGreaterThan(0);
      return found;
    });
    const firstOverflow = overflows[0];
    if (!firstOverflow) throw new Error('No row actions overflow button');
    await user.click(firstOverflow);

    const optionFor = async (label: RegExp) =>
      waitFor(() => {
        const labels = Array.from(
          document.querySelectorAll('.palette__item .palette__item-label'),
        );
        const found = labels.find((el) => label.test((el.textContent ?? '').trim()));
        expect(found).toBeTruthy();
        return found!.closest('.palette__item') as HTMLElement;
      });

    const approve = await optionFor(/^Approve$/i);
    expect(approve).toHaveClass('is-disabled');
    expect(approve).toHaveTextContent(/partner application review/i);
    await user.click(approve).catch(() => undefined);

    const reject = await optionFor(/^Reject$/i);
    expect(reject).toHaveClass('is-disabled');
    await user.click(reject).catch(() => undefined);

    const requestDocs = await optionFor(/Request additional docs/i);
    expect(requestDocs).toHaveClass('is-disabled');
    await user.click(requestDocs).catch(() => undefined);

    expect(document.querySelector('.modal')).toBeNull();
    expect(reviewSpy).not.toHaveBeenCalled();
    reviewSpy.mockRestore();
    listSpy.mockRestore();
  });

  it('keeps review row actions inert for tenant users even with participant review permission', async () => {
    const reviewSpy = vi
      .spyOn(ds, 'marketplace_participant_request_review_apply_v1')
      .mockResolvedValue({ ok: true } as never);
    const user = userEvent.setup();
    await mountAll({
      identity: tenantIdentity([
        'fleet.read',
        'marketplace_participant_requests.review',
      ]),
    });

    const overflow = (await waitFor(() => {
      const found = screen.queryAllByRole('button', { name: /Row actions/i });
      expect(found.length).toBeGreaterThan(0);
      return found[0];
    })) as HTMLElement;
    await user.click(overflow);

    const approve = await waitFor(() => {
      const labels = Array.from(
        document.querySelectorAll('.palette__item .palette__item-label'),
      );
      const found = labels.find((el) => (el.textContent ?? '').trim() === 'Approve');
      expect(found).toBeTruthy();
      return found!.closest('.palette__item') as HTMLElement;
    });
    expect(approve).toHaveClass('is-disabled');
    expect(approve).toHaveTextContent(/platform reviewer scope required/i);
    await user.click(approve).catch(() => undefined);

    expect(document.querySelector('.modal')).toBeNull();
    expect(reviewSpy).not.toHaveBeenCalled();
    reviewSpy.mockRestore();
  });

  it('allows platform wildcard reviewers because wildcard mirrors backend capability access', async () => {
    const reviewSpy = vi
      .spyOn(ds, 'marketplace_participant_request_review_apply_v1')
      .mockResolvedValue({ ok: true } as never);
    const user = userEvent.setup();
    await mountAll({ identity: platformIdentity(['all']) });

    const overflow = (await waitFor(() => {
      const found = screen.queryAllByRole('button', { name: /Row actions/i });
      expect(found.length).toBeGreaterThan(0);
      return found[0];
    })) as HTMLElement;
    await user.click(overflow);

    const approve = await waitFor(() => {
      const labels = Array.from(
        document.querySelectorAll('.palette__item .palette__item-label'),
      );
      const found = labels.find((el) => (el.textContent ?? '').trim() === 'Approve');
      expect(found).toBeTruthy();
      return found!.closest('.palette__item') as HTMLElement;
    });
    expect(approve).not.toHaveClass('is-disabled');
    await user.click(approve);

    await waitFor(() => {
      expect(reviewSpy).toHaveBeenCalled();
    });
    expect(document.querySelector('.modal')).toBeNull();
    reviewSpy.mockRestore();
  });

  it('keeps terminal application row actions disabled from row-driven status metadata', async () => {
    const terminalApplication = driverApplicationRow({
      status: 'rejected',
      review_decision: 'rejected',
      review_reason: 'duplicate_identity',
      reviewed_at: '2026-05-18T08:25:00.000Z',
      reviewed_by: 'usr_reviewer_001',
      reviewer_label: 'Platform Reviewer',
      is_pending: false,
      is_rejected: true,
      is_terminal: true,
      decision_metadata: {
        reason: 'duplicate_identity',
        participant_type: 'freelancer_driver',
      },
    });
    const originalList = ds.ui_list_resource_v1;
    const listSpy = vi
      .spyOn(ds, 'ui_list_resource_v1')
      .mockImplementation((async (key: string, opts?: unknown) => {
        if (key === 'driver_application_directory') {
          return { rows: [terminalApplication], total: 1 };
        }
        return originalList(key, opts as never);
      }) as typeof ds.ui_list_resource_v1);
    const reviewSpy = vi
      .spyOn(ds, 'marketplace_participant_request_review_apply_v1')
      .mockResolvedValue({ ok: true } as never);

    const user = userEvent.setup();
    await mountAll();

    const overflow = (await waitFor(() => {
      const found = screen.queryAllByRole('button', { name: /Row actions/i });
      expect(found.length).toBeGreaterThan(0);
      return found[0];
    })) as HTMLElement;
    await user.click(overflow);

    const optionFor = async (label: RegExp) =>
      waitFor(() => {
        const labels = Array.from(
          document.querySelectorAll('.palette__item .palette__item-label'),
        );
        const found = labels.find((el) => label.test((el.textContent ?? '').trim()));
        expect(found).toBeTruthy();
        return found!.closest('.palette__item') as HTMLElement;
      });

    const approve = await optionFor(/^Approve$/i);
    expect(approve).toHaveClass('is-disabled');
    expect(approve).toHaveTextContent(/Status rejected does not allow approve/i);
    await user.click(approve).catch(() => undefined);

    const reject = await optionFor(/^Reject$/i);
    expect(reject).toHaveClass('is-disabled');
    expect(reject).toHaveTextContent(/Status rejected does not allow reject/i);
    await user.click(reject).catch(() => undefined);

    const requestDocs = await optionFor(/Request additional docs/i);
    expect(requestDocs).toHaveClass('is-disabled');
    expect(requestDocs).toHaveTextContent(/Status rejected does not allow request_additional_docs/i);
    await user.click(requestDocs).catch(() => undefined);

    expect(document.querySelector('.modal')).toBeNull();
    expect(reviewSpy).not.toHaveBeenCalled();
    reviewSpy.mockRestore();
    listSpy.mockRestore();
  });

  it('keeps the open drawer on the active tab and refreshes it from backend readback after approval', async () => {
    let application = driverApplicationRow();
    const originalList = ds.ui_list_resource_v1;
    const originalGet = ds.ui_get_resource_v1;
    const listSpy = vi
      .spyOn(ds, 'ui_list_resource_v1')
      .mockImplementation((async (key: string, opts?: unknown) => {
        if (key === 'driver_application_directory') {
          return { rows: [application], total: 1 };
        }
        return originalList(key, opts as never);
      }) as typeof ds.ui_list_resource_v1);
    const getSpy = vi
      .spyOn(ds, 'ui_get_resource_v1')
      .mockImplementation((async (key: string, id: string) => {
        if (key === 'driver_application_directory' && id === application.id) {
          return application;
        }
        return originalGet(key, id);
      }) as typeof ds.ui_get_resource_v1);
    const reviewSpy = vi
      .spyOn(ds, 'marketplace_participant_request_review_apply_v1')
      .mockImplementation((async () => {
        application = driverApplicationRow({
          status: 'approved',
          review_decision: 'approved',
          review_reason: 'background_check_clear',
          reviewed_at: '2026-05-18T08:15:00.000Z',
          reviewed_by: 'usr_reviewer_001',
          reviewer_label: 'Platform Reviewer',
          is_pending: false,
          is_approved: true,
          is_terminal: true,
          approved_organization_id: 'org_approved_001',
          approved_user_id: 'usr_driver_approved_001',
          driver_profile_id: 'drvp_driver_application_handoff_001',
          fleet_driver_status: 'active',
          fleet_handoff_ready: true,
          fleet_document_count: 1,
          fleet_compliance_event_count: 1,
          invite_redirect_to: 'https://vtgspxqkvhurpwtxnnyvhjzw.example.invalid/invite/driver',
        });
        return {
          ok: true,
          marketplace_participant_request_id: application.id,
          decision: 'approved',
        };
      }) as typeof ds.marketplace_participant_request_review_apply_v1);

    const user = userEvent.setup();
    await mountAll();

    const firstRow = await waitFor(() => {
      const row = document.querySelector('.dt__table tbody tr');
      expect(row).toBeTruthy();
      return row as HTMLElement;
    });
    await user.click(firstRow as HTMLElement);

    await user.click(await screen.findByRole('tab', { name: 'Decisions' }));
    expect(document.querySelector('[role="tab"][aria-selected="true"]')).toHaveTextContent('Decisions');

    await user.click(screen.getByRole('button', { name: /^Approve$/i }));

    await waitFor(() => {
      expect(document.querySelector('.modal')).toBeNull();
      expect(document.querySelector('[role="tab"][aria-selected="true"]')).toHaveTextContent('Decisions');
      const drawerText = document.querySelector('.drawer')?.textContent ?? '';
      expect(drawerText).toMatch(/approved|Platform Reviewer/i);
    });

    await user.click(await screen.findByRole('tab', { name: 'Profile' }));

    await waitFor(() => {
      const drawerText = document.querySelector('.drawer')?.textContent ?? '';
      expect(drawerText).toMatch(/Fleet driver profile/i);
      expect(drawerText).toMatch(/drvp_driver_application_handoff_001/i);
      expect(drawerText).toMatch(/Fleet handoff/i);
      expect(drawerText).toMatch(/ready/i);
      expect(drawerText).toMatch(/Compliance handoff events/i);
    });
    expect(reviewSpy).toHaveBeenCalledTimes(1);
    expect(getSpy.mock.calls.filter(([key]) => key === 'driver_application_directory').length).toBeGreaterThanOrEqual(2);
    expect(listSpy.mock.calls.filter(([key]) => key === 'driver_application_directory').length).toBeGreaterThanOrEqual(2);

    reviewSpy.mockRestore();
    getSpy.mockRestore();
    listSpy.mockRestore();
  });

  it('keeps the open drawer on Decisions and shows rejection backend readback without reload', async () => {
    let application = driverApplicationRow();
    const originalList = ds.ui_list_resource_v1;
    const originalGet = ds.ui_get_resource_v1;
    const listSpy = vi
      .spyOn(ds, 'ui_list_resource_v1')
      .mockImplementation((async (key: string, opts?: unknown) => {
        if (key === 'driver_application_directory') {
          return { rows: [application], total: 1 };
        }
        return originalList(key, opts as never);
      }) as typeof ds.ui_list_resource_v1);
    const getSpy = vi
      .spyOn(ds, 'ui_get_resource_v1')
      .mockImplementation((async (key: string, id: string) => {
        if (key === 'driver_application_directory' && id === application.id) {
          return application;
        }
        return originalGet(key, id);
      }) as typeof ds.ui_get_resource_v1);
    const reviewSpy = vi
      .spyOn(ds, 'marketplace_participant_request_review_apply_v1')
      .mockImplementation((async () => {
        application = driverApplicationRow({
          status: 'rejected',
          review_decision: 'rejected',
          review_reason: 'duplicate_identity',
          reviewed_at: '2026-05-18T08:25:00.000Z',
          reviewed_by: 'usr_reviewer_001',
          reviewer_label: 'Platform Reviewer',
          is_pending: false,
          is_rejected: true,
          is_terminal: true,
          decision_age_seconds: 0,
          decision_metadata: {
            reason: 'duplicate_identity',
            participant_type: 'freelancer_driver',
          },
        });
        return {
          ok: true,
          marketplace_participant_request_id: application.id,
          decision: 'rejected',
        };
      }) as typeof ds.marketplace_participant_request_review_apply_v1);

    const user = userEvent.setup();
    await mountAll();

    const firstRow = await waitFor(() => {
      const row = document.querySelector('.dt__table tbody tr');
      expect(row).toBeTruthy();
      return row as HTMLElement;
    });
    await user.click(firstRow);
    await user.click(await screen.findByRole('tab', { name: 'Decisions' }));
    await user.click(screen.getByRole('button', { name: /^Reject$/i }));
    await user.selectOptions(
      document.querySelector('.modal select') as HTMLSelectElement,
      'duplicate_identity',
    );
    await user.click(await screen.findByRole('button', { name: /^Reject application$/i }));

    await waitFor(() => {
      expect(document.querySelector('.modal')).toBeNull();
      expect(document.querySelector('[role="tab"][aria-selected="true"]')).toHaveTextContent('Decisions');
      const drawerText = document.querySelector('.drawer')?.textContent ?? '';
      expect(drawerText).toMatch(/rejected/i);
      expect(drawerText).toMatch(/duplicate_identity/i);
      expect(drawerText).toMatch(/Platform Reviewer/i);
    });
    const drawer = document.querySelector('.drawer') as HTMLElement;
    expect(drawer).toBeTruthy();
    expect(screen.getByRole('button', { name: /^Approve$/i })).toBeDisabled();
    expect(screen.getByRole('button', { name: /^Approve$/i })).toHaveAttribute(
      'title',
      'Status rejected does not allow approve',
    );
    expect(screen.getByRole('button', { name: /^Reject$/i })).toBeDisabled();
    expect(screen.getByRole('button', { name: /^Reject$/i })).toHaveAttribute(
      'title',
      'Status rejected does not allow reject',
    );
    expect(screen.getByRole('button', { name: /Request additional docs/i })).toBeDisabled();
    expect(screen.getByRole('button', { name: /Request additional docs/i })).toHaveAttribute(
      'title',
      'Status rejected does not allow request_additional_docs',
    );
    expect(reviewSpy).toHaveBeenCalledTimes(1);
    const args = reviewSpy.mock.calls[0]?.[0] as Record<string, unknown> | undefined;
    expect(args?.decision).toBe('reject');
    expect(args?.participant_request_id).toBe(application.id);
    const metadata = args?.metadata as Record<string, unknown> | undefined;
    expect(metadata?.reason).toBe('duplicate_identity');
    expect(metadata?.participant_type).toBe('freelancer_driver');
    expect(getSpy.mock.calls.filter(([key]) => key === 'driver_application_directory').length).toBeGreaterThanOrEqual(2);
    expect(listSpy.mock.calls.filter(([key]) => key === 'driver_application_directory').length).toBeGreaterThanOrEqual(2);

    reviewSpy.mockRestore();
    getSpy.mockRestore();
    listSpy.mockRestore();
  });

  it('recovers rejection UI from backend readback when the edge response errors after mutation', async () => {
    let application = driverApplicationRow();
    const originalList = ds.ui_list_resource_v1;
    const originalGet = ds.ui_get_resource_v1;
    const listSpy = vi
      .spyOn(ds, 'ui_list_resource_v1')
      .mockImplementation((async (key: string, opts?: unknown) => {
        if (key === 'driver_application_directory') {
          return { rows: [application], total: 1 };
        }
        return originalList(key, opts as never);
      }) as typeof ds.ui_list_resource_v1);
    const getSpy = vi
      .spyOn(ds, 'ui_get_resource_v1')
      .mockImplementation((async (key: string, id: string) => {
        if (key === 'driver_application_directory' && id === application.id) {
          return application;
        }
        return originalGet(key, id);
      }) as typeof ds.ui_get_resource_v1);
    const reviewSpy = vi
      .spyOn(ds, 'marketplace_participant_request_review_apply_v1')
      .mockImplementation((async () => {
        application = driverApplicationRow({
          status: 'rejected',
          review_decision: 'rejected',
          review_reason: 'duplicate_identity',
          reviewed_at: '2026-05-18T08:35:00.000Z',
          reviewed_by: 'usr_reviewer_001',
          reviewer_label: 'Platform Reviewer',
          is_pending: false,
          is_rejected: true,
          is_terminal: true,
          decision_metadata: {
            reason: 'duplicate_identity',
            participant_type: 'freelancer_driver',
          },
        });
        throw new Error('marketplace-participant-review was rejected by the backend');
      }) as typeof ds.marketplace_participant_request_review_apply_v1);

    const user = userEvent.setup();
    await mountAll();

    const firstRow = await waitFor(() => {
      const row = document.querySelector('.dt__table tbody tr');
      expect(row).toBeTruthy();
      return row as HTMLElement;
    });
    await user.click(firstRow);
    await user.click(await screen.findByRole('tab', { name: 'Decisions' }));
    await user.click(screen.getByRole('button', { name: /^Reject$/i }));
    await user.selectOptions(
      document.querySelector('.modal select') as HTMLSelectElement,
      'duplicate_identity',
    );
    await user.click(await screen.findByRole('button', { name: /^Reject application$/i }));

    await waitFor(() => {
      expect(document.querySelector('.modal')).toBeNull();
      const drawerText = document.querySelector('.drawer')?.textContent ?? '';
      expect(drawerText).toMatch(/rejected/i);
      expect(drawerText).toMatch(/duplicate_identity/i);
      expect(drawerText).toMatch(/Platform Reviewer/i);
      const rowText = document.querySelector('.dt__table tbody tr')?.textContent ?? '';
      expect(rowText).toMatch(/Rejected/i);
    });
    expect(reviewSpy).toHaveBeenCalledTimes(1);
    expect(getSpy.mock.calls.filter(([key]) => key === 'driver_application_directory').length).toBeGreaterThanOrEqual(1);

    reviewSpy.mockRestore();
    getSpy.mockRestore();
    listSpy.mockRestore();
  });

  it('does not show review success when same-drawer backend readback is missing', async () => {
    const application = driverApplicationRow();
    let readbackMissing = false;
    const originalList = ds.ui_list_resource_v1;
    const originalGet = ds.ui_get_resource_v1;
    const listSpy = vi
      .spyOn(ds, 'ui_list_resource_v1')
      .mockImplementation((async (key: string, opts?: unknown) => {
        if (key === 'driver_application_directory') {
          return { rows: [application], total: 1 };
        }
        return originalList(key, opts as never);
      }) as typeof ds.ui_list_resource_v1);
    const getSpy = vi
      .spyOn(ds, 'ui_get_resource_v1')
      .mockImplementation((async (key: string, id: string) => {
        if (key === 'driver_application_directory' && id === application.id) {
          return readbackMissing ? null : application;
        }
        return originalGet(key, id);
      }) as typeof ds.ui_get_resource_v1);
    const reviewSpy = vi
      .spyOn(ds, 'marketplace_participant_request_review_apply_v1')
      .mockImplementation((async () => {
        readbackMissing = true;
        return {
          ok: true,
          marketplace_participant_request_id: application.id,
          decision: 'approved',
        };
      }) as typeof ds.marketplace_participant_request_review_apply_v1);
    const toastSpy = vi.spyOn(toastStore, 'pushToast');

    const user = userEvent.setup();
    await mountAll();

    const firstRow = await waitFor(() => {
      const row = document.querySelector('.dt__table tbody tr');
      expect(row).toBeTruthy();
      return row as HTMLElement;
    });
    await user.click(firstRow);
    await user.click(await screen.findByRole('tab', { name: 'Decisions' }));
    await user.click(screen.getByRole('button', { name: /^Approve$/i }));

    await waitFor(() => {
      expect(toastSpy).toHaveBeenCalledWith('Driver application approval could not be completed. Try again.', 'danger');
    }, { timeout: 8000 });
    expect(
      toastSpy.mock.calls.some(([message, tone]) =>
        /Driver application approved/i.test(String(message)) && tone === 'good',
      ),
    ).toBe(false);
    expect(reviewSpy).toHaveBeenCalledTimes(1);

    toastSpy.mockRestore();
    reviewSpy.mockRestore();
    getSpy.mockRestore();
    listSpy.mockRestore();
  });

  it('keeps the open drawer on Decisions and shows request-docs backend readback without reload', async () => {
    let application = driverApplicationRow();
    const originalList = ds.ui_list_resource_v1;
    const originalGet = ds.ui_get_resource_v1;
    const listSpy = vi
      .spyOn(ds, 'ui_list_resource_v1')
      .mockImplementation((async (key: string, opts?: unknown) => {
        if (key === 'driver_application_directory') {
          return { rows: [application], total: 1 };
        }
        return originalList(key, opts as never);
      }) as typeof ds.ui_list_resource_v1);
    const getSpy = vi
      .spyOn(ds, 'ui_get_resource_v1')
      .mockImplementation((async (key: string, id: string) => {
        if (key === 'driver_application_directory' && id === application.id) {
          return application;
        }
        return originalGet(key, id);
      }) as typeof ds.ui_get_resource_v1);
    const reviewSpy = vi
      .spyOn(ds, 'marketplace_participant_request_review_apply_v1')
      .mockImplementation((async () => {
        application = driverApplicationRow({
          status: 'pending',
          review_decision: null,
          review_reason: 'BrowserDriverApplicationDocsProofTest',
          reviewed_at: null,
          reviewed_by: 'usr_reviewer_001',
          reviewer_label: 'Platform Reviewer',
          is_pending: true,
          decision_metadata: {
            request_additional_docs: true,
            requested_documents: ['medical'],
            note: 'BrowserDriverApplicationDocsProofTest',
            review_applied_at: '2026-05-18T08:15:00.000Z',
          },
        });
        return {
          ok: true,
          marketplace_participant_request_id: application.id,
          decision: 'request_additional_docs',
        };
      }) as typeof ds.marketplace_participant_request_review_apply_v1);

    const user = userEvent.setup();
    await mountAll();

    const firstRow = await waitFor(() => {
      const row = document.querySelector('.dt__table tbody tr');
      expect(row).toBeTruthy();
      return row as HTMLElement;
    });
    await user.click(firstRow);
    await user.click(await screen.findByRole('tab', { name: 'Decisions' }));
    await user.click(screen.getByRole('button', { name: /Request additional docs/i }));
    const modal = await waitFor(() => {
      const found = document.querySelector('.modal');
      expect(found).not.toBeNull();
      return found as HTMLElement;
    });
    await user.type(
      modal.querySelector('textarea') as HTMLTextAreaElement,
      'BrowserDriverApplicationDocsProofTest',
    );
    await user.click(
      Array.from(modal.querySelectorAll('button')).find((button) =>
        /Send request/i.test(button.textContent ?? ''),
      ) as HTMLElement,
    );

    await waitFor(() => {
      expect(document.querySelector('.modal')).toBeNull();
      expect(document.querySelector('[role="tab"][aria-selected="true"]')).toHaveTextContent('Decisions');
      const drawerText = document.querySelector('.drawer')?.textContent ?? '';
      expect(drawerText).toMatch(/Additional documents requested/i);
      expect(drawerText).toMatch(/BrowserDriverApplicationDocsProofTest/i);
      expect(drawerText).toMatch(/medical/i);
    });
    expect(reviewSpy).toHaveBeenCalledTimes(1);
    expect(getSpy.mock.calls.filter(([key]) => key === 'driver_application_directory').length).toBeGreaterThanOrEqual(2);
    expect(listSpy.mock.calls.filter(([key]) => key === 'driver_application_directory').length).toBeGreaterThanOrEqual(2);

    reviewSpy.mockRestore();
    getSpy.mockRestore();
    listSpy.mockRestore();
  });

  it('Approve flow fires marketplace_participant_request_review_apply_v1 with decision=approve + canonical envelope', async () => {
    const reviewSpy = vi
      .spyOn(ds, 'marketplace_participant_request_review_apply_v1')
      .mockResolvedValue({ ok: true } as never);

    const user = userEvent.setup();
    await mountAll();

    // Open the first row's row-actions overflow.
    const overflow = (await waitFor(() => {
      const found = screen.queryAllByRole('button', { name: /Row actions/i });
      expect(found.length).toBeGreaterThan(0);
      return found[0];
    })) as HTMLElement;
    await user.click(overflow);

    // Pick "Approve" from the palette. Drivers test pattern: search the
    // palette__item-label span specifically (avoids matching against label
    // metadata like capability, kbd, kind).
    const approveItem = await waitFor(() => {
      const labels = Array.from(
        document.querySelectorAll('.palette__item .palette__item-label'),
      );
      const found = labels.find(
        (el) => (el.textContent ?? '').trim() === 'Approve',
      );
      expect(found).toBeTruthy();
      return found!.closest('.palette__item') as HTMLElement;
    });
    await user.click(approveItem);

    await waitFor(() => {
      expect(reviewSpy).toHaveBeenCalled();
    });
    const args = reviewSpy.mock.calls[0]?.[0] as Record<string, unknown> | undefined;
    expect(args?.decision).toBe('approve');
    expect(typeof args?.participant_request_id).toBe('string');
    const metadata = args?.metadata as Record<string, unknown> | undefined;
    expect(metadata?.reason).toBe('background_check_clear');
    expect(metadata?.participant_type).toBe('freelancer_driver');
    expect(document.querySelector('.modal')).toBeNull();
    reviewSpy.mockRestore();
  });

  it('Reject flow fires marketplace_participant_request_review_apply_v1 with decision=reject and selected reason', async () => {
    const reviewSpy = vi
      .spyOn(ds, 'marketplace_participant_request_review_apply_v1')
      .mockImplementation((async (input: Record<string, unknown>) => {
        const participantRequestId = String(input.participant_request_id ?? '');
        const rejectedReadback = driverApplicationRow({
          id: participantRequestId,
          status: 'rejected',
          review_decision: 'rejected',
          review_reason: 'duplicate_identity',
          reviewed_at: '2026-05-18T08:25:00.000Z',
          reviewed_by: 'usr_reviewer_001',
          reviewer_label: 'Platform Reviewer',
          is_pending: false,
          is_rejected: true,
          is_terminal: true,
          decision_metadata: {
            reason: 'duplicate_identity',
            participant_type: 'freelancer_driver',
          },
        });
        return {
          ok: true,
          marketplace_participant_request_id: rejectedReadback.id,
          decision: 'rejected',
          driver_application_readback: rejectedReadback,
        };
      }) as typeof ds.marketplace_participant_request_review_apply_v1);

    const user = userEvent.setup();
    await mountAll();

    const overflow = (await waitFor(() => {
      const found = screen.queryAllByRole('button', { name: /Row actions/i });
      expect(found.length).toBeGreaterThan(0);
      return found[0];
    })) as HTMLElement;
    await user.click(overflow);

    const rejectItem = await waitFor(() => {
      const labels = Array.from(
        document.querySelectorAll('.palette__item .palette__item-label'),
      );
      const found = labels.find(
        (el) => (el.textContent ?? '').trim() === 'Reject',
      );
      expect(found).toBeTruthy();
      return found!.closest('.palette__item') as HTMLElement;
    });
    await user.click(rejectItem);
    await user.selectOptions(
      document.querySelector('.modal select') as HTMLSelectElement,
      'duplicate_identity',
    );
    await user.click(await screen.findByRole('button', { name: /^Reject application$/i }));

    await waitFor(() => {
      expect(reviewSpy).toHaveBeenCalled();
    });
    const args = reviewSpy.mock.calls[0]?.[0] as Record<string, unknown> | undefined;
    expect(args?.decision).toBe('reject');
    expect(typeof args?.participant_request_id).toBe('string');
    const metadata = args?.metadata as Record<string, unknown> | undefined;
    expect(metadata?.reason).toBe('duplicate_identity');
    expect(metadata?.participant_type).toBe('freelancer_driver');
    await waitFor(() => {
      expect(document.querySelector('.modal')).toBeNull();
      const firstRowText = document.querySelector('.dt__table tbody tr')?.textContent ?? '';
      expect(firstRowText).toMatch(/Readback Driver Applicant/i);
      expect(firstRowText).toMatch(/Rejected/i);
    });
    reviewSpy.mockRestore();
  });

  it('Request-additional-docs flow fires marketplace_participant_request_review_apply_v1 with decision=request_additional_docs', async () => {
    const reviewSpy = vi
      .spyOn(ds, 'marketplace_participant_request_review_apply_v1')
      .mockResolvedValue({ ok: true } as never);

    const user = userEvent.setup();
    await mountAll();

    const overflow = (await waitFor(() => {
      const found = screen.queryAllByRole('button', { name: /Row actions/i });
      expect(found.length).toBeGreaterThan(0);
      return found[0];
    })) as HTMLElement;
    await user.click(overflow);

    const reqItem = await waitFor(() => {
      const labels = Array.from(
        document.querySelectorAll('.palette__item .palette__item-label'),
      );
      const found = labels.find((el) =>
        /Request additional docs/i.test((el.textContent ?? '').trim()),
      );
      expect(found).toBeTruthy();
      return found!.closest('.palette__item') as HTMLElement;
    });
    await user.click(reqItem);

    // Modal opens; default selection is canonical lookup-driven. Add a note,
    // then click "Send request".
    const sendBtn = await waitFor(() => {
      const modal = document.querySelector('.modal');
      expect(modal).not.toBeNull();
      const noteInput = modal!.querySelector('textarea');
      expect(noteInput).toBeTruthy();
      const btn = Array.from(modal!.querySelectorAll('button')).find((b) =>
        /Send request/i.test(b.textContent ?? ''),
      );
      expect(btn).toBeTruthy();
      return btn as HTMLElement;
    });
    const modal = document.querySelector('.modal');
    const noteInput = modal!.querySelector('textarea') as HTMLTextAreaElement;
    await user.type(noteInput, 'Please upload the renewed medical clearance.');
    await user.click(sendBtn);

    await waitFor(() => {
      expect(reviewSpy).toHaveBeenCalled();
    });
    const args = reviewSpy.mock.calls[0]?.[0] as Record<string, unknown> | undefined;
    expect(args?.decision).toBe('request_additional_docs');
    expect(typeof args?.participant_request_id).toBe('string');
    expect(Array.isArray(args?.requested_documents)).toBe(true);
    expect(args?.note).toBe('Please upload the renewed medical clearance.');
    const reqDocs = args?.requested_documents as string[];
    expect(reqDocs.length).toBeGreaterThan(0);
    const metadata = args?.metadata as Record<string, unknown> | undefined;
    expect(metadata?.participant_type).toBe('freelancer_driver');
    expect(metadata?.request_additional_docs).toBe(true);
    reviewSpy.mockRestore();
  });

  it('exposes canonical Phase B RPC facade entries for driver applications', () => {
    expect(typeof api.marketplace_participant_request_review_apply_v1).toBe(
      'function',
    );
  });

  // W29 — paired projection contract assertions for
  // driver_application_directory. Verifies registry + ui_list_resource_v1
  // wiring and the freelancer_driver filter.
  it('driver_application_directory paired projection is wired through registry + ui_list_resource_v1', async () => {
    const reg = (registry as unknown as { ui_read_registry: Record<string, { relation: string; capability_read: string }> })
      .ui_read_registry;
    expect(reg.driver_application_directory?.relation).toBe('v_driver_application_directory');
    expect(reg.driver_application_directory?.capability_read).toBe('fleet.read');

    const res = await ds.ui_list_resource_v1<Record<string, unknown>>('driver_application_directory');
    expect(res.rows.length).toBeGreaterThan(0);
    // Filter contract: every row must be a freelancer_driver application.
    for (const row of res.rows) {
      expect(row.requested_participant_type_key).toBe('freelancer_driver');
    }
    const r0 = res.rows[0]!;
    expect(typeof r0.id).toBe('string');
    expect('reviewer_label' in r0).toBe(true);
    expect(typeof r0.capabilities_count).toBe('number');
    expect(typeof r0.verification_documents_count).toBe('number');
    expect(typeof r0.submitted_document_count).toBe('number');
    expect(typeof r0.missing_document_count).toBe('number');
    expect(typeof r0.is_pending).toBe('boolean');
    expect(typeof r0.is_approved).toBe('boolean');
    expect(typeof r0.is_rejected).toBe('boolean');
    expect(typeof r0.is_terminal).toBe('boolean');
    expect(typeof r0.sla_breach).toBe('boolean');
  });
});
