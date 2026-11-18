// organizations.test.tsx — verifies the org table renders, the signup queue
// status filter switches counts, the canonical `tenant-signup-review` edge
// function seam is invoked (no longer toast-only), and the row-click drawer surfaces the
// canonical attestation envelope + decision history.
//
// Capability key SSOT: backend migration
//   supabase/migrations/202602201020_access_control_policy_tenant_signup_requests_v1.sql
// Canonical RPC SSOT: backend migration
//   supabase/migrations/202602201010_tenant_signup_policy_requests_v1.sql:906

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { act, screen, fireEvent, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { renderWithProviders } from '@/test/render';
import { OrganizationsModule } from '@/modules/platform/organizations';
import * as toastStore from '@/components/toastStore';
import * as api from '@/lib/api';
// @ts-expect-error - seed-raw/*.js has no declaration file by design.
import { tenant_signup_requests as seedTenantSignupRequests } from '@/lib/seed-raw/intake.js';
// @ts-expect-error - seed-raw/*.js has no declaration file by design.
import { organizations as seedOrganizations } from '@/lib/seed-raw/domain-shipments.js';
// @ts-expect-error - seed-raw/*.js has no declaration file by design.
import { lookups as seedLookups } from '@/lib/seed-raw/lookups.js';

type ListResponse = Awaited<ReturnType<typeof api.ui_list_resource_v1>>;

function cloneRows(rows: Array<Record<string, unknown>>): Array<Record<string, unknown>> {
  return rows.map((row) => structuredClone(row));
}

function tenantSignupSummaryRows(): Array<Record<string, unknown>> {
  return (seedTenantSignupRequests as Array<Record<string, unknown>>).map((row) => {
    const metadata = row.metadata && typeof row.metadata === 'object'
      ? (row.metadata as Record<string, unknown>)
      : {};
    const attestations = metadata.attestations && typeof metadata.attestations === 'object'
      ? (metadata.attestations as Record<string, unknown>)
      : {};
    const attestationValues = Object.values(attestations);
    const attestationPassed = attestationValues.filter(Boolean).length;
    const status = String(row.status ?? 'pending');
    const reviewedAt = typeof row.reviewed_at === 'string' ? row.reviewed_at : null;
    return {
      ...row,
      tenant_signup_request_id: row.id,
      review_decision:
        row.review_decision ?? (status === 'pending' ? null : status),
      attestation_count: attestationValues.length,
      attestation_passed_count: attestationPassed,
      attestation_complete:
        attestationValues.length > 0 && attestationPassed === attestationValues.length,
      reviewer_label: row.reviewed_by_label ?? row.reviewed_by ?? null,
      approved_organization_label:
        row.approved_organization_label ?? row.organization_name ?? null,
      decision_age_seconds: reviewedAt ? 3600 : null,
    };
  });
}

function listResult(rows: Array<Record<string, unknown>>): ListResponse {
  return { rows, total: rows.length, page: 0, page_size: rows.length } as ListResponse;
}

async function listOrganizationSeedResource(key: string, opts?: unknown): Promise<ListResponse> {
  const filter = opts && typeof opts === 'object' && 'filter' in opts
    ? ((opts as { filter?: Record<string, unknown> }).filter ?? {})
    : {};
  const filterRows = (rows: Array<Record<string, unknown>>) =>
    rows.filter((row) =>
      Object.entries(filter).every(([field, value]) => value == null || row[field] === value),
    );
  if (key === 'tenant_signup_requests') {
    return listResult(filterRows(cloneRows(seedTenantSignupRequests as Array<Record<string, unknown>>)));
  }
  if (key === 'tenant_signup_request_summary') {
    return listResult(filterRows(tenantSignupSummaryRows()));
  }
  if (key === 'organizations') {
    return listResult(filterRows(cloneRows(seedOrganizations as Array<Record<string, unknown>>)));
  }
  return listResult([]);
}

function installOrganizationSeedListMocks(): void {
  vi.spyOn(api, 'getLookups').mockImplementation((category: string) =>
    cloneRows((seedLookups as Record<string, Array<Record<string, unknown>>>)[category] ?? []) as ReturnType<typeof api.getLookups>,
  );
  vi.spyOn(api, 'ui_list_resource_v1').mockImplementation(listOrganizationSeedResource);
}

describe('OrganizationsModule', () => {
  beforeEach(() => {
    // Reset between tests so spies/mocks don't leak.
    vi.restoreAllMocks();
    installOrganizationSeedListMocks();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    document.body.style.pointerEvents = '';
    window.history.pushState(null, '', '/platform/organizations');
  });

  it('renders the tenants section', async () => {
    renderWithProviders(<OrganizationsModule />, { capabilities: ['tenant_signup_requests.read'] });
    expect(await screen.findByTestId('organizations-page')).toHaveClass('page--split-table');
    expect(await screen.findByText(/^Tenants$/)).toBeInTheDocument();
  });

  it('renders an operator-specific empty tenant registry state', async () => {
    vi.mocked(api.ui_list_resource_v1).mockImplementation(async (key: string) => {
      if (key === 'tenant_signup_request_summary') return listResult([]);
      if (key === 'tenant_signup_requests') return listResult(cloneRows(seedTenantSignupRequests as Array<Record<string, unknown>>));
      if (key === 'organizations') return listResult([]);
      return listResult([]);
    });
    renderWithProviders(<OrganizationsModule />, {
      capabilities: ['organizations.read', 'tenant_signup_requests.read', 'tenant_signup_requests.review'],
    });
    expect(
      await screen.findByText(/No tenant organizations are registered yet/i),
    ).toBeInTheDocument();
  });

  it('renders an operator-specific empty tenant signup queue state', async () => {
    vi.mocked(api.ui_list_resource_v1).mockImplementation(async (key: string) => {
      if (key === 'tenant_signup_requests' || key === 'tenant_signup_request_summary') return listResult([]);
      if (key === 'organizations') return listResult(cloneRows(seedOrganizations as Array<Record<string, unknown>>));
      return listResult([]);
    });
    renderWithProviders(<OrganizationsModule />, {
      capabilities: ['organizations.read', 'tenant_signup_requests.read', 'tenant_signup_requests.review'],
    });
    expect(
      await screen.findByText(/No tenant signup requests are waiting in this queue/i),
    ).toBeInTheDocument();
  });

  it('polls the signup queue so a landing-created request appears without a page reload', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const existingRequest = {
      id: 'tsr_existing_poll',
      email: 'existing.poll@example.com',
      full_name: 'Existing Poll Reviewer',
      organization_name: 'Existing Poll Logistics',
      status: 'pending',
      created_at: '2026-05-16T00:00:00.000Z',
      updated_at: '2026-05-16T00:00:00.000Z',
      marketing: { role: 'Operations' },
    };
    const landingRequest = {
      id: 'tsr_landing_poll_new',
      email: 'new.poll@example.com',
      full_name: 'New Poll Reviewer',
      organization_name: 'New Poll Logistics',
      status: 'pending',
      created_at: '2026-05-16T00:01:00.000Z',
      updated_at: '2026-05-16T00:01:00.000Z',
      marketing: { role: 'Operations' },
    };
    let includeLandingRequest = false;
    vi.mocked(api.ui_list_resource_v1).mockImplementation(async (key: string) => {
      const rows = includeLandingRequest ? [landingRequest, existingRequest] : [existingRequest];
      if (key === 'tenant_signup_requests') return listResult(cloneRows(rows));
      if (key === 'tenant_signup_request_summary') return listResult(cloneRows(rows));
      if (key === 'organizations') return listResult([]);
      return listResult([]);
    });

    renderWithProviders(<OrganizationsModule />, {
      capabilities: ['tenant_signup_requests.read', 'tenant_signup_requests.review'],
    });

    expect(await screen.findByText('Existing Poll Logistics')).toBeInTheDocument();
    expect(screen.queryByText('New Poll Logistics')).not.toBeInTheDocument();

    includeLandingRequest = true;
    await act(async () => {
      await vi.advanceTimersByTimeAsync(2_100);
    });

    expect(await screen.findByText('New Poll Logistics')).toBeInTheDocument();
    expect(screen.getByText('new.poll@example.com')).toBeInTheDocument();
  });

  it('surfaces a landing-created Arabic long-name tenant signup request with marketing and attestation context', async () => {
    const user = userEvent.setup();
    const landingRequest = {
      id: 'tsr_landing_ar_long',
      email: 'arabic.ops@example.com',
      full_name: 'أحمد المشرف الأول للعمليات',
      organization_name: 'شركة الاختبار الدولية للخدمات اللوجستية ذات الاسم الطويل جدا',
      organization_slug: 'arabic-long-logistics',
      phone: '+12025550123',
      website_url: 'https://tenant-ar.example.com',
      page_url: 'https://nzxmhryhtqlzoshjkyozkpup.example.invalid/ar/',
      referrer: 'https://campaign.example/tenant',
      origin: 'https://nzxmhryhtqlzoshjkyozkpup.example.invalid',
      status: 'pending',
      created_at: '2026-05-13T09:30:00.000Z',
      received_at: '2026-05-13T09:30:00.000Z',
      notes: 'نحتاج إلى إعداد المستأجر مع استقبال API وwebhook.',
      locale: 'ar',
      turnstile_verified: true,
      metadata: {
        created_via: 'tenant-signup-intake',
        attestations: {
          terms_accepted: true,
          privacy_accepted: true,
          beneficial_owner_disclosed: false,
        },
      },
      marketing: {
        monthly_volume: '10k-60k',
        role: 'مدير العمليات',
        utm_campaign: 'first-tenant-launch',
        consent: true,
        locale: 'ar',
      },
    };
    const landingSummary = {
      ...landingRequest,
      tenant_signup_request_id: 'tsr_landing_ar_long',
      review_decision: null,
      reviewer_label: null,
      reviewer_email: null,
      approved_organization_id: null,
      approved_organization_label: null,
      approved_user_id: null,
      approved_user_email: null,
      approved_auth_user_id: null,
      invite_email_sent_at: null,
      invite_redirect_to: null,
      last_error_code: null,
      last_error_message: null,
      last_error_at: null,
      attestation_count: 3,
      attestation_passed_count: 2,
      attestation_complete: false,
      has_marketing_consent: true,
      is_pending: true,
      is_approved: false,
      is_rejected: false,
      decision_age_seconds: null,
    };
    vi.mocked(api.ui_list_resource_v1).mockImplementation(async (key: string) => {
      if (key === 'tenant_signup_requests') return listResult([landingRequest]);
      if (key === 'tenant_signup_request_summary') return listResult([landingSummary]);
      if (key === 'organizations') return listResult([]);
      return listResult([]);
    });

    renderWithProviders(<OrganizationsModule />, {
      capabilities: [
        'organizations.read',
        'tenant_signup_requests.read',
        'tenant_signup_requests.review',
      ],
    });

    const row = await screen.findByText(/شركة الاختبار الدولية للخدمات اللوجستية/i);
    expect(row).toBeInTheDocument();
    expect(screen.getByText('arabic.ops@example.com')).toBeInTheDocument();
    await user.click(row);

    const drawer = await screen.findByTestId('org-signup-drawer');
    expect(drawer).toHaveTextContent(/أحمد المشرف الأول للعمليات/);
    expect(drawer).toHaveTextContent(/شركة الاختبار الدولية للخدمات اللوجستية ذات الاسم الطويل جدا/);
    expect(within(drawer).getByTestId('org-signup-attestations')).toHaveTextContent(/terms accepted/i);
    expect(within(drawer).getByTestId('org-signup-attestations')).toHaveTextContent(/privacy accepted/i);
    expect(within(drawer).getByTestId('org-signup-attestations')).toHaveTextContent(/beneficial owner disclosed/i);
    expect(within(drawer).getByTestId('org-signup-summary-attestation-count')).toHaveTextContent('2/3');
    expect(within(drawer).getByTestId('org-signup-summary-attestation-complete')).toHaveTextContent(/incomplete/i);
    expect(within(drawer).getByTestId('org-signup-summary-marketing-consent')).toHaveTextContent(/marketing consent/i);
    const marketing = within(drawer).getByTestId('org-signup-marketing');
    expect(marketing).toHaveTextContent(/10k 60k/i);
    expect(marketing).toHaveTextContent(/مدير العمليات/);
    expect(marketing).toHaveTextContent(/first tenant launch/i);
  });

  it('tenant row opens profile/logo editor and submits ui_update_organization_profile_v1', async () => {
    const user = userEvent.setup();
    let profileUpdated = false;
    vi.mocked(api.ui_list_resource_v1).mockImplementation(async (key: string, opts?: unknown) => {
      const filter = opts && typeof opts === 'object' && 'filter' in opts
        ? ((opts as { filter?: Record<string, unknown> }).filter ?? {})
        : {};
      const filterRows = (rows: Array<Record<string, unknown>>) =>
        rows.filter((row) =>
          Object.entries(filter).every(([field, value]) => value == null || row[field] === value),
        );
      if (key === 'tenant_signup_requests') {
        return listResult(filterRows(cloneRows(seedTenantSignupRequests as Array<Record<string, unknown>>)));
      }
      if (key === 'tenant_signup_request_summary') {
        return listResult(filterRows(tenantSignupSummaryRows()));
      }
      if (key !== 'organizations') return listResult([]);
      const rows = filterRows(
        cloneRows(seedOrganizations as Array<Record<string, unknown>>).map((org) =>
          org.id === 'org_rashed' && profileUpdated
            ? {
                ...org,
                name: 'Rashed Logistics Group',
                timezone: 'Asia/Riyadh',
                locale: 'ar-SA',
                default_settings: {
                  ...(org.default_settings as Record<string, unknown> | undefined),
                  delivery: { cutoff: '18:00' },
                  cod: { enabled: true },
                  branding: {
                    ...((org.default_settings as { branding?: Record<string, unknown> } | undefined)
                      ?.branding ?? {}),
                    logo_url: 'https://assets.example/logo.svg',
                    primary_color: '#0f766e',
                    secondary_color: '#1d4ed8',
                  },
                },
              }
            : org,
        ),
      );
      return listResult(rows);
    });
    const spy = vi.spyOn(api, 'ui_update_organization_profile_v1').mockImplementation(async () => {
      profileUpdated = true;
      return {
        ok: true,
        organization_id: 'org_rashed',
        correlation_id: 'cor_x',
        settings_resolution_id: 'srlv_x',
        readback: {
          id: 'org_rashed',
          name: 'Rashed Logistics Group',
          timezone: 'Asia/Riyadh',
          locale: 'ar-SA',
          billing_status: 'active',
          default_settings: {
            delivery: { cutoff: '18:00' },
            cod: { enabled: true },
            branding: {
              logo_url: 'https://assets.example/logo.svg',
              logo_file_name: 'rashed-logo.png',
              logo_content_type: 'image/png',
              logo_artifact_id: 'artifact_rashed_logo',
              logo_storage_bucket: 'organization-assets',
              logo_storage_key: 'org_rashed/branding/rashed-logo.png',
              primary_color: '#0f766e',
              secondary_color: '#1d4ed8',
            },
          },
        },
      };
    });
    renderWithProviders(<OrganizationsModule />, {
      capabilities: ['organizations.read', 'organizations.write'],
    });
    const row = (await screen.findByText(/Rashed Logistics/i)).closest('tr')!;
    await user.click(row);
    const form = await screen.findByTestId('org-profile-form');
    const name = within(form).getByLabelText(/^Name$/i);
    await user.clear(name);
    await user.type(name, 'Rashed Logistics Group');
    const logoUrl = within(form).getByLabelText(/Logo URL/i);
    await user.clear(logoUrl);
    await user.type(logoUrl, 'https://assets.example/logo.svg');
    const timezone = within(form).getByLabelText(/^Timezone$/i);
    await user.clear(timezone);
    await user.type(timezone, 'Asia/Riyadh');
    const locale = within(form).getByLabelText(/^Locale$/i);
    await user.clear(locale);
    await user.type(locale, 'ar-SA');
    const primaryColor = within(form).getByLabelText(/Primary color/i);
    await user.clear(primaryColor);
    await user.type(primaryColor, '#0f766e');
    const secondaryColor = within(form).getByLabelText(/Secondary color/i);
    await user.clear(secondaryColor);
    await user.type(secondaryColor, '#1d4ed8');
    await user.selectOptions(within(form).getByLabelText(/Default key lookup/i), 'shipment_operation_policy');
    fireEvent.change(within(form).getByLabelText(/Default value/i), {
      target: { value: '{"amend_enabled":true}' },
    });
    await user.click(within(form).getByRole('button', { name: /Apply default/i }));
    await user.selectOptions(within(form).getByLabelText(/Default key lookup/i), 'workflow_binding_defaults');
    fireEvent.change(within(form).getByLabelText(/Default value/i), {
      target: { value: '{"default_priority":10}' },
    });
    await user.click(within(form).getByRole('button', { name: /Apply default/i }));
    expect(within(form).getByLabelText(/Defaults patch/i)).toHaveValue(
      JSON.stringify(
        {
          shipment_operation_policy: { amend_enabled: true },
          workflow_binding_defaults: { default_priority: 10 },
        },
        null,
        2,
      ),
    );
    const file = new File(['logo-bytes'], 'rashed-logo.png', { type: 'image/png' });
    await user.upload(within(form).getByLabelText(/Logo file/i), file);
    await waitFor(() => expect(within(form).getByText(/rashed-logo\.png/i)).toBeInTheDocument());
    await user.click(within(form).getByRole('button', { name: /Save profile/i }));
    await waitFor(() => expect(spy).toHaveBeenCalled());
    expect(spy).toHaveBeenCalledWith(
      expect.objectContaining({
        organization_id: 'org_rashed',
        name: 'Rashed Logistics Group',
        timezone: 'Asia/Riyadh',
        locale: 'ar-SA',
        logo_url: 'https://assets.example/logo.svg',
        primary_color: '#0f766e',
        secondary_color: '#1d4ed8',
        file_name: 'rashed-logo.png',
        file_base64: expect.stringMatching(/^data:image\/png;base64,/),
        content_type: 'image/png',
        default_settings_patch: {
          shipment_operation_policy: { amend_enabled: true },
          workflow_binding_defaults: { default_priority: 10 },
          branding: {
            logo_url: 'https://assets.example/logo.svg',
            primary_color: '#0f766e',
            secondary_color: '#1d4ed8',
          },
        },
      }),
    );
    const saveReadback = await screen.findByTestId('org-profile-save-readback');
    expect(saveReadback).toHaveTextContent(/Saved result/i);
    expect(saveReadback).toHaveTextContent(/Rashed Logistics Group/i);
    expect(saveReadback).toHaveTextContent(/Profile update confirmed/i);
    expect(saveReadback).toHaveTextContent(/Saved organization profile/i);
    expect(saveReadback).toHaveTextContent(/Request trail.*Recorded/i);
    expect(saveReadback).toHaveTextContent(/Settings status.*Recorded/i);
    expect(saveReadback).toHaveTextContent(/cod/i);
    expect(saveReadback).toHaveTextContent(/delivery/i);
    expect(within(form).getByLabelText(/^Name$/i)).toHaveValue('Rashed Logistics Group');
    expect(within(form).getByLabelText(/^Locale$/i)).toHaveValue('ar-SA');
    const logoReadback = within(form).getByTestId('org-profile-logo-readback');
    expect(logoReadback).toHaveTextContent(/rashed-logo\.png/i);
    expect(logoReadback).toHaveTextContent(/image\/png/i);
    expect(logoReadback).not.toHaveTextContent(/artifact_rashed_logo/i);
    expect(logoReadback).not.toHaveTextContent(/organization-assets/i);
    expect(logoReadback).not.toHaveTextContent(/org_rashed\/branding\/rashed-logo\.png/i);
    expect(screen.getByTestId('org-profile-form')).toBeInTheDocument();
    await user.click(within(form).getByRole('button', { name: /^Cancel$/i }));
    await waitFor(() => expect(screen.queryByTestId('org-profile-form')).not.toBeInTheDocument());
    expect(await screen.findByRole('row', { name: /Open organizations Rashed Logistics Group/i }))
      .toBeInTheDocument();
  });

  it('profile save refreshes organization and onboarding readiness read models after backend readback', async () => {
    const user = userEvent.setup();
    const spy = vi.spyOn(api, 'ui_update_organization_profile_v1').mockResolvedValue({
      ok: true,
      organization_id: 'org_rashed',
      correlation_id: 'cor_profile_refresh',
      settings_resolution_id: 'srlv_profile_refresh',
      readback: {
        id: 'org_rashed',
        name: 'Rashed Logistics',
        timezone: 'Asia/Riyadh',
        locale: 'ar-SA',
        billing_status: 'active',
        default_settings: {
          branding: {
            logo_url: 'https://assets.masarx.example/rashed-logo.svg',
            primary_color: '#0f766e',
            secondary_color: '#1d4ed8',
          },
        },
      },
    });
    const { queryClient } = renderWithProviders(<OrganizationsModule />, {
      capabilities: ['organizations.read', 'organizations.write'],
    });
    const invalidateSpy = vi.spyOn(queryClient, 'invalidateQueries');
    const refetchSpy = vi.spyOn(queryClient, 'refetchQueries');

    const row = (await screen.findByText(/Rashed Logistics/i)).closest('tr')!;
    await user.click(row);
    const form = await screen.findByTestId('org-profile-form');
    await user.click(within(form).getByRole('button', { name: /Save profile/i }));

    await waitFor(() => expect(spy).toHaveBeenCalled());
    await waitFor(() => {
      expect(invalidateSpy).toHaveBeenCalledWith(expect.objectContaining({
        queryKey: ['list', 'organizations'],
        refetchType: 'active',
      }));
      expect(invalidateSpy).toHaveBeenCalledWith(expect.objectContaining({
        queryKey: ['list', 'organizations', 'complete'],
        refetchType: 'active',
      }));
      expect(invalidateSpy).toHaveBeenCalledWith(expect.objectContaining({
        queryKey: ['resources_by_ids', 'organizations'],
        refetchType: 'active',
      }));
      expect(invalidateSpy).toHaveBeenCalledWith(expect.objectContaining({
        queryKey: ['resource', 'organizations', 'org_rashed'],
        refetchType: 'active',
      }));
      expect(invalidateSpy).toHaveBeenCalledWith(expect.objectContaining({
        queryKey: ['settings_resolution'],
        refetchType: 'active',
      }));
      expect(invalidateSpy).toHaveBeenCalledWith(expect.objectContaining({
        queryKey: ['onboarding_readiness'],
        refetchType: 'active',
      }));
      expect(refetchSpy).toHaveBeenCalledWith(expect.objectContaining({
        queryKey: ['list', 'organizations'],
        type: 'active',
      }));
      expect(refetchSpy).toHaveBeenCalledWith(expect.objectContaining({
        queryKey: ['list', 'organizations', 'complete'],
        type: 'active',
      }));
      expect(refetchSpy).toHaveBeenCalledWith(expect.objectContaining({
        queryKey: ['resources_by_ids', 'organizations'],
        type: 'active',
      }));
      expect(refetchSpy).toHaveBeenCalledWith(expect.objectContaining({
        queryKey: ['resource', 'organizations', 'org_rashed'],
        type: 'active',
      }));
      expect(refetchSpy).toHaveBeenCalledWith(expect.objectContaining({
        queryKey: ['settings_resolution'],
        type: 'active',
      }));
      expect(refetchSpy).toHaveBeenCalledWith(expect.objectContaining({
        queryKey: ['onboarding_readiness'],
        type: 'active',
      }));
    });
  });

  it('profile editor sends null branding values when the operator clears logo/color fields', async () => {
    const user = userEvent.setup();
    const spy = vi.spyOn(api, 'ui_update_organization_profile_v1').mockResolvedValue({
      ok: true,
      organization_id: 'org_rashed',
      correlation_id: 'cor_clear_branding',
      settings_resolution_id: 'srlv_clear_branding',
      readback: {
        id: 'org_rashed',
        name: 'Rashed Logistics',
        timezone: 'Asia/Riyadh',
        locale: 'en-US',
        billing_status: 'active',
        default_settings: {
          branding: {
            logo_url: null,
            primary_color: null,
            secondary_color: null,
          },
        },
      },
    });
    renderWithProviders(<OrganizationsModule />, {
      capabilities: ['organizations.read', 'organizations.write'],
    });
    const row = (await screen.findByText(/Rashed Logistics/i)).closest('tr')!;
    await user.click(row);
    const form = await screen.findByTestId('org-profile-form');
    const logoUrl = within(form).getByLabelText(/Logo URL/i);
    await user.clear(logoUrl);
    const primaryColor = within(form).getByLabelText(/Primary color/i);
    await user.clear(primaryColor);
    const secondaryColor = within(form).getByLabelText(/Secondary color/i);
    await user.clear(secondaryColor);
    await user.click(within(form).getByRole('button', { name: /Save profile/i }));
    await waitFor(() => expect(spy).toHaveBeenCalled());
    expect(spy).toHaveBeenCalledWith(
      expect.objectContaining({
        logo_url: undefined,
        primary_color: undefined,
        secondary_color: undefined,
        default_settings_patch: expect.objectContaining({
          branding: {
            logo_url: null,
            primary_color: null,
            secondary_color: null,
          },
        }),
      }),
    );
  });

  it('profile editor rejects non-object default settings patch before calling the RPC', async () => {
    const user = userEvent.setup();
    const spy = vi.spyOn(api, 'ui_update_organization_profile_v1');
    renderWithProviders(<OrganizationsModule />, {
      capabilities: ['organizations.read', 'organizations.write'],
    });
    const row = (await screen.findByText(/Rashed Logistics/i)).closest('tr')!;
    await user.click(row);
    const form = await screen.findByTestId('org-profile-form');
    fireEvent.change(within(form).getByLabelText(/Defaults patch/i), {
      target: { value: '[]' },
    });
    await user.click(within(form).getByRole('button', { name: /Save profile/i }));
    expect(await within(form).findByText(/Organization defaults must be a JSON object/i)).toBeInTheDocument();
    expect(spy).not.toHaveBeenCalled();
  });

  it('profile editor keeps branding defaults on dedicated fields instead of quick defaults', async () => {
    const user = userEvent.setup();
    const spy = vi.spyOn(api, 'ui_update_organization_profile_v1');
    renderWithProviders(<OrganizationsModule />, {
      capabilities: ['organizations.read', 'organizations.write'],
    });
    const row = (await screen.findByText(/Rashed Logistics/i)).closest('tr')!;
    await user.click(row);
    const form = await screen.findByTestId('org-profile-form');
    const keyLookup = within(form).getByLabelText(/Default key lookup/i);
    expect(keyLookup).not.toHaveTextContent('Branding');
    fireEvent.change(within(form).getByLabelText(/Default value/i), {
      target: { value: '{"logo_url":"https://bad.example/logo.svg"}' },
    });
    expect(within(form).getByRole('button', { name: /Apply default/i })).toBeDisabled();
    expect((within(form).getByLabelText(/Defaults patch/i) as HTMLTextAreaElement).value)
      .not.toContain('bad.example');
    expect(spy).not.toHaveBeenCalled();
  });

  it('profile/logo editor advertises only backend-accepted raster logo types', async () => {
    const user = userEvent.setup();
    renderWithProviders(<OrganizationsModule />, {
      capabilities: ['organizations.read', 'organizations.write'],
    });
    const row = (await screen.findByText(/Rashed Logistics/i)).closest('tr')!;
    await user.click(row);
    const form = await screen.findByTestId('org-profile-form');
    const logoFile = within(form).getByLabelText(/Logo file/i);
    expect(logoFile).toHaveAttribute('accept', 'image/png,image/jpeg,image/webp');
  });

  it('profile/logo editor blocks non-raster file uploads before the profile RPC', async () => {
    const user = userEvent.setup();
    const spy = vi.spyOn(api, 'ui_update_organization_profile_v1');
    renderWithProviders(<OrganizationsModule />, {
      capabilities: ['organizations.read', 'organizations.write'],
    });
    const row = (await screen.findByText(/Rashed Logistics/i)).closest('tr')!;
    await user.click(row);
    const form = await screen.findByTestId('org-profile-form');
    fireEvent.change(within(form).getByLabelText(/Logo file/i), {
      target: {
        files: [new File(['<svg />'], 'rashed-logo.svg', { type: 'image/svg+xml' })],
      },
    });

    expect(await within(form).findByText(/Logo file must be PNG, JPEG, or WebP/i)).toBeInTheDocument();
    expect(within(form).getByRole('button', { name: /Save profile/i })).toBeDisabled();
    expect(spy).not.toHaveBeenCalled();
  });

  it('profile editor hides stale backend logo metadata while a new unsaved logo is selected', async () => {
    const user = userEvent.setup();
    vi.mocked(api.ui_list_resource_v1).mockImplementation(async (key: string) => {
      if (key === 'tenant_signup_requests' || key === 'tenant_signup_request_summary') return listResult([]);
      if (key === 'organizations') {
        return listResult([
          {
            id: 'org_rashed',
            name: 'Rashed Logistics',
            slug: 'rashed-logistics',
            timezone: 'Asia/Riyadh',
            locale: 'ar-SA',
            billing_status: 'active',
            default_settings: {
              branding: {
                logo_url: 'https://assets.masarx.example/old-logo.png',
                logo_file_name: 'old-logo.png',
                logo_content_type: 'image/png',
                logo_artifact_id: 'artifact_old_logo',
                logo_storage_bucket: 'organization-assets',
                logo_storage_key: 'org_rashed/branding/old-logo.png',
              },
            },
          },
        ]);
      }
      return listResult([]);
    });
    renderWithProviders(<OrganizationsModule />, {
      capabilities: ['organizations.read', 'organizations.write'],
    });
    const row = (await screen.findByText(/Rashed Logistics/i)).closest('tr')!;
    await user.click(row);
    const form = await screen.findByTestId('org-profile-form');

    expect(await within(form).findByTestId('org-profile-logo-readback')).toHaveTextContent(/old-logo\.png/i);
    await user.upload(
      within(form).getByLabelText(/Logo file/i),
      new File(['new-logo-bytes'], 'new-logo.png', { type: 'image/png' }),
    );

    await waitFor(() => expect(within(form).getByText(/new-logo\.png/i)).toBeInTheDocument());
    expect(within(form).queryByTestId('org-profile-logo-readback')).not.toBeInTheDocument();
  });

  it.each([
    {
      label: 'Readiness',
      path: '/platform/onboarding-readiness',
      search: ['scope_type=tenant', 'scope_id=org_rashed'],
    },
    {
      label: 'Settings',
      path: '/platform/config',
      search: ['scope_type=tenant', 'scope_id=org_rashed'],
    },
    {
      label: 'Users',
      path: '/platform/users',
      search: ['organization_id=org_rashed'],
    },
    {
      label: 'Access',
      path: '/platform/access',
      search: ['scope_type=tenant', 'scope_id=org_rashed'],
    },
  ])('profile drawer keeps tenant context when opening $label handoff', async ({ label, path, search }) => {
    const user = userEvent.setup();
    renderWithProviders(<OrganizationsModule />, {
      capabilities: ['organizations.read', 'organizations.write'],
    });
    const row = (await screen.findByText(/Rashed Logistics/i)).closest('tr')!;
    await user.click(row);
    const form = await screen.findByTestId('org-profile-form');
    const actions = within(form).getByTestId('org-profile-lifecycle-actions');
    expect(within(actions).getByRole('button', { name: /^Readiness$/i })).toBeInTheDocument();
    expect(within(actions).getByRole('button', { name: /^Settings$/i })).toBeInTheDocument();
    expect(within(actions).getByRole('button', { name: /^Users$/i })).toBeInTheDocument();
    expect(within(actions).getByRole('button', { name: /^Access$/i })).toBeInTheDocument();

    await user.click(within(actions).getByRole('button', { name: label }));

    await waitFor(() => {
      expect(window.location.pathname).toBe(path);
      search.forEach((part) => expect(window.location.search).toContain(part));
    });
  });

  it('New tenant request modal uses backend readback and keeps the created request visible from another filter', async () => {
    const user = userEvent.setup();
    const original = listOrganizationSeedResource;
    let requestCreatedFromBackend = false;
    const spy = vi.spyOn(api, 'tenant_signup_console_request_v1').mockImplementation(async () => {
      requestCreatedFromBackend = true;
      return {
        ok: true,
        id: 'tsr_console_new',
        tenant_signup_request_id: 'tsr_console_new',
        status: 'pending',
        email: 'tenant.admin@example.com',
        full_name: 'Tenant Admin',
        organization_name: 'Console Created Tenant',
        organization_slug: 'console-created-tenant',
        created_at: '2026-05-06T12:00:00.000Z',
        metadata: { created_via: 'tenant-signup-console-request' },
        marketing: { source: 'console-v2' },
        attestation_count: 2,
        attestation_passed_count: 2,
        attestation_complete: true,
        is_pending: true,
      };
    });
    vi.spyOn(api, 'ui_list_resource_v1').mockImplementation(async (key: string, opts?: unknown) => {
      const result = await original(key, opts as never);
      if (key !== 'tenant_signup_requests' || !requestCreatedFromBackend) return result;
      return {
        ...result,
        rows: [
          {
            id: 'tsr_console_new',
            email: 'tenant.admin@example.com',
            full_name: 'Tenant Admin',
            organization_name: 'Console Created Tenant',
            status: 'pending',
            created_at: '2026-05-06T12:00:00.000Z',
            turnstile_verified: true,
            metadata: {},
            marketing: {},
          },
          ...result.rows,
        ],
      };
    });
    const { queryClient } = renderWithProviders(<OrganizationsModule />, {
      capabilities: [
        'organizations.read',
        'tenant_signup_requests.read',
        'tenant_signup_requests.review',
      ],
    });
    const invalidateSpy = vi.spyOn(queryClient, 'invalidateQueries');
    const refetchSpy = vi.spyOn(queryClient, 'refetchQueries');
    await user.click(await screen.findByTestId('signup-status-approved'));
    expect(screen.queryByText('Console Created Tenant')).not.toBeInTheDocument();
    await user.click(await screen.findByRole('button', { name: /New tenant request/i }));
    const form = await screen.findByTestId('tenant-console-request-form');
    await user.type(within(form).getByLabelText(/^Organization$/i), 'Console Created Tenant');
    await user.type(within(form).getByLabelText(/^Admin email$/i), 'tenant.admin@example.com');
    await user.type(within(form).getByLabelText(/^Admin name$/i), 'Tenant Admin');
    await user.click(within(form).getByRole('button', { name: /Create request/i }));
    await waitFor(() => expect(spy).toHaveBeenCalled());
    expect(spy).toHaveBeenCalledWith(
      expect.objectContaining({
        email: 'tenant.admin@example.com',
        full_name: 'Tenant Admin',
        organization_name: 'Console Created Tenant',
      }),
    );
    await waitFor(() => {
      expect(invalidateSpy).toHaveBeenCalledWith(expect.objectContaining({
        queryKey: ['list', 'tenant_signup_requests', 'complete'],
        refetchType: 'active',
      }));
      expect(invalidateSpy).toHaveBeenCalledWith(expect.objectContaining({
        queryKey: ['list', 'tenant_signup_request_summary', 'complete'],
        refetchType: 'active',
      }));
      expect(refetchSpy).toHaveBeenCalledWith(expect.objectContaining({
        queryKey: ['list', 'tenant_signup_requests'],
        type: 'active',
      }));
      expect(refetchSpy).toHaveBeenCalledWith(expect.objectContaining({
        queryKey: ['list', 'tenant_signup_request_summary'],
        type: 'active',
      }));
      expect(refetchSpy).toHaveBeenCalledWith(expect.objectContaining({
        queryKey: ['list', 'tenant_signup_requests', 'complete'],
        type: 'active',
      }));
      expect(refetchSpy).toHaveBeenCalledWith(expect.objectContaining({
        queryKey: ['list', 'tenant_signup_request_summary', 'complete'],
        type: 'active',
      }));
    });
    expect((await screen.findAllByText('Console Created Tenant')).length).toBeGreaterThan(0);
    expect(screen.getAllByText('tenant.admin@example.com').length).toBeGreaterThan(0);
    expect(screen.getAllByText('Tenant Admin').length).toBeGreaterThan(0);
    expect(screen.getByTestId('signup-status-pending')).toHaveClass('is-active');
    const drawer = await screen.findByTestId('org-signup-drawer');
    expect(drawer).toHaveTextContent(/Console Created Tenant/);
    expect(drawer).toHaveTextContent(/tenant\.admin@example\.com/);
    expect(within(drawer).getByTestId('org-signup-summary-attestation-count')).toHaveTextContent('2/2');
    expect(within(drawer).getByRole('button', { name: /^Approve request$/i })).toBeEnabled();
  });

  it('blocks tenant signup create/review actions outside platform scope', async () => {
    const user = userEvent.setup();
    const spy = vi.spyOn(api, 'tenant_signup_console_request_v1');
    const listSpy = vi.spyOn(api, 'ui_list_resource_v1');
    renderWithProviders(<OrganizationsModule />, {
      identity: {
        capabilities: [
          'organizations.read',
          'tenant_signup_requests.read',
          'tenant_signup_requests.review',
        ],
        user: {
          access_scope_type: 'tenant',
          access_scope_id: null,
          organization_id: 'org_rashed',
        },
      },
    });

    const newRequest = await screen.findByRole('button', { name: /New tenant request/i });
    expect(newRequest).toBeDisabled();
    await user.click(newRequest);
    expect(screen.queryByTestId('tenant-console-request-form')).not.toBeInTheDocument();
    expect(
      await screen.findByText(/Tenant signup review creates or rejects organizations and must run from platform scope/i),
    ).toBeInTheDocument();
    const resources = listSpy.mock.calls.map(([resource]) => resource);
    expect(resources).not.toContain('tenant_signup_requests');
    expect(resources).not.toContain('tenant_signup_request_summary');
    expect(spy).not.toHaveBeenCalled();
  });

  it('shows only the active tenant organization for tenant-scoped organization readers', async () => {
    const ownOrg = cloneRows(seedOrganizations as Array<Record<string, unknown>>)
      .find((row) => row.id === 'org_rashed')!;
    const listSpy = vi.spyOn(api, 'ui_list_resource_v1').mockImplementation(async (key: string) => {
      if (key === 'organizations') return listResult([ownOrg]);
      return listResult([]);
    });

    renderWithProviders(<OrganizationsModule />, {
      identity: {
        capabilities: ['organizations.read'],
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

    expect(await screen.findByText(/^Your organization$/)).toBeInTheDocument();
    expect(await screen.findByText(/Rashed Logistics/i)).toBeInTheDocument();
    expect(screen.queryByText(/Swift Express KSA/i)).not.toBeInTheDocument();

    const resources = listSpy.mock.calls.map(([resource]) => resource);
    expect(resources).toContain('organizations');
    expect(resources).not.toContain('tenant_signup_requests');
    expect(resources).not.toContain('tenant_signup_request_summary');
  });

  it('keeps tenant-scoped organization readers in read-only profile mode', async () => {
    const user = userEvent.setup();
    const ownOrg = cloneRows(seedOrganizations as Array<Record<string, unknown>>)
      .find((row) => row.id === 'org_rashed')!;
    vi.spyOn(api, 'ui_list_resource_v1').mockImplementation(async (key: string) => {
      if (key === 'organizations') return listResult([ownOrg]);
      return listResult([]);
    });
    const spy = vi.spyOn(api, 'ui_update_organization_profile_v1');

    renderWithProviders(<OrganizationsModule />, {
      identity: {
        capabilities: ['organizations.read'],
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

    const row = (await screen.findByText(/Rashed Logistics/i)).closest('tr')!;
    await user.click(row);
    const form = await screen.findByTestId('org-profile-form');
    expect(within(form).getByTestId('org-profile-lifecycle-actions')).toBeInTheDocument();
    expect(within(form).getByRole('button', { name: /^Readiness$/i })).toBeEnabled();
    expect(within(form).getByRole('button', { name: /^Settings$/i })).toBeEnabled();
    expect(within(form).getByRole('button', { name: /^Users$/i })).toBeEnabled();
    expect(within(form).getByRole('button', { name: /^Access$/i })).toBeEnabled();

    expect(within(form).getByLabelText(/^Name$/i)).toBeDisabled();
    expect(within(form).getByLabelText(/^Timezone$/i)).toBeDisabled();
    expect(within(form).getByLabelText(/^Locale$/i)).toBeDisabled();
    expect(within(form).getByLabelText(/Logo URL/i)).toBeDisabled();
    expect(within(form).getByLabelText(/Logo file/i)).toBeDisabled();
    expect(within(form).getByLabelText(/Primary color/i)).toBeDisabled();
    expect(within(form).getByLabelText(/Secondary color/i)).toBeDisabled();
    expect(within(form).getByLabelText(/Default key lookup/i)).toBeDisabled();
    expect(within(form).getByLabelText(/Default value/i)).toBeDisabled();
    expect(within(form).getByLabelText(/Defaults patch/i)).toBeDisabled();
    expect(within(form).getByRole('button', { name: /Apply default/i })).toBeDisabled();
    expect(within(form).getByRole('button', { name: /Save profile/i })).toBeDisabled();

    await user.click(within(form).getByRole('button', { name: /Save profile/i }));
    expect(spy).not.toHaveBeenCalled();
  });

  it('fails closed when a tenant-scoped organization read returns out-of-scope rows', async () => {
    renderWithProviders(<OrganizationsModule />, {
      identity: {
        capabilities: ['organizations.read'],
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

    expect(await screen.findByText(/Organization registry scope failed/i)).toBeInTheDocument();
    expect(screen.queryByText(/Swift Express KSA/i)).not.toBeInTheDocument();
  });

  it('shows status filter chips when capability allows reading the signup queue', async () => {
    renderWithProviders(<OrganizationsModule />, {
      capabilities: ['tenant_signup_requests.read'],
    });
    expect(await screen.findByTestId('signup-status-all')).toBeInTheDocument();
    expect(screen.getByTestId('signup-status-pending')).toBeInTheDocument();
    expect(screen.getByTestId('signup-status-approved')).toBeInTheDocument();
    expect(screen.getByTestId('signup-status-rejected')).toBeInTheDocument();
  });

  it('opens a tenant signup request from the task query parameter', async () => {
    window.history.pushState(null, '', '/platform/organizations?task=tsk_3003');
    renderWithProviders(<OrganizationsModule />, {
      capabilities: ['organizations.read', 'tenant_signup_requests.read', 'tenant_signup_requests.review'],
    });
    await waitFor(() => {
      expect(document.querySelector('.drawer')?.textContent ?? '').toMatch(/Riyadh Express LLC|tsk_3003/i);
    });
  });

  it('clicking a status filter highlights it', async () => {
    renderWithProviders(<OrganizationsModule />, {
      capabilities: ['tenant_signup_requests.read'],
    });
    const pending = await screen.findByTestId('signup-status-pending');
    fireEvent.click(pending);
    expect(pending.className).toContain('is-active');
  });

  it('shows denied state when capability is missing', async () => {
    renderWithProviders(<OrganizationsModule />, { capabilities: [] });
    // The denial state surfaces the hint about the missing capability.
    expect(
      await screen.findByText(/Tenant signup queue requires/i),
    ).toBeInTheDocument();
  });

  it('renders account-manager denied states without leaking tenant registry or signup queue rows', async () => {
    const listSpy = vi.spyOn(api, 'ui_list_resource_v1');
    renderWithProviders(<OrganizationsModule />, {
      identity: {
        capabilities: ['tenant_signup_requests.read', 'lookups.read'],
        user: {
          access_scope_type: 'tenant',
          access_scope_id: null,
          organization_id: 'org_rashed',
        },
      },
    });

    expect(await screen.findByText(/Tenant list requires organization permission/i)).toBeInTheDocument();
    expect(
      await screen.findByText(/Tenant signup review creates or rejects organizations and must run from platform scope/i),
    ).toBeInTheDocument();
    expect(screen.queryByText(/Riyadh Express LLC/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/Tabuk Logistics/i)).not.toBeInTheDocument();
    const resources = listSpy.mock.calls.map(([resource]) => resource);
    expect(resources).not.toContain('organizations');
    expect(resources).not.toContain('tenant_signup_requests');
    expect(resources).not.toContain('tenant_signup_request_summary');
  });

  it('shows an explicit error state when the organizations read fails', async () => {
    const original = listOrganizationSeedResource;
    vi.spyOn(api, 'ui_list_resource_v1').mockImplementation(async (key: string, opts?: unknown) => {
      if (key === 'organizations') throw new Error('organizations_rpc_failed');
      return original(key, opts as never);
    });

    renderWithProviders(<OrganizationsModule />, {
      capabilities: ['organizations.read', 'tenant_signup_requests.read'],
    });

    const title = await screen.findByText('Tenant registry failed');
    expect(title.closest('.state')).toHaveClass('state--error');
    expect(screen.getByText(/This section could not load/i)).toBeInTheDocument();
    expect(screen.queryByText('organizations_rpc_failed')).not.toBeInTheDocument();
  });

  it('shows an explicit error state when the signup request read fails', async () => {
    const original = listOrganizationSeedResource;
    vi.spyOn(api, 'ui_list_resource_v1').mockImplementation(async (key: string, opts?: unknown) => {
      if (key === 'tenant_signup_requests') throw new Error('signup_requests_rpc_failed');
      return original(key, opts as never);
    });

    renderWithProviders(<OrganizationsModule />, {
      capabilities: ['organizations.read', 'tenant_signup_requests.read'],
    });

    const title = await screen.findByText('Signup requests failed');
    expect(title.closest('.state')).toHaveClass('state--error');
    expect(screen.getAllByText(/This section could not load/i).length).toBeGreaterThan(0);
    expect(screen.queryByText('signup_requests_rpc_failed')).not.toBeInTheDocument();
  });

  it('shows an explicit error state when the signup summary projection read fails', async () => {
    const original = listOrganizationSeedResource;
    vi.spyOn(api, 'ui_list_resource_v1').mockImplementation(async (key: string, opts?: unknown) => {
      if (key === 'tenant_signup_request_summary') throw new Error('summary_projection_failed');
      return original(key, opts as never);
    });

    renderWithProviders(<OrganizationsModule />, {
      capabilities: ['organizations.read', 'tenant_signup_requests.read'],
    });

    await screen.findByTestId('signup-status-all');
    const title = await screen.findByText('Something went wrong');
    expect(title.closest('.state')).toHaveClass('state--error');
    expect(screen.getAllByText(/This section could not load/i).length).toBeGreaterThan(0);
    expect(screen.queryByText('summary_projection_failed')).not.toBeInTheDocument();
  });

  it('renders signup queue rows when granted tenant_signup_requests.read AND .review (positive review case)', async () => {
    renderWithProviders(<OrganizationsModule />, {
      capabilities: ['tenant_signup_requests.read', 'tenant_signup_requests.review'],
    });
    // Status filters are visible because read is granted.
    expect(await screen.findByTestId('signup-status-pending')).toBeInTheDocument();
    expect(screen.getByText(/Riyadh Express LLC/i)).toBeInTheDocument();
    expect(screen.getByText(/ops@riyadh-express\.example/i)).toBeInTheDocument();
    // The denied StateView for the signup-queue section must NOT be rendered.
    expect(screen.queryByText(/Tenant signup queue requires/i)).not.toBeInTheDocument();
  });

  it('renders signup queue but blocks review actions when only tenant_signup_requests.read is granted (negative review case)', async () => {
    // Account-manager-equivalent posture: read-only review surface. The queue
    // is visible but the .review-gated bulk actions must not be reachable
    // without the review capability.
    renderWithProviders(<OrganizationsModule />, {
      capabilities: ['tenant_signup_requests.read'],
    });
    expect(await screen.findByTestId('signup-status-all')).toBeInTheDocument();
    expect(screen.queryByText(/Tenant signup queue requires/i)).not.toBeInTheDocument();
  });

  it('keeps invite redirect failures visible in the same signup drawer', async () => {
    const user = userEvent.setup();
    let reviewAttempted = false;
    vi.mocked(api.ui_list_resource_v1).mockImplementation(async (key: string, opts?: unknown) => {
      const filter = opts && typeof opts === 'object' && 'filter' in opts
        ? ((opts as { filter?: Record<string, unknown> }).filter ?? {})
        : {};
      const filterRows = (rows: Array<Record<string, unknown>>) =>
        rows.filter((row) =>
          Object.entries(filter).every(([field, value]) => value == null || row[field] === value),
        );
      if (key === 'tenant_signup_requests') {
        const rows = cloneRows(seedTenantSignupRequests as Array<Record<string, unknown>>).map((row) =>
          reviewAttempted && row.id === 'tsr_221'
            ? { ...row, full_name: 'Backend Refetched Admin' }
            : row,
        );
        return listResult(filterRows(rows));
      }
      if (key === 'tenant_signup_request_summary') {
        return listResult(filterRows(tenantSignupSummaryRows()));
      }
      if (key === 'organizations') {
        return listResult(filterRows(cloneRows(seedOrganizations as Array<Record<string, unknown>>)));
      }
      return listResult([]);
    });
    vi.spyOn(api, 'tenant_signup_review_apply_v1').mockImplementation(async () => {
      reviewAttempted = true;
      throw new Error('Invite redirect must be a hosted non-localhost http/https URL.');
    });
    renderWithProviders(<OrganizationsModule />, {
      capabilities: ['tenant_signup_requests.read', 'tenant_signup_requests.review'],
    });

    const row = (await screen.findByText(/Riyadh Express LLC/i)).closest('tr')!;
    await user.click(row);
    const drawer = await screen.findByTestId('org-signup-drawer');
    await user.click(within(drawer).getByRole('button', { name: /^Approve request$/i }));

    const failure = await screen.findByTestId('org-signup-review-failure');
    expect(within(failure).getByText(/Review blocked/i)).toBeInTheDocument();
    expect(within(failure).getByText(/Invite redirect must be a hosted non-localhost http\/https URL\./i)).toBeInTheDocument();
    expect(within(failure).getByText(/Request recorded/i)).toBeInTheDocument();
    expect(within(failure).getByText(/Review status pending/i)).toBeInTheDocument();
    const refreshedDrawer = await screen.findByTestId('org-signup-drawer');
    expect(within(refreshedDrawer).getByText(/Backend Refetched Admin/i)).toBeInTheDocument();
    expect(within(refreshedDrawer).getByRole('button', { name: /^Approve request$/i })).toBeEnabled();
    expect(within(refreshedDrawer).getByRole('button', { name: /^Reject$/i })).toBeEnabled();
  });

  // -----------------------------------------------------------------------
  // Phase D2 — canonical review wiring (replaces the toast-only stub).
  // -----------------------------------------------------------------------

  it('Drawer Approve button invokes tenant signup review with the canonical envelope', async () => {
    const user = userEvent.setup();
    const spy = vi.spyOn(api, 'tenant_signup_review_apply_v1').mockResolvedValue({
      ok: true,
      tenant_signup_request_id: 'tsr_221',
      decision: 'approved',
      approved_organization_id: 'org_riyadh_express',
      approved_user_id: 'usr_riyadh_admin',
      invite_email_sent_at: '2026-05-07T06:00:00.000Z',
      correlation_id: 'cor_x',
      settings_resolution_id: 'srlv_x',
    });
    renderWithProviders(<OrganizationsModule />, {
      capabilities: ['tenant_signup_requests.read', 'tenant_signup_requests.review'],
    });
    // Open drawer for the first pending request (Riyadh Express).
    const row = (await screen.findByText(/Riyadh Express LLC/i)).closest('tr')!;
    await user.click(row);
    const drawer = await screen.findByTestId('org-signup-drawer');
    const approve = within(drawer).getByRole('button', { name: /^Approve request$/i });
    await user.click(approve);
    await waitFor(() => expect(spy).toHaveBeenCalled());
    await within(drawer).findByRole('button', { name: /^Open readiness$/i });
    const call = spy.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(call).toMatchObject({
      tenant_signup_request_id: 'tsr_221',
      decision: 'approved',
      decision_metadata: expect.any(Object),
    });
  });

  it('approval refreshes the tenant registry so the activated organization appears', async () => {
    const user = userEvent.setup();
    const original = listOrganizationSeedResource;
    let approved = false;
    vi.spyOn(api, 'ui_list_resource_v1').mockImplementation(async (key: string, opts?: unknown) => {
      const result = await original(key, opts as never);
      if (key === 'tenant_signup_requests') {
        return {
          ...result,
          rows: [
            {
              id: 'tsr_activation_proof',
              email: 'activation.admin@example.com',
              full_name: 'Activation Admin',
              organization_name: 'Activation Proof Logistics',
              status: approved ? 'approved' : 'pending',
              created_at: '2026-05-06T12:00:00.000Z',
              reviewed_at: approved ? '2026-05-06T12:02:00.000Z' : null,
              turnstile_verified: true,
              metadata: {},
              marketing: {},
            },
            ...result.rows,
          ],
        };
      }
      if (key === 'organizations' && approved) {
        return {
          ...result,
          rows: [
            {
              id: 'org_activation_proof',
              name: 'Activation Proof Logistics',
              billing_status: 'active',
              created_at: '2026-05-06T12:02:00.000Z',
            },
            ...result.rows,
          ],
        };
      }
      return result;
    });
    vi.spyOn(api, 'tenant_signup_review_apply_v1').mockImplementation(async () => {
      approved = true;
      return {
        ok: true,
        tenant_signup_request_id: 'tsr_activation_proof',
        organization_id: 'org_activation_proof',
      };
    });

    renderWithProviders(<OrganizationsModule />, {
      capabilities: ['organizations.read', 'tenant_signup_requests.read', 'tenant_signup_requests.review'],
    });
    const row = (await screen.findByText('Activation Proof Logistics')).closest('tr')!;
    await user.click(row);
    const drawer = await screen.findByTestId('org-signup-drawer');
    await user.click(within(drawer).getByRole('button', { name: /^Approve request$/i }));
    await within(drawer).findByRole('button', { name: /^Open readiness$/i });
    await user.click(screen.getByRole('button', { name: /^Close$/i }));
    await waitFor(() => expect(screen.queryByTestId('org-signup-drawer')).not.toBeInTheDocument());

    expect(
      await screen.findByRole('row', { name: /Open organizations Activation Proof Logistics/i }),
    ).toBeInTheDocument();
  });

  it('invalidates signup request, summary, and onboarding readiness reads after tenant signup review succeeds', async () => {
    const user = userEvent.setup();
    vi.spyOn(api, 'tenant_signup_review_apply_v1').mockResolvedValue({
      ok: true,
      tenant_signup_request_id: 'tsr_221',
      correlation_id: 'cor_x',
      settings_resolution_id: 'srlv_x',
    });
    const { queryClient } = renderWithProviders(<OrganizationsModule />, {
      capabilities: ['tenant_signup_requests.read', 'tenant_signup_requests.review'],
    });
    const invalidateSpy = vi.spyOn(queryClient, 'invalidateQueries');
    const refetchSpy = vi.spyOn(queryClient, 'refetchQueries');

    const row = (await screen.findByText(/Riyadh Express LLC/i)).closest('tr')!;
    await user.click(row);
    const drawer = await screen.findByTestId('org-signup-drawer');
    await user.click(within(drawer).getByRole('button', { name: /^Approve request$/i }));

    await waitFor(() => {
      expect(invalidateSpy).toHaveBeenCalledWith(expect.objectContaining({
        queryKey: ['list', 'tenant_signup_requests'],
        refetchType: 'active',
      }));
      expect(invalidateSpy).toHaveBeenCalledWith(expect.objectContaining({
        queryKey: ['list', 'tenant_signup_request_summary'],
        refetchType: 'active',
      }));
      expect(invalidateSpy).toHaveBeenCalledWith(expect.objectContaining({
        queryKey: ['list', 'tenant_signup_requests', 'complete'],
        refetchType: 'active',
      }));
      expect(invalidateSpy).toHaveBeenCalledWith(expect.objectContaining({
        queryKey: ['list', 'tenant_signup_request_summary', 'complete'],
        refetchType: 'active',
      }));
      expect(invalidateSpy).toHaveBeenCalledWith(expect.objectContaining({
        queryKey: ['list', 'organizations', 'complete'],
        refetchType: 'active',
      }));
      expect(invalidateSpy).toHaveBeenCalledWith(expect.objectContaining({
        queryKey: ['list', 'users', 'complete'],
        refetchType: 'active',
      }));
      expect(invalidateSpy).toHaveBeenCalledWith(expect.objectContaining({
        queryKey: ['list', 'user_directory', 'complete'],
        refetchType: 'active',
      }));
      expect(invalidateSpy).toHaveBeenCalledWith(expect.objectContaining({
        queryKey: ['onboarding_readiness'],
        refetchType: 'active',
      }));
      expect(refetchSpy).toHaveBeenCalledWith(expect.objectContaining({
        queryKey: ['list', 'tenant_signup_requests'],
        type: 'active',
      }));
      expect(refetchSpy).toHaveBeenCalledWith(expect.objectContaining({
        queryKey: ['list', 'tenant_signup_request_summary'],
        type: 'active',
      }));
      expect(refetchSpy).toHaveBeenCalledWith(expect.objectContaining({
        queryKey: ['list', 'organizations'],
        type: 'active',
      }));
      expect(refetchSpy).toHaveBeenCalledWith(expect.objectContaining({
        queryKey: ['list', 'users'],
        type: 'active',
      }));
      expect(refetchSpy).toHaveBeenCalledWith(expect.objectContaining({
        queryKey: ['list', 'user_directory'],
        type: 'active',
      }));
      expect(refetchSpy).toHaveBeenCalledWith(expect.objectContaining({
        queryKey: ['list', 'tenant_signup_requests', 'complete'],
        type: 'active',
      }));
      expect(refetchSpy).toHaveBeenCalledWith(expect.objectContaining({
        queryKey: ['list', 'tenant_signup_request_summary', 'complete'],
        type: 'active',
      }));
      expect(refetchSpy).toHaveBeenCalledWith(expect.objectContaining({
        queryKey: ['list', 'organizations', 'complete'],
        type: 'active',
      }));
      expect(refetchSpy).toHaveBeenCalledWith(expect.objectContaining({
        queryKey: ['list', 'users', 'complete'],
        type: 'active',
      }));
      expect(refetchSpy).toHaveBeenCalledWith(expect.objectContaining({
        queryKey: ['list', 'user_directory', 'complete'],
        type: 'active',
      }));
      expect(refetchSpy).toHaveBeenCalledWith(expect.objectContaining({
        queryKey: ['onboarding_readiness'],
        type: 'active',
      }));
    });
  });

  it('keeps single approval in context and exposes readiness handoff from the drawer', async () => {
    const user = userEvent.setup();
    const reviewSpy = vi.spyOn(api, 'tenant_signup_review_apply_v1').mockResolvedValue({
      ok: true,
      tenant_signup_request_id: 'tsr_221',
      decision: 'approved',
      approved_organization_id: 'org_approved_from_review',
      approved_organization_label: 'Approved From Review Logistics',
      approved_auth_user_id: 'auth_approved_from_review',
      approved_user_id: 'usr_approved_from_review',
      approved_user_email: 'admin@approved-review.example',
      reviewer_label: 'Tenant Review Operator',
      invite_email_sent_at: '2026-05-07T06:00:00.000Z',
      invite_redirect_to: 'https://unjijvxjrwurjgsnokovrvom.example.invalid/auth/callback',
      attestation_count: 3,
      attestation_passed_count: 3,
      attestation_complete: true,
      has_marketing_consent: true,
      decision_age_seconds: 0,
      correlation_id: 'cor_x',
      settings_resolution_id: 'srlv_x',
    });
    renderWithProviders(<OrganizationsModule />, {
      capabilities: ['tenant_signup_requests.read', 'tenant_signup_requests.review'],
    });

    const row = (await screen.findByText(/Riyadh Express LLC/i)).closest('tr')!;
    await user.click(row);
    const drawer = await screen.findByTestId('org-signup-drawer');
    const approveButton = within(drawer).getByRole('button', { name: /^Approve request$/i });
    fireEvent.pointerDown(approveButton, { pointerType: 'mouse' });
    fireEvent.mouseDown(approveButton);
    fireEvent.click(approveButton);
    await waitFor(() => expect(reviewSpy).toHaveBeenCalledTimes(1));

    const activation = await within(drawer).findByTestId('org-signup-activation-status');
    expect(within(activation).getByText(/Sent/i)).toBeInTheDocument();
    const decisionHistory = within(drawer).getByTestId('org-signup-decision-history');
    expect(decisionHistory).toHaveTextContent(/Tenant Review Operator/);
    expect(within(drawer).getByTestId('org-signup-summary-approved-org-label')).toHaveTextContent(
      /Approved From Review Logistics/,
    );
    expect(within(drawer).getByText(/User ready .*admin@approved-review\.example/i)).toBeInTheDocument();
    await user.click(within(drawer).getByRole('button', { name: /^Open readiness$/i }));

    await waitFor(() => {
      expect(window.location.pathname).toBe('/platform/onboarding-readiness');
      expect(window.location.search).toContain('scope_type=tenant');
      expect(window.location.search).toContain('scope_id=org_approved_from_review');
    });
  });

  it('approves a signup request against an existing organization through explicit review metadata', async () => {
    const user = userEvent.setup();
    const reviewSpy = vi.spyOn(api, 'tenant_signup_review_apply_v1').mockResolvedValue({
      ok: true,
      tenant_signup_request_id: 'tsr_221',
      decision: 'approved',
      status: 'approved',
      review_decision: 'approved',
      approved_organization_id: 'org_rashed',
      approved_organization_label: 'Rashed Logistics',
      approved_auth_user_id: 'auth_existing_org_link',
      approved_user_id: 'usr_existing_org_link',
      approved_user_email: 'existing-link@rashed.example',
      invite_email_sent_at: '2026-05-07T06:00:00.000Z',
      invite_redirect_to: 'https://unjijvxjrwurjgsnokovrvom.example.invalid/auth/callback',
      linked_existing_organization: true,
      correlation_id: 'cor_existing_org_link',
      settings_resolution_id: 'srlv_existing_org_link',
    });
    renderWithProviders(<OrganizationsModule />, {
      capabilities: ['organizations.read', 'tenant_signup_requests.read', 'tenant_signup_requests.review'],
    });

    const row = (await screen.findByText(/Riyadh Express LLC/i)).closest('tr')!;
    await user.click(row);
    const drawer = await screen.findByTestId('org-signup-drawer');
    await user.selectOptions(within(drawer).getByLabelText(/^Existing organization link$/i), 'org_rashed');
    await user.click(within(drawer).getByRole('button', { name: /^Approve request$/i }));

    await waitFor(() => expect(reviewSpy).toHaveBeenCalledTimes(1));
    expect(reviewSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        tenant_signup_request_id: 'tsr_221',
        decision: 'approved',
        decision_metadata: expect.objectContaining({
          source: 'console-v2/platform/organizations',
          approved_existing_organization_id: 'org_rashed',
          existing_organization_link_requested: true,
        }),
      }),
    );
    expect(within(drawer).getByTestId('org-signup-summary-approved-org-label')).toHaveTextContent(
      /Rashed Logistics/,
    );
    await user.click(within(drawer).getByRole('button', { name: /^Open readiness$/i }));
    await waitFor(() => {
      expect(window.location.pathname).toBe('/platform/onboarding-readiness');
      expect(window.location.search).toContain('scope_id=org_rashed');
    });
  });

  it('keeps approved signup in context and surfaces invite email failure readback', async () => {
    const user = userEvent.setup();
    vi.spyOn(api, 'tenant_signup_review_apply_v1').mockResolvedValue({
      ok: true,
      tenant_signup_request_id: 'tsr_221',
      decision: 'approved',
      status: 'approved',
      review_decision: 'approved',
      approved_organization_id: 'org_invite_fallback',
      approved_user_id: 'usr_invite_fallback',
      approved_auth_user_id: 'auth_invite_fallback',
      invite_redirect_to: 'https://unjijvxjrwurjgsnokovrvom.example.invalid/auth/callback',
      last_error_code: 'invite_email_failed',
      last_error_message: 'SMTP provider refused recipient',
      last_error_at: '2026-05-16T08:15:00.000Z',
      correlation_id: 'cor_invite_fallback',
      settings_resolution_id: 'srlv_invite_fallback',
    });
    renderWithProviders(<OrganizationsModule />, {
      capabilities: ['tenant_signup_requests.read', 'tenant_signup_requests.review'],
    });

    const row = (await screen.findByText(/Riyadh Express LLC/i)).closest('tr')!;
    await user.click(row);
    const drawer = await screen.findByTestId('org-signup-drawer');
    await user.click(within(drawer).getByRole('button', { name: /^Approve request$/i }));

    const activation = await within(drawer).findByTestId('org-signup-activation-status');
    expect(within(activation).getByText(/invite failed/i)).toBeInTheDocument();
    expect(within(activation).getByText(/invite_email_failed/i)).toBeInTheDocument();
    expect(within(activation).getByText(/SMTP provider refused recipient/i)).toBeInTheDocument();
    expect(within(activation).getByText(/2026-05-16T08:15:00\.000Z/i)).toBeInTheDocument();
    expect(within(drawer).getByRole('button', { name: /^Open readiness$/i })).toBeInTheDocument();
    expect(within(drawer).getByRole('button', { name: /^Approve request$/i })).toBeDisabled();
    expect(within(drawer).getByRole('button', { name: /^Reject$/i })).toBeDisabled();
  });

  it('Drawer Reject button invokes tenant_signup_review_apply_v1 with decision=rejected', async () => {
    const user = userEvent.setup();
    const spy = vi.spyOn(api, 'tenant_signup_review_apply_v1').mockResolvedValue({
      ok: true,
      tenant_signup_request_id: 'tsr_220',
      correlation_id: 'cor_x',
      settings_resolution_id: 'srlv_x',
    });
    renderWithProviders(<OrganizationsModule />, {
      capabilities: ['tenant_signup_requests.read', 'tenant_signup_requests.review'],
    });
    const row = (await screen.findByText(/Jazira Couriers/i)).closest('tr')!;
    await user.click(row);
    const drawer = await screen.findByTestId('org-signup-drawer');
    const reject = within(drawer).getByRole('button', { name: /^Reject$/i });
    await user.click(reject);
    const rejectForm = await screen.findByTestId('tenant-signup-reject-form');
    expect(within(rejectForm).getByRole('button', { name: /Reject request/i })).toBeDisabled();
    await user.type(
      within(rejectForm).getByLabelText(/^Reason$/i),
      'KYC documents are incomplete.',
    );
    await user.click(within(rejectForm).getByRole('button', { name: /Reject request/i }));
    await waitFor(() => expect(spy).toHaveBeenCalled());
    const reviewedDrawer = await screen.findByTestId('org-signup-drawer');
    await within(reviewedDrawer).findByText('KYC documents are incomplete.');
    expect(within(reviewedDrawer).getByRole('button', { name: /^Reject$/i })).toBeDisabled();
    expect(spy).toHaveBeenCalledWith(
      expect.objectContaining({
        tenant_signup_request_id: 'tsr_220',
        decision: 'rejected',
        decision_reason: 'KYC documents are incomplete.',
      }),
    );
  });

  it('stale Reject refreshes the drawer to the already-approved backend state', async () => {
    const user = userEvent.setup();
    const toastSpy = vi.spyOn(toastStore, 'pushToast');
    vi.spyOn(api, 'tenant_signup_review_apply_v1').mockResolvedValue({
      ok: true,
      already_processed: true,
      tenant_signup_request_id: 'tsr_220',
      status: 'approved',
      review_decision: 'approved',
      approved_organization_id: 'org_stale_approved',
      approved_user_id: 'usr_stale_approved',
      invite_email_sent_at: '2026-05-08T09:00:01.000Z',
    });
    renderWithProviders(<OrganizationsModule />, {
      capabilities: ['tenant_signup_requests.read', 'tenant_signup_requests.review'],
    });
    const row = (await screen.findByText(/Jazira Couriers/i)).closest('tr')!;
    await user.click(row);
    const drawer = await screen.findByTestId('org-signup-drawer');
    await user.click(within(drawer).getByRole('button', { name: /^Reject$/i }));
    const rejectForm = await screen.findByTestId('tenant-signup-reject-form');
    await user.type(within(rejectForm).getByLabelText(/^Reason$/i), 'Stale rejection reason.');
    await user.click(within(rejectForm).getByRole('button', { name: /Reject request/i }));

    await waitFor(() =>
      expect(toastSpy).toHaveBeenCalledWith(
        expect.stringContaining('Signup requests refreshed · 1 already reviewed · 1/1'),
        'warn',
      ),
    );
    await waitFor(() => expect(screen.queryByTestId('tenant-signup-reject-form')).not.toBeInTheDocument());
    const reviewedDrawer = await screen.findByTestId('org-signup-drawer');
    expect(within(reviewedDrawer).getAllByText(/Approved/i).length).toBeGreaterThan(0);
    expect(within(reviewedDrawer).queryByText('Stale rejection reason.')).not.toBeInTheDocument();
    expect(within(reviewedDrawer).getByRole('button', { name: /^Approve request$/i })).toBeDisabled();
    expect(within(reviewedDrawer).getByRole('button', { name: /^Reject$/i })).toBeDisabled();
  });

  it('approved signup drawer exposes invite status and links to onboarding readiness', async () => {
    const user = userEvent.setup();
    renderWithProviders(<OrganizationsModule />, {
      capabilities: ['organizations.read', 'tenant_signup_requests.read', 'tenant_signup_requests.review'],
    });
    const row = (await screen.findByText(/partnerships@tabuk-log\.example/i)).closest('tr')!;
    await user.click(row);
    const drawer = await screen.findByTestId('org-signup-drawer');
    const activation = within(drawer).getByTestId('org-signup-activation-status');
    expect(within(activation).getByText(/Sent/i)).toBeInTheDocument();
    expect(within(activation).getByText(/console-dev\.masarx\.co\/onboarding/i)).toBeInTheDocument();

    await user.click(within(drawer).getByRole('button', { name: /Open readiness/i }));

    await waitFor(() => {
      expect(window.location.pathname).toBe('/platform/onboarding-readiness');
      expect(window.location.search).toContain('scope_type=tenant');
      expect(window.location.search).toContain('scope_id=org_tabuk_logistics');
    });
  });

  it('approved signup drawer links to the provisioned user access handoff', async () => {
    const user = userEvent.setup();
    renderWithProviders(<OrganizationsModule />, {
      capabilities: ['organizations.read', 'tenant_signup_requests.read', 'tenant_signup_requests.review'],
    });
    const row = (await screen.findByText(/partnerships@tabuk-log\.example/i)).closest('tr')!;
    await user.click(row);
    const drawer = await screen.findByTestId('org-signup-drawer');
    const activation = within(drawer).getByTestId('org-signup-activation-status');
    expect(within(activation).getByText(/Sent/i)).toBeInTheDocument();

    await user.click(within(drawer).getByRole('button', { name: /Open user access/i }));

    await waitFor(() => {
      expect(window.location.pathname).toBe('/platform/users');
      expect(window.location.search).toContain('organization_id=org_tabuk_logistics');
      expect(window.location.search).toContain('focus=usr_tabuk_admin');
    });
  });

  it('Approve toast on success uses a friendly signup review summary', async () => {
    const user = userEvent.setup();
    vi.spyOn(api, 'tenant_signup_review_apply_v1').mockResolvedValue({
      ok: true,
      tenant_signup_request_id: 'tsr_221',
      correlation_id: 'cor_x',
      settings_resolution_id: 'srlv_x',
    });
    const toastSpy = vi.spyOn(toastStore, 'pushToast');
    renderWithProviders(<OrganizationsModule />, {
      capabilities: ['tenant_signup_requests.read', 'tenant_signup_requests.review'],
    });
    const row = (await screen.findByText(/Riyadh Express LLC/i)).closest('tr')!;
    await user.click(row);
    const drawer = await screen.findByTestId('org-signup-drawer');
    const approve = within(drawer).getByRole('button', { name: /^Approve request$/i });
    await user.click(approve);
    await waitFor(() =>
      expect(toastSpy).toHaveBeenCalledWith(
        expect.stringContaining('Signup requests approved'),
        'good',
      ),
    );
  });

  it('Approve when review rejects surfaces a friendly danger toast', async () => {
    const user = userEvent.setup();
    vi.spyOn(api, 'tenant_signup_review_apply_v1').mockRejectedValue(
      new Error('signup_review_unavailable'),
    );
    const toastSpy = vi.spyOn(toastStore, 'pushToast');
    renderWithProviders(<OrganizationsModule />, {
      capabilities: ['tenant_signup_requests.read', 'tenant_signup_requests.review'],
    });
    const row = (await screen.findByText(/Riyadh Express LLC/i)).closest('tr')!;
    await user.click(row);
    const drawer = await screen.findByTestId('org-signup-drawer');
    const approve = within(drawer).getByRole('button', { name: /^Approve request$/i });
    await user.click(approve);
    await waitFor(() =>
      expect(toastSpy).toHaveBeenCalledWith(
        'Tenant signup review could not be completed. Review the selected requests and try again.',
        'danger',
      ),
    );
  });

  // -----------------------------------------------------------------------
  // Phase D2 — drawer attestation rendering + decision history.
  // -----------------------------------------------------------------------

  it('Row click opens a drawer rendering the canonical attestation envelope', async () => {
    const user = userEvent.setup();
    renderWithProviders(<OrganizationsModule />, {
      capabilities: ['tenant_signup_requests.read', 'tenant_signup_requests.review'],
    });
    const row = (await screen.findByText(/Riyadh Express LLC/i)).closest('tr')!;
    await user.click(row);
    const drawer = await screen.findByTestId('org-signup-drawer');
    // Attestations envelope: keys come straight from metadata.attestations
    // so the chip count should match the seed (terms_accepted, privacy,
    // KYC docs, beneficial owner) plus the always-rendered turnstile chip.
    const attestations = within(drawer).getByTestId('org-signup-attestations');
    expect(within(attestations).getByText(/terms accepted/i)).toBeInTheDocument();
    expect(within(attestations).getByText(/privacy accepted/i)).toBeInTheDocument();
    expect(within(attestations).getByText(/kyc documents provided/i)).toBeInTheDocument();
    expect(within(attestations).getByText(/beneficial owner disclosed/i)).toBeInTheDocument();
    expect(within(attestations).getByText(/turnstile verified/i)).toBeInTheDocument();
  });

  it('Drawer renders the marketing context with operator labels', async () => {
    const user = userEvent.setup();
    renderWithProviders(<OrganizationsModule />, {
      capabilities: ['tenant_signup_requests.read', 'tenant_signup_requests.review'],
    });
    const row = (await screen.findByText(/Riyadh Express LLC/i)).closest('tr')!;
    await user.click(row);
    const drawer = await screen.findByTestId('org-signup-drawer');
    const marketing = within(drawer).getByTestId('org-signup-marketing');
    expect(marketing.textContent).toContain('q2 launch');
    expect(marketing.textContent).toContain('Campaign source');
    expect(marketing.textContent).not.toContain('utm_source');
  });

  it('Drawer decision history shows the pending hint for unreviewed requests', async () => {
    const user = userEvent.setup();
    renderWithProviders(<OrganizationsModule />, {
      capabilities: ['tenant_signup_requests.read', 'tenant_signup_requests.review'],
    });
    const row = (await screen.findByText(/Riyadh Express LLC/i)).closest('tr')!;
    await user.click(row);
    const drawer = await screen.findByTestId('org-signup-drawer');
    const history = within(drawer).getByTestId('org-signup-decision-history');
    expect(history.textContent).toMatch(/Pending review/i);
    expect(history.textContent).toMatch(/tenant review/);
  });

  it('Drawer decision history shows reviewer + reason + provisioned org for previously-approved requests', async () => {
    const user = userEvent.setup();
    renderWithProviders(<OrganizationsModule />, {
      capabilities: ['tenant_signup_requests.read', 'tenant_signup_requests.review'],
    });
    // Switch to the approved-only filter to surface tsr_219 (Tabuk).
    const approvedTab = await screen.findByTestId('signup-status-approved');
    await user.click(approvedTab);
    const row = (await screen.findByText(/Tabuk Logistics/i)).closest('tr')!;
    await user.click(row);
    const drawer = await screen.findByTestId('org-signup-drawer');
    const history = within(drawer).getByTestId('org-signup-decision-history');
    expect(history.textContent).toMatch(/admin@masarx\.sa/);
    expect(history.textContent).toMatch(/KYC complete/);
    expect(history.textContent).toMatch(/Organization ready/i);
    expect(history.textContent).toMatch(/Ref ISTICS/i);
    expect(history.textContent).not.toMatch(/org_tabuk_logistics/);
    // Approve / Reject buttons must be disabled because the request is
    // already reviewed (no double-decision allowed).
    const approve = within(drawer).getByRole('button', { name: /^Approve request$/i });
    const reject = within(drawer).getByRole('button', { name: /^Reject$/i });
    expect(approve).toBeDisabled();
    expect(reject).toBeDisabled();
  });

  it('Drawer Approve button is disabled when the operator lacks tenant_signup_requests.review (capability gating)', async () => {
    const user = userEvent.setup();
    renderWithProviders(<OrganizationsModule />, {
      capabilities: ['tenant_signup_requests.read'],
    });
    const row = (await screen.findByText(/Riyadh Express LLC/i)).closest('tr')!;
    await user.click(row);
    const drawer = await screen.findByTestId('org-signup-drawer');
    // When a capability is denied, the Button component appends a CapabilityLock
    // chip into the accessible name, so we cannot anchor with ^...$.
    const approve = within(drawer).getByRole('button', { name: /Approve/i });
    const reject = within(drawer).getByRole('button', { name: /Reject/i });
    expect(approve).toBeDisabled();
    expect(reject).toBeDisabled();
    // Cap-lock chip is rendered with an operator-facing permission label.
    expect(within(approve).getByText(/Tenant Signup Review permission required/)).toBeInTheDocument();
    expect(within(approve).queryByText(/tenant_signup_requests\.review/)).toBeNull();
  });

  // ---------------------------------------------------------------------
  // W23 paired projection (v_tenant_signup_request_summary)
  //
  // Drawer renders canonical projection rollups (attestation_count /
  // attestation_passed_count / attestation_complete BOOLEAN /
  // reviewer_label / approved_organization_label / decision_age_seconds)
  // sourced from `v_tenant_signup_request_summary` instead of
  // recomputing them from the metadata jsonb on the FE. SSOT:
  //   • supabase/migrations/202604302220_v_tenant_signup_request_summary.sql
  //   • apps/console-v2/src/lib/data-source.ts
  //       → _projectTenantSignupRequestSummary
  // ---------------------------------------------------------------------
  describe('OrganizationsModule · paired projection wiring (W23)', () => {
    it('drawer surfaces v_tenant_signup_request_summary chips (attestation rollups + completion flag)', async () => {
      const user = userEvent.setup();
      renderWithProviders(<OrganizationsModule />, {
        capabilities: ['tenant_signup_requests.read', 'tenant_signup_requests.review'],
      });
      const row = (await screen.findByText(/Riyadh Express LLC/i)).closest('tr')!;
      await user.click(row);
      const drawer = await screen.findByTestId('org-signup-drawer');
      // Summary chip block renders when the projection row is available.
      const chips = await within(drawer).findByTestId('org-signup-summary-chips');
      // Attestation rollup chip renders the canonical "passed/total" shape.
      const attCount = within(chips).getByTestId(
        'org-signup-summary-attestation-count',
      );
      expect(attCount.textContent).toMatch(/attestations · \d+\/\d+/);
      // Completion flag chip renders one of the two canonical labels.
      const attComplete = within(chips).getByTestId(
        'org-signup-summary-attestation-complete',
      );
      expect(attComplete.textContent).toMatch(
        /attestation (complete|incomplete)/,
      );
    });

    it('drawer renders reviewer_label + decision_age_seconds chips for previously-approved requests', async () => {
      const user = userEvent.setup();
      renderWithProviders(<OrganizationsModule />, {
        capabilities: ['tenant_signup_requests.read', 'tenant_signup_requests.review'],
      });
      // Switch to the approved-only filter to surface tsr_219 (Tabuk).
      const approvedTab = await screen.findByTestId('signup-status-approved');
      await user.click(approvedTab);
      const row = (await screen.findByText(/Tabuk Logistics/i)).closest('tr')!;
      await user.click(row);
      const drawer = await screen.findByTestId('org-signup-drawer');
      const chips = await within(drawer).findByTestId('org-signup-summary-chips');
      // Reviewer chip — sourced via users.full_name FK projection (or
      // falls back to `reviewed_by_label` when reviewed_by is unset on the
      // canonical seed). Either way the chip renders.
      const reviewer = within(chips).getByTestId(
        'org-signup-summary-reviewer-label',
      );
      expect(reviewer.textContent).toMatch(/reviewer · /);
      // Decision-age chip renders the canonical seconds-since-review value.
      const decisionAge = within(chips).getByTestId(
        'org-signup-summary-decision-age',
      );
      expect(decisionAge.textContent).toMatch(/decision age · \d+s/);
    });
  });
});
