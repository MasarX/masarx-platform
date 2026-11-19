// reporting.test.tsx — Phase F1 / CLAIM-INSIGHTS-REPORTING.
//
// Coverage targets:
//   1. Surface mounts and renders the canonical-projection chip (no `static` /
//      `proj` placeholder chips remain).
//   2. Each of the 4 group sections renders with its eyebrow.
//   3. Each of the 12 canonical KPI cards renders with the resolved value.
//   4. Capability-denied flow surfaces the denied StateView when the caller
//      lacks `insights.read`.
//   5. Tone resolution: a higher-is-better KPI above its threshold reports a
//      `good` tone (mirrors kpi_definitions.tone_thresholds.good_at_or_above).
//   6. Tone resolution: a lower-is-better KPI above its `warn_above` threshold
//      reports a `warn` tone (mirrors tone_thresholds.warn_above).
//   7. Scope filtering: hook is invoked with the caller's organization_id from
//      `useIdentity` (mirrors RLS tenant scope) — verified through the
//      QueryClient cache key shape.
//   8. Format dispatcher: percent / minutes / seconds / count units render
//      with the correct suffix.
//   9. Hook-level: querying an unknown definition_key surfaces an error from
//      the resolver (no silent fallback to invented data).
//  10. Hook-level: the resolver echoes a settings_resolution_id so the
//      ladder/audit trace stays attached to every read.

import { describe, it, expect, beforeEach } from 'vitest';
import { screen, waitFor, renderHook } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ReactNode } from 'react';
import { renderWithProviders, makeQueryClient } from '@/test/render';
import { ReportingModule } from './reporting';
import { useKpiRollup } from '@/lib/queries';
import { compute_kpi_rollup_v1 } from '@/lib/api';

describe('ReportingModule (Phase F1 / KPI rollups)', () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it('mounts and renders the canonical projection chip (no static/proj placeholders)', async () => {
    renderWithProviders(<ReportingModule />, { capabilities: ['all'] });
    await waitFor(() => {
      expect(screen.getByTestId('kpi-strip-canonical')).toBeTruthy();
    });
    // No legacy placeholder chip should remain.
    expect(
      screen.queryAllByTitle(/Placeholder — pending report_kpis_v1/).length,
    ).toBe(0);
    // Canonical projection chip is present (1 in header pill + 4 group chips).
    const canonicalChips = screen.getAllByTitle(
      /Backed by canonical kpi_definitions \+ kpi_rollups_daily projection|All cards backed by the canonical/,
    );
    expect(canonicalChips.length).toBeGreaterThanOrEqual(5);
  });

  it('renders all 4 group sections with their eyebrow labels', async () => {
    renderWithProviders(<ReportingModule />, { capabilities: ['all'] });
    await waitFor(() => {
      expect(screen.getByTestId('kpi-rollup-groups')).toBeTruthy();
    });
    expect(screen.getByTestId('kpi-group-operations')).toBeTruthy();
    expect(screen.getByTestId('kpi-group-marketplace')).toBeTruthy();
    expect(screen.getByTestId('kpi-group-integrations')).toBeTruthy();
    expect(screen.getByTestId('kpi-group-workflows')).toBeTruthy();
    for (const eyebrow of ['Operations', 'Marketplace', 'Integrations', 'Workflows']) {
      expect(screen.getByText(eyebrow)).toBeTruthy();
    }
  });

  it('renders all 12 canonical KPI cards (one per definition_key)', async () => {
    renderWithProviders(<ReportingModule />, { capabilities: ['all'] });
    const expectedKeys = [
      'on_time_delivery_rate',
      'exception_rate',
      'avg_dispatch_time_minutes',
      'active_partners',
      'cod_collection_rate',
      'dispute_rate',
      'webhook_delivery_rate',
      'provider_error_rate',
      'plugin_event_volume',
      'workflow_run_success_rate',
      'manual_review_open',
      'workflow_avg_run_seconds',
    ];
    for (const key of expectedKeys) {
      await waitFor(() => {
        expect(screen.getByTestId(`kpi-card-${key}`)).toBeTruthy();
      });
    }
  });

  it('surfaces the denied StateView when the caller lacks insights.read', async () => {
    renderWithProviders(<ReportingModule />, { capabilities: ['shipments.read'] });
    await waitFor(() => {
      // Multiple matches expected: capability lock chip + body hint.
      const matches = screen.getAllByText(/insights\.read|do not have permission/i);
      expect(matches.length).toBeGreaterThan(0);
    });
    // The KPI strip should NOT render in denied state.
    expect(screen.queryByTestId('kpi-strip-canonical')).toBeNull();
  });

  it('renders the on_time_delivery_rate card with a `good` tone (94 >= good_at_or_above 92)', async () => {
    renderWithProviders(<ReportingModule />, { capabilities: ['all'] });
    const card = await waitFor(() => screen.getByTestId('kpi-card-on_time_delivery_rate'));
    // Wait until the value renders (loading state shows '…').
    await waitFor(() => {
      expect(card.textContent).toMatch(/94%/);
    });
    const tile = card.querySelector('.kpi');
    expect(tile?.className).toMatch(/kpi--good/);
  });

  it('renders the exception_rate card with a `warn` tone (2.1 > warn_above 1.5, lower-is-better)', async () => {
    renderWithProviders(<ReportingModule />, { capabilities: ['all'] });
    const card = await waitFor(() => screen.getByTestId('kpi-card-exception_rate'));
    await waitFor(() => {
      expect(card.textContent).toMatch(/2\.1%/);
    });
    const tile = card.querySelector('.kpi');
    expect(tile?.className).toMatch(/kpi--warn/);
  });

  it('caches each KPI rollup keyed on the caller organization_id (RLS tenant scope)', async () => {
    const client = makeQueryClient();
    renderWithProviders(<ReportingModule />, {
      capabilities: ['all'],
      queryClient: client,
    });
    // Wait for data to load on at least one card.
    await waitFor(() => {
      expect(screen.getByTestId('kpi-card-on_time_delivery_rate').textContent).toMatch(
        /94%/,
      );
    });
    // Inspect the cache. Every entry must encode (definition_key, window_days,
    // organization_id) and the org id must be a real string (not null).
    const cached = client
      .getQueryCache()
      .getAll()
      .filter((q) => Array.isArray(q.queryKey) && q.queryKey[0] === 'kpi_rollup');
    expect(cached.length).toBeGreaterThanOrEqual(12);
    for (const q of cached) {
      const key = q.queryKey as readonly unknown[];
      expect(key[0]).toBe('kpi_rollup');
      expect(typeof key[1]).toBe('string'); // definition_key
      expect(typeof key[2]).toBe('number'); // window_days
      expect(typeof key[3]).toBe('string'); // organization_id (no null/global reads)
      expect(key[3]).toBeTruthy();
    }
  });

  it('renders different format units correctly: percent, minutes, seconds, count', async () => {
    renderWithProviders(<ReportingModule />, { capabilities: ['all'] });
    // percent: cod_collection_rate = 97.6%
    const cod = await waitFor(() => screen.getByTestId('kpi-card-cod_collection_rate'));
    await waitFor(() => expect(cod.textContent).toMatch(/97\.6%/));
    // minutes: avg_dispatch_time_minutes = 12m
    const dispatch = await waitFor(() =>
      screen.getByTestId('kpi-card-avg_dispatch_time_minutes'),
    );
    await waitFor(() => expect(dispatch.textContent).toMatch(/12m/));
    // seconds: workflow_avg_run_seconds = 1.4s
    const avgRun = await waitFor(() =>
      screen.getByTestId('kpi-card-workflow_avg_run_seconds'),
    );
    await waitFor(() => expect(avgRun.textContent).toMatch(/1\.4s/));
    // integer count: active_partners = 4 (no suffix)
    const partners = await waitFor(() => screen.getByTestId('kpi-card-active_partners'));
    await waitFor(() =>
      expect(partners.textContent).toMatch(/Active partners[\s\S]*4/),
    );
  });
});

describe('useKpiRollup hook (Phase F1)', () => {
  function wrapperWithClient(client: QueryClient) {
    return function Wrapper({ children }: { children: ReactNode }) {
      return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
    };
  }

  it('returns a typed KpiRollupResolution with settings_resolution_id (audit traceability)', async () => {
    const client = makeQueryClient();
    const { result } = renderHook(
      () =>
        useKpiRollup('on_time_delivery_rate', {
          scope: { organization_id: 'org_rashed' },
        }),
      { wrapper: wrapperWithClient(client) },
    );
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(result.current.data?.kpi_key).toBe('on_time_delivery_rate');
    expect(result.current.data?.settings_resolution_id).toMatch(/^srlv_/);
    expect((result.current.data?.value_num ?? 0)).toBeGreaterThan(0);
  });

  it('surfaces an error for an unknown definition_key (no silent invention)', async () => {
    const result = await compute_kpi_rollup_v1({
      definition_key: 'definitely_not_a_real_kpi_key',
      scope: { organization_id: 'org_rashed' },
    }).catch((err: Error) => err);
    expect(result).toBeInstanceOf(Error);
    expect((result as Error).message).toMatch(/kpi_definition_not_found/);
  });
});
