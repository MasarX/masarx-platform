// sources.arabic.test.tsx: the sources page renders its own copy in Arabic (issue #302).
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { renderWithProviders } from '@/test/render';
import { findUntranslated } from '@/test/helpers/untranslated';
import { SourcesModule } from '@/modules/integrations/sources';
import * as apiMod from '@/lib/api';
import { englishT, fill } from '@/lib/i18n';
import ar from '@/lib/seed-raw/i18n/areas/ar/integrations-sources';
import arShell from '@/lib/seed-raw/i18n/areas/ar/shell';

const AR = ar.integrationsSources.sourcesModule;
const SOURCE_NAME = 'Exampleparcel KSA';
const SOURCE_REFERENCE = 'srcksa';
// Supplied data shown as-is: the source name, its reference and lookup labels from the fixtures.
const DATA = ['Exampleparcel', 'KSA', SOURCE_REFERENCE, 'HMAC'];

const SOURCE_ROW: Record<string, unknown> = {
  id: 'whs_arabic_source',
  organization_id: 'org_rashed',
  source_identifier: SOURCE_REFERENCE,
  name: SOURCE_NAME,
  provider_type: 'shopify',
  mapping_config_id: 'mc_arabic_source',
  sender_id: 'snd_arabic_source',
  rate_limit_per_hour: 1000,
  enabled: true,
  auth_token_masked: 'stored',
  created_at: '2026-05-10T12:00:00Z',
};

const DIRECTORY_ROW: Record<string, unknown> = {
  ...SOURCE_ROW,
  source_label: SOURCE_NAME,
  provider_type_label: 'Shopify',
  mapping_target: 'shipments.create',
  event_count_24h: 7,
  error_count_24h: 0,
  rule_count: 3,
  active_rule_count: 2,
  is_healthy: true,
  hmac_enabled: true,
  hmac_auth_config_id: 'pac_arabic_hmac',
  hmac_header: null,
  last_event_at: null,
};

const ARCHIVED = { lifecycle: 'archived', archived_at: '2026-05-12T05:20:00.000Z' };

function lookup(catalog: unknown, path: string): unknown {
  return path.split('.').reduce<unknown>((node, part) => (node as Record<string, unknown> | undefined)?.[part], catalog);
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function mockSourceReads(sourceRow: Record<string, unknown>, directoryRow: Record<string, unknown>) {
  const realList = apiMod.ui_list_resource_v1;
  const realGet = apiMod.ui_get_resource_v1;
  const realGetLookups = apiMod.getLookups;
  const realLookupRow = apiMod.lookupRow;
  const lookups: Record<string, Array<Record<string, unknown>>> = {
    webhook_provider_type: [{ value: 'shopify', label: 'Shopify', tone: 'info', is_default: true }],
    enabled_state: [
      { value: 'enabled', label: 'Enabled', tone: 'good', is_default: true },
      { value: 'disabled', label: 'Disabled', tone: 'neutral' },
    ],
    webhook_source_health: [{ value: 'healthy', label: 'Healthy', tone: 'good', is_default: true, rank: 10 }],
  };
  vi.spyOn(apiMod, 'ui_list_resource_v1').mockImplementation(async (resource: string, opts?: apiMod.ListOpts) => {
    if (resource === 'webhook_sources') return { rows: [{ ...sourceRow }], total: 1 } as never;
    if (resource === 'webhook_source_directory') return { rows: [{ ...directoryRow }], total: 1 } as never;
    if (['mapping_config_directory', 'sender_summary', 'integration_credential_directory'].includes(resource)) {
      return { rows: [], total: 0 } as never;
    }
    return realList(resource, opts);
  });
  vi.spyOn(apiMod, 'ui_get_resource_v1').mockImplementation(async (resource: string, id: string) => {
    if (resource === 'webhook_sources') return (id === sourceRow.id ? { ...sourceRow } : null) as never;
    if (resource === 'webhook_source_directory') return (id === directoryRow.id ? { ...directoryRow } : null) as never;
    return realGet(resource, id);
  });
  vi.spyOn(apiMod, 'getLookups').mockImplementation((category: string) => {
    if (category in lookups) return lookups[category] as ReturnType<typeof apiMod.getLookups>;
    return realGetLookups(category);
  });
  vi.spyOn(apiMod, 'lookupRow').mockImplementation((category: string, value: string) => {
    const row = lookups[category]?.find((candidate) => candidate.value === value);
    if (row) return row as unknown as ReturnType<typeof apiMod.lookupRow>;
    return realLookupRow(category, value);
  });
}

describe('SourcesModule in Arabic', () => {
  beforeEach(() => {
    window.history.pushState(null, '', '/integrations/sources');
  });
  afterEach(() => {
    sessionStorage.clear();
    vi.restoreAllMocks();
  });

  it('renders the page copy in Arabic', async () => {
    renderWithProviders(<SourcesModule />, { locale: 'ar', capabilities: ['all'] });

    const [title] = await screen.findAllByText(ar.integrationsSources.sourcesModule.titleAccent);
    expect(findUntranslated(title)).toEqual([]);
    const [copy] = await screen.findAllByText(ar.integrationsSources.sourcesModule.externalIntake);
    expect(findUntranslated(copy)).toEqual([]);
  });

  it('shows the denied state in Arabic', async () => {
    renderWithProviders(<SourcesModule />, { locale: 'ar', capabilities: [] });
    expect(await screen.findByText(ar.integrationsSources.sourcesModule.youDoNotHave)).toBeInTheDocument();
  });

  it('keeps the English copy and reads Arabic from the catalog', () => {
    expect(englishT('integrationsSources.sourcesModule.titleAccent')).toBe('Sources');
    expect(englishT('integrationsSources.sourcesModule.useThisOnce')).toBe('Use this once in External Intake > Test webhook intake or API request intake. It will not be shown again.');
    expect(lookup(ar, 'integrationsSources.sourcesModule.titleAccent')).toMatch(/[؀-ۿ]/);
  });

  it('shows the token and receiver chips, references and drawer in Arabic', async () => {
    const user = userEvent.setup();
    mockSourceReads(SOURCE_ROW, DIRECTORY_ROW);
    renderWithProviders(<SourcesModule />, { locale: 'ar', capabilities: ['all'] });

    await waitFor(() => {
      expect(document.querySelectorAll('.dt__table tbody tr').length).toBe(1);
    });
    const sourceRef = fill(ar.integrationsSources.reference.source, { value: SOURCE_REFERENCE });
    const row = document.querySelector('.dt__table tbody tr') as HTMLElement;
    await waitFor(() => {
      expect(row.textContent).toContain(AR.tokenConfigured);
      expect(row.textContent).toContain(sourceRef);
    });
    const [tokenChip] = screen.getAllByText(AR.tokenConfigured);
    expect(findUntranslated(tokenChip!)).toEqual([]);
    const [referenceCell] = screen.getAllByText(sourceRef);
    expect(findUntranslated(referenceCell!, DATA)).toEqual([]);

    await user.click(row);
    await screen.findByTestId('source-token-readback-status');
    const drawer = document.querySelector('.drawer') as HTMLElement;
    const readback = screen.getByTestId('source-token-readback-status');
    expect(readback).toHaveTextContent(fill(AR.tokenStatusConfirmed, { status: AR.tokenConfigured }));
    expect(findUntranslated(readback)).toEqual([]);

    const title = document.querySelector('.drawer__title') as HTMLElement;
    expect(title).toHaveTextContent(`${SOURCE_NAME} · ${sourceRef}`);
    expect(findUntranslated(title, DATA)).toEqual([]);

    for (const text of [AR.tokenHmac, AR.available, fill(AR.ruleCounts, { active: '2', total: '3' })]) {
      const [value] = within(drawer).getAllByText(text);
      expect(findUntranslated(value!, DATA)).toEqual([]);
    }
  });

  it('shows the token-only chip in Arabic', async () => {
    mockSourceReads(SOURCE_ROW, { ...DIRECTORY_ROW, hmac_enabled: false, hmac_auth_config_id: null, auth_token_masked: null });
    renderWithProviders(<SourcesModule />, { locale: 'ar', capabilities: ['all'] });

    const [chip] = await screen.findAllByText(ar.integrationsSources.sourceForm.tokenOnly);
    expect(findUntranslated(chip!)).toEqual([]);
    const [notConfigured] = await screen.findAllByText(AR.tokenNotConfigured);
    expect(findUntranslated(notConfigured!)).toEqual([]);
  });

  it('explains the locked archived-source actions in Arabic', async () => {
    const user = userEvent.setup();
    mockSourceReads(
      { ...SOURCE_ROW, enabled: false, managed_metadata: ARCHIVED },
      { ...DIRECTORY_ROW, enabled: false, lifecycle_state: 'archived', archived_at: ARCHIVED.archived_at },
    );
    renderWithProviders(<SourcesModule />, { locale: 'ar', capabilities: ['all'] });

    const kebabs = await screen.findAllByRole('button', { name: arShell.shell.table.rowActions });
    await user.click(kebabs[0]!);
    const cases: Array<[string, string]> = [
      [AR.edit2, AR.archivedCannotEdit],
      [AR.rotateToken, AR.archivedCannotRotate],
      [AR.toggleEnabled, AR.archivedAlreadyDisabled],
    ];
    for (const [label, reason] of cases) {
      const option = await screen.findByRole('option', { name: new RegExp(`^${escapeRegExp(label)}`) });
      expect(option).toHaveClass('is-disabled');
      expect(option).toHaveTextContent(reason);
      expect(findUntranslated(option)).toEqual([]);
    }
  });

  it('keeps one whole sentence per source state in both languages', () => {
    expect(englishT('integrationsSources.sourcesModule.tokenConfigured')).toBe('Configured');
    expect(fill(englishT('integrationsSources.sourcesModule.tokenStatusConfirmed'), { status: 'Configured' })).toBe('Token status confirmed: Configured');
    expect(fill(englishT('integrationsSources.reference.source'), { value: SOURCE_REFERENCE })).toBe(`Source ref ${SOURCE_REFERENCE}`);
    expect(englishT('integrationsSources.sourcesModule.archivedCannotEdit')).toBe('Archived sources are retained for audit and cannot be edited.');
    const box = document.createElement('div');
    box.textContent = [
      fill(ar.integrationsSources.reference.mapping, { value: '' }),
      fill(ar.integrationsSources.reference.sender, { value: '' }),
      ar.integrationsSources.reference.none,
      AR.tokenStateUnavailable,
      AR.tokenStatusPending,
    ].join(' ');
    expect(findUntranslated(box)).toEqual([]);
  });
});
