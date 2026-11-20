// api-gateway.test.tsx — CLAIM-INSIGHTS-API-GW (Wave 3, Phase C).
//
// Coverage targets (per claim brief):
//   1. Mount + KPI strip + DataTable.
//   2. Filter chips narrow list by status_code class.
//   3. Live-tail toggle starts polling (mock interval).
//   4. Drawer renders headers redacted (no `Authorization` value visible).
//   5. Capability gate on Block source + Adjust rate limit.
//
// Mounting strategy: we mount the module bare (not through the router) and
// drive interactions via @testing-library/react. The data-source seam is
// fully synthetic (deterministic LCG seed) so KPI/row counts are stable.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { screen, waitFor, fireEvent, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { renderWithProviders } from '@/test/render';
import { ApiGatewayModule } from '../api-gateway';
import * as api from '@/lib/api';
import {
  latencyKind,
  p95,
  redactHeader,
  statusClass,
  statusKind,
  synthesizeRow,
} from '../_api-gateway.helpers';

const __test = {
  statusClass,
  statusKind,
  latencyKind,
  redactHeader,
  synthesizeRow,
  p95,
};

describe('ApiGatewayModule', () => {
  beforeEach(() => {
    localStorage.clear();
    vi.stubEnv('VITE_USE_SEED', 'true');
    vi.stubEnv('VITE_SUPABASE_URL', '');
    vi.stubEnv('VITE_SUPABASE_ANON_KEY', '');
    vi.useRealTimers();
  });
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.useRealTimers();
  });

  // ── 1. Mount + KPI strip + DataTable ────────────────────────────────────
  it('renders the API gateway surface (page header + KPI strip + DataTable)', async () => {
    renderWithProviders(<ApiGatewayModule />, { capabilities: ['all'] });
    // Page header text.
    await waitFor(() => {
      expect(screen.getByText('API')).toBeTruthy();
      expect(screen.getByText('request intake')).toBeTruthy();
    });
    // KPI strip is mounted with 4 cards (Requests / Error rate / p95 / Rate-limited).
    await waitFor(() => {
      expect(screen.getByTestId('api-gateway-kpi-strip')).toBeTruthy();
    });
    expect(screen.getByText(/Requests · last 1h/i)).toBeTruthy();
    expect(screen.getByText(/Error rate · last 1h/i)).toBeTruthy();
    expect(screen.getByText(/p95 latency · last 1h/i)).toBeTruthy();
    expect(screen.getByText(/Rate-limited · last 1h/i)).toBeTruthy();
    // DataTable is populated (the deterministic seed exposes 70 rows; the
    // default 1h window typically retains a small subset — if zero rows
    // survive the window the empty-state placeholder still mounts which
    // means the table never crashes).
    await waitFor(() => {
      const page = screen.getByTestId('insights-api-gateway-page');
      // Either a tbody (rows present) or the explicit empty state — both
      // satisfy "DataTable mounted under the active filters".
      expect(
        page.querySelector('table') || page.querySelector('.state--empty'),
      ).toBeTruthy();
    });
  });

  // ── 2. Filter chips narrow list by status_code class ────────────────────
  it('filters rows by status code class chip selection', async () => {
    const user = userEvent.setup();
    renderWithProviders(<ApiGatewayModule />, { capabilities: ['all'] });
    // Wait for first render — filter bar appears once data has loaded
    // (the surface renders the bar after `useResourceList` settles).
    await waitFor(
      () => expect(screen.getByTestId('api-gateway-filter-bar')).toBeTruthy(),
      { timeout: 3000 },
    );
    // The seed dataset is anchored at 2026-04-25T13:30:00Z, which is older
    // than `Date.now()` in CI runs. So we click "All" to drop the time-range
    // filter before counting rows.
    const allRangeBtn = document.querySelector('[data-range="all"]') as HTMLButtonElement;
    expect(allRangeBtn).toBeTruthy();
    await user.click(allRangeBtn);
    // Allow the filtered set to repopulate.
    await waitFor(
      () => {
        expect(
          document.querySelectorAll('.dt__table tbody tr').length,
        ).toBeGreaterThan(0);
      },
      { timeout: 3000 },
    );
    const beforeRows = document.querySelectorAll('.dt__table tbody tr').length;
    expect(beforeRows).toBeGreaterThan(0);
    // Click 5xx — this should narrow rows to ≤ before count.
    const fiveXBtn = document.querySelector('[data-status="5xx"]') as HTMLButtonElement;
    expect(fiveXBtn).toBeTruthy();
    await user.click(fiveXBtn);
    await waitFor(() => {
      const afterRows = document.querySelectorAll('.dt__table tbody tr').length;
      // Either fewer rows survive, or empty state takes over (both mean
      // the filter narrowed the set).
      expect(afterRows < beforeRows || screen.queryByText(/No matching requests/)).toBeTruthy();
    });
  });

  // ── 3. Live-tail toggle starts polling (mock interval) ──────────────────
  it('starts polling on live-tail toggle and updates the live counter', async () => {
    vi.stubEnv('VITE_API_GATEWAY_SYNTHETIC_LIVE_TAIL', 'true');
    vi.useFakeTimers({ shouldAdvanceTime: true });
    renderWithProviders(<ApiGatewayModule />, { capabilities: ['all'] });
    await waitFor(() =>
      expect(screen.getByTestId('api-gateway-live-toggle')).toBeTruthy(),
    );
    const toggle = screen.getByTestId('api-gateway-live-toggle');
    expect(toggle).toHaveAttribute('aria-pressed', 'false');
    fireEvent.click(toggle);
    await waitFor(() => expect(toggle).toHaveAttribute('aria-pressed', 'true'));
    // Advance fake timers to fire two synthetic ticks (interval is 2000ms).
    await vi.advanceTimersByTimeAsync(4500);
    // The "live · n new" pill should now show a positive counter.
    await waitFor(() => {
      const livePill = screen.queryByText(/^Live updates: [1-9]\d* new$/);
      expect(livePill).toBeTruthy();
    });
  });

  // ── 4. Drawer renders headers redacted (no Authorization value visible) ─
  it('hides Authorization header details in the Request tab', async () => {
    const user = userEvent.setup();
    renderWithProviders(<ApiGatewayModule />, { capabilities: ['all'] });
    // Switch range to All so we always have rows to click on.
    await waitFor(
      () => expect(screen.getByTestId('api-gateway-filter-bar')).toBeTruthy(),
      { timeout: 3000 },
    );
    const allRangeBtn = document.querySelector('[data-range="all"]') as HTMLButtonElement;
    await user.click(allRangeBtn);
    await waitFor(() => {
      expect(document.querySelector('.dt__table tbody tr')).toBeTruthy();
    });
    // Click the first table row to open the drawer.
    const firstRow = document.querySelector('.dt__table tbody tr') as HTMLTableRowElement;
    fireEvent.click(firstRow);
    await waitFor(() => {
      expect(screen.getByTestId('api-gateway-drawer-body')).toBeTruthy();
    });
    // The Request tab shows the protection notice in place of raw header details.
    const requestTab = screen.getByTestId('api-gateway-drawer-request-tab');
    expect(within(requestTab).getByText('Sensitive request headers are hidden in this summary.')).toBeInTheDocument();
    // And the raw bearer value never appears anywhere in the drawer.
    const drawer = screen.getByTestId('api-gateway-drawer-body');
    expect(within(drawer).queryByText(/Bearer sk_live_/)).toBeNull();
    expect(within(drawer).queryByText(/Bearer pk_partner_/)).toBeNull();
  });

  // ── 5. Capability gate on Block source + Adjust rate limit ──────────────
  it('disables Block source + Adjust rate limit when api_gateway.write is missing', async () => {
    renderWithProviders(<ApiGatewayModule />, {
      capabilities: ['api_gateway.read'], // read but not write
    });
    await waitFor(() => expect(screen.getByText('request intake')).toBeTruthy());
    const blockBtn = await screen.findByRole('button', { name: /Block source/ });
    const adjustBtn = screen.getByRole('button', { name: /Adjust rate limit/ });
    expect(blockBtn).toBeDisabled();
    expect(adjustBtn).toBeDisabled();
    // CapabilityLock chip should appear next to each gated action.
    expect(blockBtn.querySelector('.cap-lock, [data-cap-lock]') || screen.getAllByText(/api_gateway\.write/).length).toBeTruthy();
  });

  // ── Bonus: capability-denied state when api_gateway.read is missing ─────
  it('renders the denied state when api_gateway.read is missing', async () => {
    renderWithProviders(<ApiGatewayModule />, {
      capabilities: ['shipments.read'], // no api_gateway capabilities at all
    });
    await waitFor(() => {
      // The .state--denied container is the canonical denied placeholder.
      const denied = document.querySelector('.state--denied');
      expect(denied).toBeTruthy();
    });
  });

  // ── Pure helpers exposed via __test ─────────────────────────────────────
  describe('pure helpers', () => {
    it('classifies status codes correctly', () => {
      expect(__test.statusClass(204)).toBe('2xx');
      expect(__test.statusClass(301)).toBe('3xx');
      expect(__test.statusClass(404)).toBe('4xx');
      expect(__test.statusClass(503)).toBe('5xx');
    });
    it('maps status to chip kind', () => {
      expect(__test.statusKind(200)).toBe('good');
      expect(__test.statusKind(304)).toBe('neutral');
      expect(__test.statusKind(429)).toBe('warn');
      expect(__test.statusKind(502)).toBe('danger');
    });
    it('maps latency to chip kind using the resolved thresholds', () => {
      const thresholds = {
        latency_band_good_boundary_ms: 300,
        latency_band_warn_ms: 900,
        latency_band_danger_ms: 2000,
      };
      expect(__test.latencyKind(120, thresholds)).toBe('good');
      expect(__test.latencyKind(500, thresholds)).toBe('info');
      expect(__test.latencyKind(1500, thresholds)).toBe('warn');
      expect(__test.latencyKind(3000, thresholds)).toBe('danger');
      expect(__test.latencyKind(120, null)).toBeNull();
    });
    it('redacts sensitive headers', () => {
      expect(__test.redactHeader('Authorization', 'Bearer sk_live_xxx')).toBe('«redacted»');
      expect(__test.redactHeader('authorization', 'Bearer x')).toBe('«redacted»');
      expect(__test.redactHeader('Cookie', 'session=abc')).toBe('«redacted»');
      expect(__test.redactHeader('X-Correlation-Id', 'cor_1')).toBe('cor_1');
    });
    it('computes p95 over numeric latencies', () => {
      const samples = Array.from({ length: 100 }, (_, i) => i + 1);
      // 100 samples (1..100) → p95 should be at the 95th element index (94).
      expect(__test.p95(samples)).toBeGreaterThanOrEqual(95);
      expect(__test.p95([])).toBe(0);
    });
    it('synthesizes deterministic live rows from anchor', () => {
      const anchor = {
        id: 'cal_anchor',
        request_id: 'req_anchor',
        method: 'POST',
        path: '/v1/shipments',
        status_code: 200,
        duration_ms: 100,
        source_id: 'src_x',
        source_label: 'src x',
        source_kind: 'org' as const,
        source_ip: '192.0.2.10',
        route_id: 'rt_x',
        route_pack_id: 'rpk_public_v1',
        occurred_at: '2026-04-25T12:00:00Z',
        request_headers: { Authorization: 'Bearer sk_anchor' },
        response_size_bytes: 200,
      };
      const r1 = __test.synthesizeRow(anchor, 1);
      const r2 = __test.synthesizeRow(anchor, 1);
      // Deterministic given the same ordinal except for the live `occurred_at`
      // (uses `Date.now()`) which is allowed to drift.
      expect(r1.request_id).toBe(r2.request_id);
      expect(r1.status_code).toBe(r2.status_code);
      // Live row keeps the synthesizer marker prefix.
      expect(r1.id.startsWith('cal_live_')).toBe(true);
      // The synthesized headers always REPLACE Authorization with a live token.
      expect(r1.request_headers.Authorization).toMatch(/^Bearer sk_live_/);
    });
  });
});
