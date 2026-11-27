// live-connection.test.tsx — #405 live refresh: state derivation, the page
// connection hook and the Statusbar store.
import { describe, it, expect, vi } from 'vitest';
import { act, screen } from '@testing-library/react';
import { renderWithProviders } from '@/test/render';
import { LiveChip } from '@/components/LiveStatus';
import { qk } from '@/lib/queries';
import * as supabase from './supabase';
import {
  deriveLiveState,
  LIVE_CONFIG,
  useLiveConnection,
  useLiveStatus,
  type LiveInputs,
  type LiveState,
} from './live-connection';

const base: LiveInputs = {
  online: true,
  realtime: true,
  channel: 'joined',
  failures: 0,
  lastBeatAt: 0,
  hasData: true,
  catchingUp: false,
  now: 1_000,
};

describe('deriveLiveState', () => {
  it.each<[string, Partial<LiveInputs>, LiveState]>([
    ['offline when the browser is offline', { online: false }, 'offline'],
    ['offline wins over missing data', { online: false, hasData: false }, 'offline'],
    ['syncing before the first data', { hasData: false }, 'syncing'],
    ['syncing while catching up after a reconnect', { catchingUp: true }, 'syncing'],
    ['polling when realtime is off', { realtime: false }, 'polling'],
    ['polling after maxReconnects failures', { channel: 'lost', failures: LIVE_CONFIG.maxReconnects }, 'polling'],
    ['live when the channel is joined', {}, 'live'],
    ['syncing while the channel connects', { channel: 'connecting' }, 'syncing'],
    [
      'reconnecting right after the channel is lost',
      { channel: 'lost', failures: 1, now: LIVE_CONFIG.offlineAfterMs - 1 },
      'reconnecting',
    ],
    [
      'offline once no heartbeat arrives for offlineAfterMs',
      { channel: 'lost', failures: 1, now: LIVE_CONFIG.offlineAfterMs },
      'offline',
    ],
  ])('%s', (_name, patch, expected) => {
    expect(deriveLiveState({ ...base, ...patch })).toBe(expected);
  });
});

function Harness({ dataUpdatedAt }: { dataUpdatedAt: number }) {
  const live = useLiveConnection({ topic: 'routes', enabled: true, dataUpdatedAt });
  return <LiveChip live={live} />;
}
function StatusProbe() {
  const status = useLiveStatus();
  return <span data-testid="probe">{status?.state ?? 'none'}</span>;
}

describe('useLiveConnection without realtime', () => {
  it('syncs, polls, goes offline with the browser and catches up on reconnect', () => {
    const { rerender } = renderWithProviders(
      <>
        <Harness dataUpdatedAt={0} />
        <StatusProbe />
      </>,
    );
    const chip = () => screen.getByTestId('live-chip');
    expect(chip()).toHaveAttribute('data-state', 'syncing');

    const loadedAt = Date.now();
    rerender(
      <>
        <Harness dataUpdatedAt={loadedAt} />
        <StatusProbe />
      </>,
    );
    expect(chip()).toHaveAttribute('data-state', 'polling');
    expect(screen.getByTestId('probe')).toHaveTextContent('polling');

    act(() => {
      window.dispatchEvent(new Event('offline'));
    });
    expect(chip()).toHaveAttribute('data-state', 'offline');
    expect(screen.getByTestId('probe')).toHaveTextContent('offline');

    act(() => {
      window.dispatchEvent(new Event('online'));
    });
    expect(chip()).toHaveAttribute('data-state', 'syncing');

    rerender(
      <>
        <Harness dataUpdatedAt={loadedAt + 1} />
        <StatusProbe />
      </>,
    );
    expect(chip()).toHaveAttribute('data-state', 'polling');
  });

  it('clears the Statusbar status when the page unmounts', () => {
    const { rerender } = renderWithProviders(
      <>
        <Harness dataUpdatedAt={Date.now()} />
        <StatusProbe />
      </>,
    );
    expect(screen.getByTestId('probe')).toHaveTextContent('polling');
    rerender(<StatusProbe />);
    expect(screen.getByTestId('probe')).toHaveTextContent('none');
  });
});

it.each([true, false])('joins the private route topic only with tenant-wide access (%s)', (tenantWide) => {
  const channel = { on: vi.fn().mockReturnThis(), subscribe: vi.fn().mockReturnThis() };
  const client = {
    channel: vi.fn().mockReturnValue(channel),
    realtime: { onHeartbeat: vi.fn() },
    removeChannel: vi.fn().mockResolvedValue("ok"),
  };
  const getClient = vi.spyOn(supabase, 'getSupabaseClient').mockReturnValue(
    client as unknown as NonNullable<ReturnType<typeof supabase.getSupabaseClient>>,
  );
  const realtimeFlag = vi.spyOn(supabase, 'isRealtimeEnabled').mockReturnValue(true);
  try {
    const { queryClient } = renderWithProviders(<Harness dataUpdatedAt={1} />, {
      locale: 'en',
      identity: {
        user: { access_scope_type: 'tenant', organization_id: 'tenant-one' },
        scope: {},
        capabilities: tenantWide ? ['routes.read', 'routes.write'] : ['routes.read'],
      },
    });
    if (!tenantWide) {
      expect(client.channel).not.toHaveBeenCalled();
      expect(screen.getByTestId('live-chip')).toHaveAttribute('data-state', 'polling');
      return;
    }
    expect(client.channel).toHaveBeenCalledWith('console-live:tenant-one:routes', { config: { private: true } });
    expect(channel.on).toHaveBeenCalledWith('broadcast', { event: 'invalidate' }, expect.any(Function));
    const routeKey = qk.completeList('route_runs');
    const otherKey = qk.list('organizations');
    queryClient.setQueryData(routeKey, []);
    queryClient.setQueryData(otherKey, []);

    act(() => channel.on.mock.calls[0][2]());
    expect(queryClient.getQueryState(routeKey)?.isInvalidated).toBe(true);
    expect(queryClient.getQueryState(otherKey)?.isInvalidated).toBe(false);
  } finally {
    getClient.mockRestore();
    realtimeFlag.mockRestore();
  }
});
