// decisions-realtime.test.tsx — W33 coverage for the env-gated live-tail
// path on /insights/decisions. Mirrors api-gateway-realtime.test.tsx 1:1.
//
// Coverage targets:
//   1. shapeDecisionRealtimePayload pure shaper handles full + partial
//      payloads and bails out on missing required fields (id/decision_category).
//   2. isDecisionsRealtimeEnabled returns true ONLY when
//      VITE_REALTIME_ENABLED=true AND a non-null supabase client is supplied.
//   3. Module mount in DEMO mode (env false → no client) still streams via
//      api.streamEvidence and never calls `client.channel(...)`. The
//      PREVIEW pill is surfaced.
//   4. Module mount in LIVE mode (env true → mocked client) calls
//      `client.channel('decision_log').on('postgres_changes', …).subscribe()`
//      and prepends shaped payload rows onto the live buffer. The LIVE pill
//      is surfaced.
//   5. Module mount with env=false but a client present stays in DEMO mode
//      (we should never silently subscribe).
//   6. Toggling live-tail off tears the realtime channel down.
//
// Strategy: we mock `@/lib/supabase` at module level so `getSupabaseClient`
// can return a fresh fake per test (with `channel().on().subscribe()` chain).
// `vi.stubEnv` drives `import.meta.env.VITE_REALTIME_ENABLED`.
// `api.streamEvidence` is mocked so DEMO mode does not race against the seed
// loader — we only need to verify the mode selection, not the synthetic
// generator's content (already covered by data-source unit tests).

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
import { DecisionsModule } from '../decisions';
import {
  isDecisionsRealtimeEnabled,
  shapeDecisionRealtimePayload,
} from '../_shared';

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
}

let lastChannel: FakeChannel | null = null;
let lastHandler: ((payload: { new?: Record<string, unknown> | null }) => void) | null = null;

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
  };
  return client;
}

let mockClient: FakeClient | null = null;

vi.mock('@/lib/supabase', () => {
  return {
    getSupabaseClient: () => mockClient,
    rpc: vi.fn(async () => null),
    __resetSupabaseClientForTests: () => {
      mockClient = null;
    },
  };
});

// We mock streamEvidence so we can verify the DEMO-mode path without racing
// against the seed-loader's synthetic timer schedule. The factory returns a
// no-op unsubscribe and registers the callback so callers can simulate a
// row by invoking it directly.
const streamEvidenceCallbacks: Array<(entry: Record<string, unknown>) => void> = [];
const streamEvidenceUnsubscribe = vi.fn();
vi.mock('@/lib/api', async () => {
  const actual = await vi.importActual<typeof import('@/lib/api')>('@/lib/api');
  return {
    ...actual,
    streamEvidence: vi.fn((cb: (entry: Record<string, unknown>) => void) => {
      streamEvidenceCallbacks.push(cb);
      return streamEvidenceUnsubscribe;
    }),
  };
});

// ---------------------------------------------------------------------------

describe('insights/decisions · realtime live-tail (W33 closure)', () => {
  beforeEach(() => {
    mockClient = null;
    lastChannel = null;
    lastHandler = null;
    streamEvidenceCallbacks.length = 0;
    streamEvidenceUnsubscribe.mockClear();
    localStorage.clear();
    vi.useRealTimers();
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.useRealTimers();
  });

  // ── 1. shapeDecisionRealtimePayload ─────────────────────────────────────
  describe('shapeDecisionRealtimePayload', () => {
    it('shapes a complete decision_log INSERT payload', () => {
      const out = shapeDecisionRealtimePayload({
        id: 'dec_1',
        timestamp: '2026-04-25T12:00:00Z',
        decision_category: 'route_assignment',
        settings_resolution_id: 'srlv_1',
        resource_id: 'shp_1',
        resource_type: 'shipment',
        decision_inputs: { reason: 'auto' },
        correlation_id: 'cor_1',
      });
      expect(out).not.toBeNull();
      expect(out?.id).toBe('dec_1');
      expect(out?.timestamp).toBe('2026-04-25T12:00:00Z');
      expect(out?.decision_category).toBe('route_assignment');
      expect(out?.settings_resolution_id).toBe('srlv_1');
      expect(out?.correlation_id).toBe('cor_1');
      // resolved_from is projected via JOIN, not present on raw INSERT envelope.
      expect(out?.resolved_from).toBeNull();
    });

    it('falls back from occurred_at to timestamp safely on partial payloads', () => {
      const out = shapeDecisionRealtimePayload({
        id: 'dec_2',
        decision_category: 'rate_limit_block',
        occurred_at: '2026-04-25T13:00:00Z',
      });
      expect(out).not.toBeNull();
      expect(out?.timestamp).toBe('2026-04-25T13:00:00Z');
      // Optional fields default to null safely.
      expect(out?.settings_resolution_id).toBeNull();
      expect(out?.resource_id).toBeNull();
      expect(out?.correlation_id).toBeNull();
    });

    it('returns null when required keys are missing', () => {
      expect(shapeDecisionRealtimePayload(null)).toBeNull();
      expect(shapeDecisionRealtimePayload(undefined)).toBeNull();
      expect(shapeDecisionRealtimePayload({})).toBeNull();
      // id is required.
      expect(
        shapeDecisionRealtimePayload({
          decision_category: 'x',
          timestamp: '2026-04-25T00:00:00Z',
        }),
      ).toBeNull();
      // decision_category is required.
      expect(
        shapeDecisionRealtimePayload({
          id: 'dec_x',
          timestamp: '2026-04-25T00:00:00Z',
        }),
      ).toBeNull();
    });
  });

  // ── 2. isDecisionsRealtimeEnabled ────────────────────────────────────────
  describe('isDecisionsRealtimeEnabled', () => {
    it('returns false when client is null even if env is true', () => {
      vi.stubEnv('VITE_REALTIME_ENABLED', 'true');
      expect(isDecisionsRealtimeEnabled(null)).toBe(false);
    });

    it('returns false when env is unset / false', () => {
      const fake = { channel: () => ({}) } as unknown as Parameters<
        typeof isDecisionsRealtimeEnabled
      >[0];
      vi.stubEnv('VITE_REALTIME_ENABLED', '');
      expect(isDecisionsRealtimeEnabled(fake)).toBe(false);
      vi.stubEnv('VITE_REALTIME_ENABLED', 'false');
      expect(isDecisionsRealtimeEnabled(fake)).toBe(false);
      vi.stubEnv('VITE_REALTIME_ENABLED', 'no');
      expect(isDecisionsRealtimeEnabled(fake)).toBe(false);
    });

    it('returns true only when env=true AND client is present', () => {
      const fake = { channel: () => ({}) } as unknown as Parameters<
        typeof isDecisionsRealtimeEnabled
      >[0];
      vi.stubEnv('VITE_REALTIME_ENABLED', 'true');
      expect(isDecisionsRealtimeEnabled(fake)).toBe(true);
      vi.stubEnv('VITE_REALTIME_ENABLED', 'TRUE'); // case-insensitive
      expect(isDecisionsRealtimeEnabled(fake)).toBe(true);
    });
  });

  // ── 3. Module mount · DEMO mode (no client) ─────────────────────────────
  it('falls back to streamEvidence in DEMO mode (env=false, no client)', async () => {
    vi.stubEnv('VITE_REALTIME_ENABLED', 'false');
    mockClient = null; // no supabase client
    renderWithProviders(<DecisionsModule />, { capabilities: ['all'] });
    await waitFor(() =>
      expect(screen.getByTestId('decisions-live-toggle')).toBeTruthy(),
    );
    // Mode pill shows preview (not live).
    const modePill = screen.getByTestId('decisions-stream-mode');
    expect(modePill.textContent ?? '').toMatch(/Preview event stream/);
    // Toggle live-tail on.
    fireEvent.click(screen.getByTestId('decisions-live-toggle'));
    // streamEvidence was called (DEMO path).
    await waitFor(() => {
      expect(streamEvidenceCallbacks.length).toBeGreaterThan(0);
    });
    // No supabase channel was ever opened.
    expect(mockClient).toBeNull();
  });

  // ── 4. Module mount · LIVE mode (env=true + client present) ────────────
  it('subscribes via Supabase Realtime in LIVE mode and prepends shaped payloads', async () => {
    vi.stubEnv('VITE_REALTIME_ENABLED', 'true');
    mockClient = makeFakeClient();
    renderWithProviders(<DecisionsModule />, { capabilities: ['all'] });
    await waitFor(() =>
      expect(screen.getByTestId('decisions-live-toggle')).toBeTruthy(),
    );
    // Mode pill shows live.
    const modePill = screen.getByTestId('decisions-stream-mode');
    expect(modePill.textContent ?? '').toMatch(/Live event stream/);
    // Toggle live-tail on.
    fireEvent.click(screen.getByTestId('decisions-live-toggle'));
    // Wait for the effect to register the subscription.
    await waitFor(() => {
      expect((mockClient as FakeClient).channel).toHaveBeenCalledWith('decision_log');
    });
    expect((lastChannel as FakeChannel).on).toHaveBeenCalled();
    expect((lastChannel as FakeChannel).subscribe).toHaveBeenCalled();
    // Inspect the postgres_changes filter payload.
    const onCall = ((lastChannel as FakeChannel).on as Mock).mock.calls[0];
    expect(onCall?.[0]).toBe('postgres_changes');
    expect(onCall?.[1]).toEqual({
      event: 'INSERT',
      schema: 'public',
      table: 'decision_log',
    });
    // Drive a fake realtime payload through the captured handler.
    expect(typeof lastHandler).toBe('function');
    await act(async () => {
      lastHandler!({
        new: {
          id: 'dec_rt_1',
          timestamp: new Date().toISOString(),
          decision_category: 'route_assignment',
          settings_resolution_id: 'srlv_rt_1',
          resource_id: 'shp_rt_1',
          resource_type: 'shipment',
          correlation_id: 'cor_rt_1',
        },
      });
    });
    // The "live · n new" pill should reflect the prepended row.
    await waitFor(() => {
      const pill = screen.queryByText(/live · 1 new/);
      expect(pill).toBeTruthy();
    });
    // streamEvidence was NEVER called in LIVE mode.
    expect(streamEvidenceCallbacks.length).toBe(0);
  });

  // ── 5. Module mount · env=false but client present → still DEMO ─────────
  it('stays in DEMO mode when VITE_REALTIME_ENABLED=false even with a client', async () => {
    vi.stubEnv('VITE_REALTIME_ENABLED', 'false');
    mockClient = makeFakeClient();
    renderWithProviders(<DecisionsModule />, { capabilities: ['all'] });
    await waitFor(() =>
      expect(screen.getByTestId('decisions-live-toggle')).toBeTruthy(),
    );
    // Mode pill stays preview.
    const modePill = screen.getByTestId('decisions-stream-mode');
    expect(modePill.textContent ?? '').toMatch(/Preview event stream/);
    fireEvent.click(screen.getByTestId('decisions-live-toggle'));
    // Channel was NEVER opened despite the client being non-null.
    await waitFor(() => {
      expect(streamEvidenceCallbacks.length).toBeGreaterThan(0);
    });
    expect((mockClient as FakeClient).channel).not.toHaveBeenCalled();
  });

  // ── 6. Tear-down: toggling live-tail off unsubscribes the channel ──────
  it('unsubscribes the realtime channel when live-tail is paused', async () => {
    vi.stubEnv('VITE_REALTIME_ENABLED', 'true');
    mockClient = makeFakeClient();
    renderWithProviders(<DecisionsModule />, { capabilities: ['all'] });
    await waitFor(() =>
      expect(screen.getByTestId('decisions-live-toggle')).toBeTruthy(),
    );
    const toggle = screen.getByTestId('decisions-live-toggle');
    fireEvent.click(toggle); // start live
    await waitFor(() =>
      expect((mockClient as FakeClient).channel).toHaveBeenCalledWith('decision_log'),
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
