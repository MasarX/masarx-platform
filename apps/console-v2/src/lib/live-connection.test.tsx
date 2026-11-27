// live-connection.test.tsx — #405 live refresh: state derivation, the page
// connection hook and the Statusbar store.
import { afterEach, beforeEach, describe, it, expect, vi } from 'vitest';
import { act, cleanup, fireEvent, screen } from '@testing-library/react';
import { QueryObserver, type QueryFunctionContext } from '@tanstack/react-query';
import { makeQueryClient, renderWithProviders } from '@/test/render';
import { LiveChip } from '@/components/LiveStatus';
import { qk } from '@/lib/queries';
import * as supabase from './supabase';
import {
  deriveLiveState,
  useLiveConnection,
  useLiveStatus,
  type LiveInputs,
  type LiveState,
} from './live-connection';

const config = { pollMs: 4_000, offlineAfterMs: 6_000, maxReconnects: 2, refetchMs: 1_000 };
const settingsKey = qk.resolveSettings('ui_presentation_policy');
const routeKey = qk.completeList('route_runs');

function configuredClient(liveRefresh: unknown = {
  poll_interval_ms: config.pollMs,
  offline_after_ms: config.offlineAfterMs,
  max_reconnects: config.maxReconnects,
  refetch_interval_ms: config.refetchMs,
}) {
  const client = makeQueryClient();
  client.setQueryDefaults(settingsKey, { staleTime: Infinity });
  client.setQueryData(settingsKey, { value: { live_refresh: liveRefresh } });
  return client;
}

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
    ['polling after maxReconnects failures', { channel: 'lost', failures: config.maxReconnects }, 'polling'],
    ['live when the channel is joined', {}, 'live'],
    ['syncing while the channel connects', { channel: 'connecting' }, 'syncing'],
    [
      'reconnecting right after the channel is lost',
      { channel: 'lost', failures: 1, now: config.offlineAfterMs - 1 },
      'reconnecting',
    ],
    [
      'offline once no heartbeat arrives for offlineAfterMs',
      { channel: 'lost', failures: 1, now: config.offlineAfterMs },
      'offline',
    ],
  ])('%s', (_name, patch, expected) => {
    expect(deriveLiveState({ ...base, ...patch }, config)).toBe(expected);
  });
});

function Harness({ dataUpdatedAt = 1, topic = 'routes' }: { dataUpdatedAt?: number; topic?: 'routes' | 'shipments' }) {
  const live = useLiveConnection({ topic, enabled: true, dataUpdatedAt });
  return <LiveChip live={live} />;
}
function StatusProbe() {
  const status = useLiveStatus();
  return <span data-testid="probe">{status?.state ?? 'none'}</span>;
}

describe('useLiveConnection without realtime', () => {
  it('syncs, polls, goes offline with the browser and catches up on reconnect', async () => {
    const { rerender } = renderWithProviders(
      <>
        <Harness dataUpdatedAt={0} />
        <StatusProbe />
      </>,
      { queryClient: configuredClient() },
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

    await act(async () => {});
    expect(chip()).toHaveAttribute('data-state', 'polling');
  });

  it('clears the Statusbar status when the page unmounts', () => {
    const { rerender } = renderWithProviders(
      <>
        <Harness dataUpdatedAt={Date.now()} />
        <StatusProbe />
      </>,
      { queryClient: configuredClient() },
    );
    expect(screen.getByTestId('probe')).toHaveTextContent('polling');
    rerender(<StatusProbe />);
    expect(screen.getByTestId('probe')).toHaveTextContent('none');
  });
});

type Client = NonNullable<ReturnType<typeof supabase.getSupabaseClient>>;
type Channel = ReturnType<Client['channel']>;
type ChannelStatus = `${Parameters<NonNullable<Parameters<Channel['subscribe']>[0]>>[0]}`;

function mockSocket() {
  const client = {
    channel: vi.fn((_name: string) => ({
      on: vi.fn<(_kind: string, _filter: unknown, callback: () => void) => void>().mockReturnThis(),
      subscribe: vi.fn<(callback: (status: ChannelStatus) => void) => void>().mockReturnThis(),
    })),
    realtime: { onHeartbeat: vi.fn<Client['realtime']['onHeartbeat']>() },
    removeChannel: vi.fn().mockResolvedValue('ok'),
  };
  vi.spyOn(supabase, 'getSupabaseClient').mockReturnValue(client as unknown as Client);
  vi.spyOn(supabase, 'isRealtimeEnabled').mockReturnValue(true);
  const channel = (index: number) => client.channel.mock.results[index].value as ReturnType<typeof client.channel>;
  return {
    client,
    channel,
    status: (index: number, status: ChannelStatus) => channel(index).subscribe.mock.calls[0][0](status),
    message: (index = 0) => channel(index).on.mock.calls[0][2](),
    heartbeat: () => client.realtime.onHeartbeat.mock.calls[0][0]('timeout'),
  };
}

const tenant = {
  user: { access_scope_type: 'tenant' as const, organization_id: 'tenant-one' },
  scope: {},
  capabilities: ['routes.read', 'routes.write', 'shipments.read'],
};

describe('private live refresh', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  it.each([
    ['routes', ['routes.read', 'routes.write'], true],
    ['routes', ['routes.read'], false],
    ['shipments', ['shipments.read'], true],
    ['shipments', ['routes.read', 'routes.write'], false],
  ] as const)('gates the %s topic for %j (%s)', async (topic, capabilities, allowed) => {
    const socket = mockSocket();
    const { queryClient } = renderWithProviders(<Harness topic={topic} />, {
      queryClient: configuredClient(),
      identity: { ...tenant, capabilities: [...capabilities] },
    });
    const chip = screen.getByTestId('live-chip');
    if (!allowed) {
      expect(socket.client.channel).not.toHaveBeenCalled();
      expect(chip).toHaveAttribute('data-state', 'polling');
      return;
    }
    expect(socket.client.channel).toHaveBeenCalledWith(`console-live:tenant-one:${topic}`, { config: { private: true } });
    expect(socket.channel(0).on).toHaveBeenCalledWith('broadcast', { event: 'invalidate' }, expect.any(Function));
    expect(chip).toHaveAttribute('data-state', 'syncing');
    const key = topic === 'routes' ? routeKey : qk.list('shipment_directory');
    const otherKey = qk.list('organizations');
    queryClient.setQueryData(key, []);
    queryClient.setQueryData(otherKey, []);
    await act(async () => socket.status(0, 'SUBSCRIBED'));
    expect(chip).toHaveAttribute('data-state', 'live');
    expect(queryClient.getQueryState(key)?.isInvalidated).toBe(true);
    expect(queryClient.getQueryState(otherKey)?.isInvalidated).toBe(false);
  });

  it('coalesces a burst and fetches the final state after the in-flight read', async () => {
    const socket = mockSocket();
    const queryClient = configuredClient();
    let finishRead!: (value: string) => void;
    let signal: AbortSignal | undefined;
    let serverValue = 'before';
    const read = vi.fn(async (_context: QueryFunctionContext) => serverValue);
    const observer = new QueryObserver(queryClient, { queryKey: routeKey, queryFn: read, staleTime: Infinity, initialData: 'before' });
    const stop = observer.subscribe(() => undefined);
    renderWithProviders(<Harness />, { queryClient, identity: tenant });
    await act(async () => socket.status(0, 'SUBSCRIBED'));
    expect(read).toHaveBeenCalledTimes(1);

    read.mockImplementationOnce((context) => {
      signal = context.signal;
      return new Promise<string>((resolve) => { finishRead = resolve; });
    });
    const readInFlight = observer.refetch();
    for (let i = 0; i < 20; i++) socket.message();
    await act(async () => vi.advanceTimersByTimeAsync(config.refetchMs - 1));
    serverValue = 'last change';
    socket.message();
    await act(async () => vi.advanceTimersByTimeAsync(1));
    expect(signal?.aborted).toBe(false);
    expect(read).toHaveBeenCalledTimes(2);
    await act(async () => {
      finishRead('early snapshot');
      await readInFlight;
    });
    expect(read).toHaveBeenCalledTimes(3);
    expect(queryClient.getQueryData(routeKey)).toBe('last change');
    await act(async () => vi.advanceTimersByTimeAsync(config.refetchMs));
    expect(read).toHaveBeenCalledTimes(3);
    stop();
  });

  it('waits for a rejoin, catches up, and offers Retry on failure', async () => {
    const socket = mockSocket();
    const queryClient = configuredClient();
    const read = vi.fn().mockResolvedValue('updated');
    const observer = new QueryObserver(queryClient, { queryKey: routeKey, queryFn: read, staleTime: Infinity, initialData: 'old' });
    const stop = observer.subscribe(() => undefined);
    renderWithProviders(<Harness />, { queryClient, identity: tenant, locale: 'en' });
    const chip = screen.getByTestId('live-chip');
    await act(async () => socket.status(0, 'SUBSCRIBED'));
    expect(chip).toHaveAttribute('data-state', 'live');
    fireEvent(window, new Event('offline'));
    expect(chip).toHaveAttribute('data-state', 'offline');
    await act(async () => { window.dispatchEvent(new Event('online')); });
    expect(chip).toHaveAttribute('data-state', 'syncing');
    expect(read).toHaveBeenCalledTimes(1);

    read.mockRejectedValueOnce(new Error('read failed'));
    await act(async () => socket.status(1, 'SUBSCRIBED'));
    expect(chip).toHaveAttribute('data-state', 'reconnecting');
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Retry' })); });
    expect(chip).toHaveAttribute('data-state', 'syncing');
    await act(async () => socket.status(2, 'SUBSCRIBED'));
    expect(read).toHaveBeenCalledTimes(3);
    expect(chip).toHaveAttribute('data-state', 'live');
    stop();
  });

  it('falls back at the configured failure limit and stops polling on unmount', async () => {
    const socket = mockSocket();
    const queryClient = configuredClient();
    const invalidate = vi.spyOn(queryClient, 'invalidateQueries');
    const { unmount } = renderWithProviders(<Harness />, { queryClient, identity: tenant });
    const chip = screen.getByTestId('live-chip');
    act(() => socket.status(0, 'CHANNEL_ERROR'));
    expect(chip).toHaveAttribute('data-state', 'reconnecting');
    act(() => socket.status(0, 'CHANNEL_ERROR'));
    expect(chip).toHaveAttribute('data-state', 'polling');
    expect(socket.client.removeChannel).toHaveBeenCalledWith(socket.channel(0));
    await act(async () => vi.advanceTimersByTimeAsync(config.pollMs));
    expect(invalidate).toHaveBeenCalledTimes(1);
    unmount();
    await act(async () => vi.advanceTimersByTimeAsync(config.pollMs));
    expect(invalidate).toHaveBeenCalledTimes(1);
  });

  it('delivers heartbeats to two hooks and removes only the departing hook callback', async () => {
    const socket = mockSocket();
    const queryClient = configuredClient();
    const invalidate = vi.spyOn(queryClient, 'invalidateQueries');
    const { rerender } = renderWithProviders(
      <><Harness key="routes" /><Harness key="shipments" topic="shipments" /></>,
      { queryClient, identity: tenant },
    );
    await act(async () => { socket.status(0, 'SUBSCRIBED'); socket.status(1, 'SUBSCRIBED'); });
    expect(socket.client.realtime.onHeartbeat).toHaveBeenCalledTimes(1);
    act(socket.heartbeat);
    expect(screen.getAllByTestId('live-chip').map((chip) => chip.dataset.state)).toEqual(['reconnecting', 'reconnecting']);
    act(() => socket.status(1, 'SUBSCRIBED'));
    socket.message(0);
    rerender(<><Harness key="shipments" topic="shipments" /></>);
    expect(socket.client.removeChannel).toHaveBeenCalledWith(socket.channel(0));

    await act(async () => vi.advanceTimersByTimeAsync(config.refetchMs));
    expect(invalidate).toHaveBeenCalledTimes(3);
    expect(screen.getByTestId('live-chip')).toHaveAttribute('data-state', 'live');
    act(socket.heartbeat);
    await act(async () => vi.advanceTimersByTimeAsync(config.offlineAfterMs));
    expect(screen.getByTestId('live-chip')).toHaveAttribute('data-state', 'offline');
  });

  it('does not join or poll with an invalid policy', async () => {
    const socket = mockSocket();
    const queryClient = configuredClient({ poll_interval_ms: 0 });
    const invalidate = vi.spyOn(queryClient, 'invalidateQueries');
    renderWithProviders(<Harness />, { queryClient, identity: tenant, locale: 'en' });
    expect(screen.getByRole('button', { name: 'Retry' })).toBeInTheDocument();
    await act(async () => vi.advanceTimersByTimeAsync(config.pollMs));
    expect(socket.client.channel).not.toHaveBeenCalled();
    expect(invalidate).not.toHaveBeenCalled();
  });
});
