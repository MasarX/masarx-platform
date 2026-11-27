// organizations.arabic.test.tsx: the organizations page renders its own copy in Arabic (issue #302).
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { renderWithProviders } from '@/test/render';
import { findUntranslated } from '@/test/helpers/untranslated';
import { OrganizationsModule } from '@/modules/platform/organizations';
import { englishT } from '@/lib/i18n';
import * as api from '@/lib/api';
import * as toastStore from '@/components/toastStore';
import ar from '@/lib/seed-raw/i18n/areas/ar/platform-organizations';
import en from '@/lib/seed-raw/i18n/areas/en/platform-organizations';
// @ts-expect-error - seed-raw/*.js has no declaration file by design.
import { tenant_signup_requests as seedTenantSignupRequests } from '@/lib/seed-raw/intake.js';
// @ts-expect-error - seed-raw/*.js has no declaration file by design.
import { lookups as seedLookups } from '@/lib/seed-raw/lookups.js';

// Copy moved into the catalog: each Arabic sentence is Latin-free (JSON is a format name) and keeps the English placeholders.
const MOVED_KEYS = {
  orgProfileForm: ['organizationDefaultsMustBe', 'currentDefaults'],
  signupDrawerBody: [
    'campaignSource', 'campaign', 'channel', 'referrer', 'source', 'intakeLocale', 'ipAddress', 'browser',
    'notProvided', 'yes', 'no', 'itemOne', 'itemOther', 'detailOne', 'detailOther', 'organizationReady',
    'organizationReadyRef', 'provisionedUserReady', 'provisionedUserReadyRef',
  ],
  organizationsModule: [
    'signupApprovedToast', 'signupApprovedFailedToast', 'signupRejectedToast', 'signupRejectedFailedToast',
    'signupRefreshedToast', 'signupRefreshedFailedToast', 'tenantRegistryCouldNotLoad', 'signupRequestsCouldNotLoad',
    'signupSummaryCouldNotLoad',
  ],
} as const;

function lookup(catalog: unknown, path: string): unknown {
  return path.split('.').reduce<unknown>((node, part) => (node as Record<string, unknown> | undefined)?.[part], catalog);
}

function placeholders(text: string): string[] {
  return [...text.matchAll(/\{(\w+)\}/g)].map((match) => match[1]!).sort();
}

function mockSignupRequests() {
  const rows = (seedTenantSignupRequests as Array<Record<string, unknown>>).map((row) => ({
    ...row,
    tenant_signup_request_id: row.id,
    approved_organization_label: row.approved_organization_label ?? row.organization_name ?? null,
  }));
  vi.spyOn(api, 'getLookups').mockImplementation((category: string) =>
    structuredClone((seedLookups as Record<string, Array<Record<string, unknown>>>)[category] ?? []) as ReturnType<typeof api.getLookups>,
  );
  vi.spyOn(api, 'ui_list_resource_v1').mockImplementation(async (key: string) => {
    const list = key === 'tenant_signup_requests' || key === 'tenant_signup_request_summary' ? rows.map((row) => structuredClone(row)) : [];
    return { rows: list, total: list.length, page: 0, page_size: list.length } as Awaited<ReturnType<typeof api.ui_list_resource_v1>>;
  });
}

describe('OrganizationsModule in Arabic', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    window.history.pushState(null, '', '/platform/organizations');
  });

  it('renders the page copy in Arabic', async () => {
    renderWithProviders(<OrganizationsModule />, { locale: 'ar', capabilities: ['organizations.read', 'tenant_signup_requests.read'] });

    const [title] = await screen.findAllByText(ar.platformOrganizations.organizationsModule.titleAccent);
    expect(findUntranslated(title)).toEqual([]);
    const [copy] = await screen.findAllByText(ar.platformOrganizations.organizationsModule.tenantRegistrySignupQueue);
    expect(findUntranslated(copy)).toEqual([]);
  });

  it('shows the denied state in Arabic', async () => {
    renderWithProviders(<OrganizationsModule />, { locale: 'ar', capabilities: [] });
    expect(await screen.findByText(ar.platformOrganizations.organizationsModule.tenantListRequiresOrganization)).toBeInTheDocument();
  });

  it('keeps the English copy and reads Arabic from the catalog', () => {
    expect(englishT('platformOrganizations.organizationsModule.titleAccent')).toBe('Organizations');
    expect(englishT('platformOrganizations.organizationsModule.tenants')).toBe('Tenants');
    expect(lookup(ar, 'platformOrganizations.organizationsModule.titleAccent')).toMatch(/[؀-ۿ]/);
  });

  it('confirms an approved signup review with a whole Arabic sentence', async () => {
    mockSignupRequests();
    vi.spyOn(api, 'tenant_signup_review_apply_v1').mockResolvedValue({
      ok: true,
      tenant_signup_request_id: 'tsr_221',
      correlation_id: 'cor_x',
      settings_resolution_id: 'srlv_x',
    });
    const toastSpy = vi.spyOn(toastStore, 'pushToast');
    const user = userEvent.setup();
    renderWithProviders(<OrganizationsModule />, {
      locale: 'ar',
      capabilities: ['tenant_signup_requests.read', 'tenant_signup_requests.review'],
    });
    await user.click((await screen.findByText(/Riyadh Express LLC/i)).closest('tr')!);
    const drawer = await screen.findByTestId('org-signup-drawer');
    await user.click(within(drawer).getByRole('button', { name: ar.platformOrganizations.signupDrawerBody.approveRequest }));

    const [sentence] = ar.platformOrganizations.organizationsModule.signupApprovedToast.split(' · ');
    await waitFor(() => expect(toastSpy).toHaveBeenCalledWith(expect.stringMatching(new RegExp(`^${sentence} · \\d+/\\d+$`)), 'good'));
    const shown = toastSpy.mock.calls.map(([text]) => String(text)).find((text) => text.startsWith(sentence));
    expect(shown).not.toMatch(/[A-Za-z]{2,}/);
  });

  it('keeps every moved sentence Arabic, Latin-free and placeholder-aligned with English', () => {
    for (const [group, keys] of Object.entries(MOVED_KEYS)) {
      for (const key of keys) {
        const path = `platformOrganizations.${group}.${key}`;
        const arabic = String(lookup(ar, path));
        expect(arabic, path).toMatch(/[؀-ۿ]/);
        expect(arabic.replace(/\{\w+\}/g, '').replace(/\bJSON\b/g, ''), path).not.toMatch(/[A-Za-z]{2,}/);
        expect(placeholders(arabic), path).toEqual(placeholders(String(lookup(en, path))));
      }
    }
    expect(englishT('platformOrganizations.signupDrawerBody.organizationReadyRef')).toBe('Organization ready · Ref {ref}');
    expect(englishT('platformOrganizations.organizationsModule.signupApprovedToast')).toBe('tenant-signup-review - Signup requests approved · {ok}/{total}');
  });
});
