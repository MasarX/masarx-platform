// api-gateway-realtime.test.tsx — Phase F coverage for the env-gated
// live-tail path on `/insights/api-gateway`.
//
// Coverage targets:
//   1. shapeRealtimePayload pure shaper handles full + partial payloads
//      and bails out on missing required fields.
//   2. isRealtimeEnabled returns true ONLY when VITE_REALTIME_ENABLED=true
//      AND a non-null supabase client is supplied.
//   3. Module mount in DEV PREVIEW mode (explicit synthetic flag → no client)
//      advances the synthesizer interval and never calls `client.channel(...)`.
//   4. Module mount in LIVE mode (env true → mocked client) calls
//      `client.channel('api_call_log').on('postgres_changes', …).subscribe()`
//      and prepends shaped payload rows onto the live buffer.
//   5. Module mount with realtime disabled only runs synthetic rows when the
//      dev/test-only synthetic flag is explicit; production has no fallback.
//
// Strategy: we mock `@/lib/supabase` at module level so `getSupabaseClient`
// can return a fresh fake per test (with `channel().on().subscribe()` chain).
// `vi.stubEnv` drives `import.meta.env.VITE_REALTIME_ENABLED`.

import {
  describe,
  it,
  expect,
  beforeEach,
  afterEach,
  vi,
  type Mock,
} from 'vitest';
import { screen, waitFor, fireEvent, act } from '@testing-library/react';
import { renderWithProviders } from '@/test/render';
import { ApiGatewayModule } from '../api-gateway';
import * as api from '@/lib/api';
import {
  isRealtimeEnabled,
  isSyntheticLiveTailAllowed,
  shapeRealtimePayload,
} from '../_api-gateway.helpers';

// ---------------------------------------------------------------------------
// Mock the supabase swap-seam factory. We hand-roll the channel chain so we
// can spy on subscribe() and capture the registered postgres_changes handler.
// ---------------------------------------------------------------------------

interface FakeChannel {
  on: Mock;
  subscribe: Mock;
  unsubscribe: Mock;
}

interface FakeClient {
  channel: Mock;
  removeChannel: Mock;
  schema: Mock;
}

let lastChannel: FakeChannel | null = null;
let lastHandler: ((payload: { new?: Record<string, unknown> | null }) => void) | null = null;
let apiGatewayRequestRows: Array<Record<string, unknown>> = [];

function makeFakeClient(): FakeClient {
  const channel: FakeChannel = {
    on: vi.fn((_event: string, _filter: unknown, handler: typeof lastHandler) => {
      lastHandler = handler ?? null;
      return channel;
    }) as unknown as Mock,
    subscribe: vi.fn(() => channel) as unknown as Mock,
    unsubscribe: vi.fn() as unknown as Mock,
  };
  lastChannel = channel;
  const client: FakeClient = {
    channel: vi.fn(() => channel) as unknown as Mock,
    removeChannel: vi.fn() as unknown as Mock,
    // Keep non-streaming data-source reads on the seed adapter during these
    // live-tail tests; only the channel() seam is under test here.
    schema: vi.fn(() => null) as unknown as Mock,
  };
  return client;
}

let mockClient: FakeClient | null = null;
let resolveSettingsSpy: { mockRestore: () => void } | null = null;
let listResourceSpy: { mockRestore: () => void } | null = null;

vi.mock('@/lib/supabase', () => {
  return {
    getSupabaseClient: () => mockClient,
    rpc: vi.fn(async () => null),
    __resetSupabaseClientForTests: () => {
      mockClient = null;
    },
  };
});

// ---------------------------------------------------------------------------

describe('api-gateway · realtime live-tail (Phase F)', () => {
  beforeEach(() => {
    mockClient = null;
    lastChannel = null;
    lastHandler = null;
    apiGatewayRequestRows = [];
    localStorage.clear();
    vi.useRealTimers();
    listResourceSpy = vi.spyOn(api, 'ui_list_resource_v1').mockImplementation(
      async (resource) => {
        if (resource === 'api_gateway_observability') {
          return {
            rows: [
              {
                id: 'cal_realtime_seed',
                request_id: 'req_realtime_seed',
                method: 'GET',
                path: '/v1/shipments',
                status_code: 200,
                duration_ms: 125,
                source_id: 'src_realtime_seed',
                source_label: 'Realtime source',
                route_id: 'route_realtime_seed',
                route_pack_id: 'rpk_public_v1',
                occurred_at: new Date().toISOString(),
                response_size_bytes: 512,
                headers: {},
              },
            ],
            total: 1,
            page: 0,
            page_size: 50,
          } as never;
        }
        if (
          resource === 'api_gateway_rate_limits_summary'
          || resource === 'provider_health_logs'
          || resource === 'api_route_packs'
          || resource === 'api_gateway_auth_rejections'
          || resource === 'api_routes'
        ) {
          return { rows: [], total: 0, page: 0, page_size: 50 } as never;
        }
        if (resource === 'api_gateway_requests') {
          return {
            rows: [...apiGatewayRequestRows],
            total: apiGatewayRequestRows.length,
            page: 0,
            page_size: 50,
          } as never;
        }
        return { rows: [], total: 0, page: 0, page_size: 50 } as never;
      },
    );
    resolveSettingsSpy = vi.spyOn(api, 'resolveSettings').mockImplementation(
      async (category, scope) => {
        const valueByCategory: Record<string, Record<string, unknown>> = {
          api_gateway_thresholds: {
            usage_pct_warn: 80,
            latency_band_good_boundary_ms: 300,
            latency_band_warn_ms: 900,
            latency_band_danger_ms: 2000,
            latency_p95_warn_ms: 900,
            latency_p95_danger_ms: 2000,
            error_rate_warn_pct: 2,
            error_rate_danger_pct: 5,
            rate_limited_warn_count: 3,
            rate_limited_danger_count: 10,
            downstream_dominance_pct: 30,
            provider_health_correlation_window_ms: 1800000,
            kpi_window_ms: 3600000,
            default_rate_limit_per_min: 60,
          },
          live_tail_policy: {
            decisions_buffer_size: 50,
            api_gateway_buffer_size: 250,
            api_gateway_synthesizer_interval_ms: 2000,
          },
          logestechs_v2_account: {
            enabled: true,
            company_id: '362',
            auth_config_id: 'auth_logestechs_demo',
          },
        };
        return {
          category,
          scope,
          value: valueByCategory[category] ?? {},
          resolved_from: 'global',
          ladder_path: [],
          settings_id: `settings_${category}`,
          settings_version_id: `settings_version_${category}`,
        } as never;
      },
    );
  });

  afterEach(() => {
    listResourceSpy?.mockRestore();
    listResourceSpy = null;
    resolveSettingsSpy?.mockRestore();
    resolveSettingsSpy = null;
    vi.unstubAllEnvs();
    vi.useRealTimers();
  });

  // ── 1. shapeRealtimePayload ──────────────────────────────────────────────
  describe('shapeRealtimePayload', () => {
    it('shapes a complete api_call_log INSERT payload', () => {
      const out = shapeRealtimePayload({
        id: 'cal_1',
        request_id: 'req_1',
        method: 'GET',
        path: '/v1/shipments',
        status_code: 200,
        duration_ms: 125,
        source_id: 'src_x',
        source_label: 'Source X',
        source_kind: 'org',
        source_org_id: 'org_1',
        source_ip: '192.0.2.10',
        route_id: 'rt_1',
        route_pack_id: 'rpk_public_v1',
        occurred_at: '2026-04-25T12:00:00Z',
        headers: { Authorization: 'Bearer sk_x' },
        response_size_bytes: 512,
        response_body_sample: '{"ok":true}',
      });
      expect(out).not.toBeNull();
      expect(out?.id).toBe('cal_1');
      expect(out?.request_id).toBe('req_1');
      expect(out?.status_code).toBe(200);
      // W14-2: `source_kind` was a fictional FE-only field dropped from the
      // row type; the canonical projection view exposes only source_id/_label.
    });

    it('falls back safely on partial payloads (no source_label / kind)', () => {
      const out = shapeRealtimePayload({
        id: 'cal_2',
        request_id: 'req_2',
        method: 'POST',
        path: '/v1/labels',
        status_code: 201,
        duration_ms: 80,
        source_id: 'src_partial',
      });
      expect(out).not.toBeNull();
      // Falls back to source_id when source_label is absent.
      expect(out?.source_label).toBe('src_partial');
      // W14-2: `source_kind` no longer asserted (fictional field removed).
      // W14-2: route_id is canonically nullable (api_call_log without joined
      // api_routes row maps to NULL); the FE no longer forces an 'unknown'
      // sentinel.
      expect(out?.route_id).toBeNull();
    });

    it('returns null when required keys are missing', () => {
      expect(shapeRealtimePayload(null)).toBeNull();
      expect(shapeRealtimePayload(undefined)).toBeNull();
      expect(shapeRealtimePayload({})).toBeNull();
      // W14-2: request_id is canonically nullable (api_call_log without a
      // joined api_gateway_requests row resolves to NULL), so missing
      // request_id is no longer a "required key" rejection. id + method +
      // path remain required.
      expect(
        shapeRealtimePayload({ id: 'cal_x', request_id: 'req_x', path: '/x' }),
      ).toBeNull(); // missing method
      expect(
        shapeRealtimePayload({ method: 'GET', request_id: 'req_x', path: '/x' }),
      ).toBeNull(); // missing id
      expect(
        shapeRealtimePayload({ id: 'cal_x', request_id: 'req_x', method: 'GET' }),
      ).toBeNull(); // missing path/url
    });
  });

  // ── 2. isRealtimeEnabled ────────────────────────────────────────────────
  describe('isRealtimeEnabled', () => {
    it('returns false when client is null even if env is true', () => {
      vi.stubEnv('VITE_REALTIME_ENABLED', 'true');
      expect(isRealtimeEnabled(null)).toBe(false);
    });

    it('returns false when env is unset / false', () => {
      const fake = { channel: () => ({}) } as unknown as Parameters<
        typeof isRealtimeEnabled
      >[0];
      vi.stubEnv('VITE_REALTIME_ENABLED', '');
      expect(isRealtimeEnabled(fake)).toBe(false);
      vi.stubEnv('VITE_REALTIME_ENABLED', 'false');
      expect(isRealtimeEnabled(fake)).toBe(false);
      vi.stubEnv('VITE_REALTIME_ENABLED', 'no');
      expect(isRealtimeEnabled(fake)).toBe(false);
    });

    it('returns true only when env=true AND client is present', () => {
      const fake = { channel: () => ({}) } as unknown as Parameters<
        typeof isRealtimeEnabled
      >[0];
      vi.stubEnv('VITE_REALTIME_ENABLED', 'true');
      expect(isRealtimeEnabled(fake)).toBe(true);
      vi.stubEnv('VITE_REALTIME_ENABLED', 'TRUE'); // case-insensitive
      expect(isRealtimeEnabled(fake)).toBe(true);
    });
  });

  describe('isSyntheticLiveTailAllowed', () => {
    it('requires explicit dev/test opt-in and never enables in production', () => {
      vi.stubEnv('VITE_API_GATEWAY_SYNTHETIC_LIVE_TAIL', 'true');
      vi.stubEnv('MODE', 'production');
      expect(isSyntheticLiveTailAllowed()).toBe(false);

      vi.stubEnv('MODE', 'test');
      expect(isSyntheticLiveTailAllowed()).toBe(true);

      vi.stubEnv('VITE_API_GATEWAY_SYNTHETIC_LIVE_TAIL', '');
      expect(isSyntheticLiveTailAllowed()).toBe(false);
    });
  });

  // ── 3. Module mount · DEV PREVIEW mode (no client) ──────────────────────
  it('uses synthesizer in DEV PREVIEW mode (explicit flag, no client)', async () => {
    const consoleErrorSpy = vi.spyOn(console, 'error');
    vi.stubEnv('VITE_REALTIME_ENABLED', 'false');
    vi.stubEnv('VITE_API_GATEWAY_SYNTHETIC_LIVE_TAIL', 'true');
    mockClient = null; // no supabase client
    vi.useFakeTimers({ shouldAdvanceTime: true });
    renderWithProviders(<ApiGatewayModule />, { capabilities: ['all'] });
    await waitFor(() =>
      expect(screen.getByTestId('api-gateway-live-toggle')).toBeTruthy(),
    );
    // Mode pill shows update checks (not connected live updates).
    const modePill = screen.getByTestId('api-gateway-stream-mode');
    expect(modePill.textContent ?? '').toMatch(/Update checks active/);
    // Toggle live-tail on.
    fireEvent.click(screen.getByTestId('api-gateway-live-toggle'));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(4500);
    });
    await waitFor(() => {
      const livePill = screen.queryByText(/Live updates: \d+ new/);
      expect(livePill).toBeTruthy();
    });
    const hasDuplicateRowKeyWarning = consoleErrorSpy.mock.calls.some((call) =>
      call.some((part) => String(part).includes('Encountered two children with the same key')),
    );
    consoleErrorSpy.mockRestore();
    expect(hasDuplicateRowKeyWarning).toBe(false);
    // No supabase channel was ever opened.
    expect(mockClient).toBeNull();
  });

  // ── 4. Module mount · LIVE mode (env=true + client present) ────────────
  it('subscribes via Supabase Realtime in LIVE mode and prepends shaped payloads', async () => {
    vi.stubEnv('VITE_REALTIME_ENABLED', 'true');
    mockClient = makeFakeClient();
    renderWithProviders(<ApiGatewayModule />, { capabilities: ['all'] });
    await waitFor(() =>
      expect(screen.getByTestId('api-gateway-live-toggle')).toBeTruthy(),
    );
    // Mode pill shows connected live updates.
    const modePill = screen.getByTestId('api-gateway-stream-mode');
    expect(modePill.textContent ?? '').toMatch(/Live updates active/);
    // Toggle live-tail on.
    fireEvent.click(screen.getByTestId('api-gateway-live-toggle'));
    // Wait for the effect to register the subscription.
    await waitFor(() => {
      expect((mockClient as FakeClient).channel).toHaveBeenCalledWith('api_call_log');
    });
    expect((lastChannel as FakeChannel).on).toHaveBeenCalled();
    expect((lastChannel as FakeChannel).subscribe).toHaveBeenCalled();
    // Inspect the postgres_changes filter payload.
    const onCall = ((lastChannel as FakeChannel).on as Mock).mock.calls[0];
    expect(onCall?.[0]).toBe('postgres_changes');
    expect(onCall?.[1]).toEqual({
      event: 'INSERT',
      schema: 'public',
      table: 'api_call_log',
    });
    // Drive a fake realtime payload through the captured handler.
    expect(typeof lastHandler).toBe('function');
    await act(async () => {
      lastHandler!({
        new: {
          id: 'cal_rt_1',
          request_id: 'req_rt_1',
          method: 'GET',
          path: '/v1/shipments',
          status_code: 200,
          duration_ms: 75,
          source_id: 'src_rt',
          source_label: 'Realtime Source',
          source_kind: 'partner',
          source_ip: '10.1.1.1',
          route_id: 'rt_rt',
          route_pack_id: 'rpk_public_v1',
          occurred_at: new Date().toISOString(),
          response_size_bytes: 200,
          headers: { Authorization: 'Bearer sk_rt' },
        },
      });
    });
    // The live update pill should reflect the prepended row.
    await waitFor(() => {
      const pill = screen.queryByText(/Live updates: 1 new/);
      expect(pill).toBeTruthy();
    });
  });

  // ── 5. LIVE mode · canonical projection refresh while live-tail is running
  it('renders newly arrived request projections while live-tail is running', async () => {
    vi.stubEnv('VITE_REALTIME_ENABLED', 'true');
    mockClient = makeFakeClient();
    vi.useFakeTimers({ shouldAdvanceTime: true });
    renderWithProviders(<ApiGatewayModule />, { capabilities: ['all'] });
    const toggle = await screen.findByTestId('api-gateway-live-toggle');
    const listMock = listResourceSpy as unknown as Mock;
    const requestReadsBefore = listMock.mock.calls.filter(
      ([resource]) => resource === 'api_gateway_requests',
    ).length;

    fireEvent.click(toggle);
    await waitFor(() =>
      expect((mockClient as FakeClient).channel).toHaveBeenCalledWith('api_call_log'),
    );
    apiGatewayRequestRows = [
      {
        id: 'req_direct_live_tail',
        request_id: 'req_direct_live_tail',
        method: 'POST',
        path: '/api/ship/request/by-email',
        source_id: 'src_api_gateway_live',
        source_label: 'API Gateway live source',
        route_id: 'route_ship_by_email',
        route_name: 'logestechs_v2_create_shipment_by_email',
        route_pack_id: 'pack_ship_by_email',
        route_pack_name: 'Logestechs shipment API',
        intake_state: 'workflow_queued',
        outbound_status: 'provider_failed',
        status_code: 202,
        correlation_id: '4dca68bc-b4e4-4191-81ff-70aed106cb82',
        received_at: new Date().toISOString(),
        occurred_at: new Date().toISOString(),
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      },
    ];
    await act(async () => {
      await vi.advanceTimersByTimeAsync(2200);
    });

    await waitFor(() => {
      const requestReadsAfter = listMock.mock.calls.filter(
        ([resource]) => resource === 'api_gateway_requests',
      ).length;
      expect(requestReadsAfter).toBeGreaterThan(requestReadsBefore);
    });
    fireEvent.click(screen.getByRole('tab', { name: /Requests/i }));
    await waitFor(() => {
      expect(screen.getByText('/api/ship/request/by-email')).toBeTruthy();
      expect(screen.getByText('API Gateway live source')).toBeTruthy();
      expect(screen.getAllByText('Request confirmation').length).toBeGreaterThan(0);
      expect(screen.getAllByText('Available').length).toBeGreaterThan(0);
    });
  });

  // ── 6. Module mount · env=false but client present → explicit dev preview
  it('keeps request projections current while the Requests inbox is open without manual refresh', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    renderWithProviders(<ApiGatewayModule />, { capabilities: ['all'] });
    const requestsTab = await screen.findByRole('tab', { name: /Requests/i });
    const listMock = listResourceSpy as unknown as Mock;

    fireEvent.click(requestsTab);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    const requestReadsBefore = listMock.mock.calls.filter(
      ([resource]) => resource === 'api_gateway_requests',
    ).length;

    apiGatewayRequestRows = [
      {
        id: 'req_requests_auto_tail',
        request_id: 'req_requests_auto_tail',
        method: 'POST',
        path: '/api/ship/request/by-email',
        source_id: 'src_api_gateway_auto_tail',
        source_label: 'API Gateway auto tail source',
        route_id: 'route_ship_by_email',
        route_name: 'logestechs_v2_create_shipment_by_email',
        route_pack_id: 'pack_ship_by_email',
        route_pack_name: 'Logestechs shipment API',
        intake_state: 'workflow_queued',
        outbound_status: 'provider_failed',
        status_code: 202,
        correlation_id: 'd09b0294-6732-4a85-8326-e2ade323042b',
        received_at: new Date().toISOString(),
        occurred_at: new Date().toISOString(),
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      },
    ];

    await act(async () => {
      await vi.advanceTimersByTimeAsync(2200);
    });

    await waitFor(() => {
      const requestReadsAfter = listMock.mock.calls.filter(
        ([resource]) => resource === 'api_gateway_requests',
      ).length;
      expect(requestReadsAfter).toBeGreaterThan(requestReadsBefore);
    });
    await waitFor(() => {
      expect(screen.getByRole('row', { name: /req_requests_auto_tail/i })).toBeTruthy();
      expect(screen.getByText('/api/ship/request/by-email')).toBeTruthy();
      expect(screen.getByText('API Gateway auto tail source')).toBeTruthy();
    });
    expect(screen.getByTestId('api-gateway-live-toggle').textContent ?? '').not.toMatch(/Pause/);
  });

  it('uses explicit DEV PREVIEW mode when VITE_REALTIME_ENABLED=false even with a client', async () => {
    vi.stubEnv('VITE_REALTIME_ENABLED', 'false');
    vi.stubEnv('VITE_API_GATEWAY_SYNTHETIC_LIVE_TAIL', 'true');
    mockClient = makeFakeClient();
    vi.useFakeTimers({ shouldAdvanceTime: true });
    renderWithProviders(<ApiGatewayModule />, { capabilities: ['all'] });
    await waitFor(() =>
      expect(screen.getByTestId('api-gateway-live-toggle')).toBeTruthy(),
    );
    // Mode pill stays on update checks.
    const modePill = screen.getByTestId('api-gateway-stream-mode');
    expect(modePill.textContent ?? '').toMatch(/Update checks active/);
    fireEvent.click(screen.getByTestId('api-gateway-live-toggle'));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(4500);
    });
    // Channel was NEVER opened despite the client being non-null.
    expect((mockClient as FakeClient).channel).not.toHaveBeenCalled();
    // But the synthesizer still ticked.
    await waitFor(() => {
      const livePill = screen.queryByText(/Live updates: \d+ new/);
      expect(livePill).toBeTruthy();
    });
  });

  it('does not synthesize rows when realtime is off and the dev flag is absent', async () => {
    vi.stubEnv('VITE_REALTIME_ENABLED', 'false');
    vi.stubEnv('VITE_API_GATEWAY_SYNTHETIC_LIVE_TAIL', '');
    mockClient = makeFakeClient();
    renderWithProviders(<ApiGatewayModule />, { capabilities: ['all'] });
    const toggle = await screen.findByTestId('api-gateway-live-toggle');
    expect(toggle).toBeDisabled();
    expect(screen.getByTestId('api-gateway-stream-mode').textContent ?? '').toMatch(/unavailable/i);
    expect((mockClient as FakeClient).channel).not.toHaveBeenCalled();
  });

  // ── 6. Tear-down: toggling live-tail off unsubscribes the channel ──────
  it('unsubscribes the realtime channel when live-tail is paused', async () => {
    vi.stubEnv('VITE_REALTIME_ENABLED', 'true');
    mockClient = makeFakeClient();
    renderWithProviders(<ApiGatewayModule />, { capabilities: ['all'] });
    await waitFor(() =>
      expect(screen.getByTestId('api-gateway-live-toggle')).toBeTruthy(),
    );
    const toggle = screen.getByTestId('api-gateway-live-toggle');
    fireEvent.click(toggle); // start live
    await waitFor(() =>
      expect((mockClient as FakeClient).channel).toHaveBeenCalledWith('api_call_log'),
    );
    fireEvent.click(toggle); // pause live
    await waitFor(() => {
      // Either unsubscribe() or removeChannel() must have been invoked on
      // tear-down (both shapes are supported by the live-tail effect).
      const chTeardown =
        ((lastChannel as FakeChannel).unsubscribe as Mock).mock.calls.length > 0;
      const clientTeardown =
        ((mockClient as FakeClient).removeChannel as Mock).mock.calls.length > 0;
      expect(chTeardown || clientTeardown).toBe(true);
    });
  });
});
