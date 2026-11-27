// live-connection.ts — one connection hook per page for live refresh (#405).
//
// Contract (#405 backend): private Broadcast channel
// `console-live:<organization_id>:<topic>` sends event `invalidate` with an
// empty payload; the page refetches its existing scoped reads. When realtime is
// off for the build, or the channel fails `maxReconnects` times, the page polls
// every `pollMs`. The page's LiveChip and the Statusbar read the same state.
import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { useQueryClient, type InvalidateQueryFilters } from '@tanstack/react-query';
import { CAP } from '@/lib/capabilities';
import { useIdentity } from '@/lib/identity';
import { useResolveSettings } from '@/lib/queries';
import { getSupabaseClient, isRealtimeEnabled } from '@/lib/supabase';

export type LiveState = 'syncing' | 'live' | 'reconnecting' | 'offline' | 'polling';
const LIVE_RESOURCES = {
  routes: [
    'route_runs', 'route_stops', 'route_run_directory', 'route_run_assignments',
    'route_run_assignment_events', 'route_stop_reassignment_events', 'tasks', 'shipments',
  ],
  shipments: ['shipments', 'shipment_directory'],
} satisfies Record<string, string[]>;
type LiveTopic = keyof typeof LIVE_RESOURCES;
type LiveClient = NonNullable<ReturnType<typeof getSupabaseClient>>;
const channelRemovals = new WeakMap<LiveClient, Map<string, Promise<unknown>>>();
type ChannelStatus = 'connecting' | 'joined' | 'lost';
type RefreshStatus = 'idle' | 'pending' | 'failed';

type HeartbeatListener = Parameters<LiveClient['realtime']['onHeartbeat']>[0];
const heartbeatListeners = new WeakMap<LiveClient, Set<HeartbeatListener>>();

function listenForHeartbeat(client: LiveClient, listener: HeartbeatListener) {
  let listeners = heartbeatListeners.get(client);
  if (!listeners) {
    const callbacks = new Set<HeartbeatListener>();
    client.realtime.onHeartbeat((status, latency) => callbacks.forEach((callback) => callback(status, latency)));
    heartbeatListeners.set(client, callbacks);
    listeners = callbacks;
  }
  listeners.add(listener);
  return () => listeners.delete(listener);
}

function positiveTimerInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value > 0 && value <= 2_147_483_647;
}

function readLivePolicy(value: unknown) {
  const policy = (value as { live_refresh?: Record<string, unknown> } | undefined)?.live_refresh;
  const { poll_interval_ms, offline_after_ms, max_reconnects, refetch_interval_ms } = policy ?? {};
  if (!positiveTimerInteger(poll_interval_ms) || !positiveTimerInteger(offline_after_ms)
    || !positiveTimerInteger(max_reconnects) || !positiveTimerInteger(refetch_interval_ms)) return null;
  return { pollMs: poll_interval_ms, offlineAfterMs: offline_after_ms, maxReconnects: max_reconnects, refetchMs: refetch_interval_ms };
}

export interface LiveInputs {
  online: boolean;
  realtime: boolean;
  channel: ChannelStatus;
  failures: number;
  lastBeatAt: number;
  hasData: boolean;
  catchingUp: boolean;
  refreshFailed?: boolean;
  now: number;
}

export function deriveLiveState(i: LiveInputs, cfg: { maxReconnects: number; offlineAfterMs: number }): LiveState {
  if (!i.online) return 'offline';
  const polling = !i.realtime || i.failures >= cfg.maxReconnects;
  if (!polling && i.channel === 'lost') {
    return i.now - i.lastBeatAt >= cfg.offlineAfterMs ? 'offline' : 'reconnecting';
  }
  if (i.refreshFailed) return 'reconnecting';
  if (!i.hasData || i.catchingUp) return 'syncing';
  if (polling) return 'polling';
  return i.channel === 'joined' ? 'live' : 'syncing';
}

// ---- shared status for the Statusbar (one clock, no second subscription) ----

export interface LiveStatus {
  state: LiveState;
  syncedAt: number;
}
let current: LiveStatus | null = null;
const listeners = new Set<() => void>();
function publish(next: LiveStatus | null) {
  if (current?.state === next?.state && current?.syncedAt === next?.syncedAt) return;
  current = next;
  listeners.forEach((l) => l());
}
function subscribe(l: () => void) {
  listeners.add(l);
  return () => listeners.delete(l);
}
/** The live status a mounted page publishes, or null when no live page is open. */
export function useLiveStatus(): LiveStatus | null {
  return useSyncExternalStore(subscribe, () => current, () => null);
}

export interface LiveConnection extends LiveStatus {
  pollMs: number | null;
  retry: () => void;
}

export function useLiveConnection({
  topic,
  enabled,
  dataUpdatedAt,
}: {
  topic: LiveTopic;
  enabled: boolean;
  dataUpdatedAt: number;
}): LiveConnection {
  const queryClient = useQueryClient();
  const { user, scope, hasCapability, isAuthenticated, isAuthLoading } = useIdentity();
  const policy = useResolveSettings('ui_presentation_policy', undefined, {
    enabled: enabled && isAuthenticated && !isAuthLoading,
  });
  const config = readLivePolicy(policy.data?.value);
  const { pollMs, offlineAfterMs, maxReconnects, refetchMs } = config ?? {};
  const orgId = user.organization_id;
  const client = getSupabaseClient();
  // With no route ID, the server's route policy requires tenant-wide route access.
  const realtime = Boolean(
    enabled && client && isAuthenticated && orgId && user.access_scope_type === 'tenant'
    && (!scope.tenant?.id || scope.tenant.id === orgId) && isRealtimeEnabled()
    && (topic === 'routes'
      ? hasCapability(CAP.ROUTES_READ) && hasCapability(CAP.ROUTES_WRITE)
      : hasCapability(CAP.SHIPMENTS_READ)),
  );

  const [online, setOnline] = useState(() => (typeof navigator === 'undefined' ? true : navigator.onLine));
  const [channel, setChannel] = useState<ChannelStatus>('connecting');
  const [failures, setFailures] = useState(0);
  const [lastBeatAt, setLastBeatAt] = useState(() => Date.now());
  const [refresh, setRefresh] = useState<RefreshStatus>('idle');
  const [attempt, setAttempt] = useState(0);
  const [, setTick] = useState(0);
  const catchUpOnPoll = useRef(!online);

  useEffect(() => {
    if (!enabled) return undefined;
    const up = () => {
      catchUpOnPoll.current = true;
      setChannel('connecting');
      setOnline(true);
    };
    const down = () => setOnline(false);
    window.addEventListener('online', up);
    window.addEventListener('offline', down);
    return () => {
      window.removeEventListener('online', up);
      window.removeEventListener('offline', down);
    };
  }, [enabled]);

  const polling = !realtime || (maxReconnects !== undefined && failures >= maxReconnects);
  useEffect(() => {
    if (!enabled || !online || pollMs === undefined || refetchMs === undefined) return undefined;
    const interval = refetchMs;
    let active = true;
    let queued = false;
    let catchUpQueued = false;
    let refreshing = false;
    let dueAt = 0;
    let availableAt = 0;
    let timer: number | undefined;
    const filters: InvalidateQueryFilters = {
      predicate: ({ queryKey: [kind, resource] }) =>
        (kind === 'list' || kind === 'lists_by_filters')
        && typeof resource === 'string' && LIVE_RESOURCES[topic].includes(resource),
      refetchType: 'active',
    };
    function flush() {
      if (!active || !queued || refreshing || timer !== undefined) return;
      const delay = dueAt - Date.now();
      if (delay > 0) {
        timer = window.setTimeout(() => {
          timer = undefined;
          flush();
        }, delay);
        return;
      }
      // A read that started before the invalidation can still return the previous snapshot.
      if (queryClient.isFetching({ ...filters, type: 'active' })) return;
      queued = false;
      const isCatchUp = catchUpQueued;
      catchUpQueued = false;
      refreshing = true;
      availableAt = Date.now() + interval;
      void queryClient.invalidateQueries(filters, { cancelRefetch: false, throwOnError: isCatchUp })
        .then(
          () => { if (active && isCatchUp && !catchUpQueued) setRefresh('idle'); },
          () => { if (active && isCatchUp && !catchUpQueued) setRefresh('failed'); },
        )
        .finally(() => {
          refreshing = false;
          flush();
        });
    }
    function requestRefresh(kind: 'broadcast' | 'catch-up' | 'poll') {
      if (!active) return;
      if (kind === 'catch-up') {
        catchUpQueued = true;
        setRefresh('pending');
      }
      if (!queued) {
        dueAt = kind === 'broadcast' ? Math.max(availableAt, Date.now() + interval) : availableAt;
        queued = true;
      }
      flush();
    }
    const unsubscribeCache = queryClient.getQueryCache().subscribe(flush);
    const catchUp = catchUpOnPoll.current;
    catchUpOnPoll.current = false;
    setChannel('connecting');
    setRefresh('idle');

    let pollTimer: number | undefined;
    let unsubscribeHeartbeat: (() => void) | undefined;
    let channel: ReturnType<LiveClient['channel']> | undefined;
    const channelName = `console-live:${orgId}:${topic}`;
    if (polling) {
      if (catchUp) requestRefresh('catch-up');
      pollTimer = window.setInterval(() => requestRefresh('poll'), pollMs);
    } else if (client) {
      const join = () => {
        if (!active) return;
        channel = client.channel(channelName, { config: { private: true } });
        channel.on('broadcast', { event: 'invalidate' }, () => requestRefresh('broadcast'))
          .subscribe((status) => {
            if (!active) return;
            if (status === 'SUBSCRIBED') {
              requestRefresh('catch-up');
              setChannel('joined');
              setFailures(0);
              setLastBeatAt(Date.now());
            } else if (status === 'CHANNEL_ERROR' || status === 'TIMED_OUT') {
              setChannel('lost');
              setFailures((count) => count + 1);
            } else if (status === 'CLOSED') {
              setChannel('lost');
            }
          });
        // One missed heartbeat uses the Realtime client's own heartbeat interval.
        unsubscribeHeartbeat = listenForHeartbeat(client, (beat) => {
          if (beat === 'ok') setLastBeatAt(Date.now());
          else if (beat === 'timeout' || beat === 'error' || beat === 'disconnected') setChannel('lost');
        });
      };
      // Realtime reuses the topic until its previous channel has left.
      const pendingRemoval = channelRemovals.get(client)?.get(channelName);
      if (pendingRemoval) void pendingRemoval.then(join);
      else join();
    }

    return () => {
      active = false;
      unsubscribeCache();
      unsubscribeHeartbeat?.();
      window.clearTimeout(timer);
      window.clearInterval(pollTimer);
      if (!client || !channel) return;
      const removals = channelRemovals.get(client) ?? new Map<string, Promise<unknown>>();
      const removal = client.removeChannel(channel).catch(() => undefined);
      removals.set(channelName, removal);
      channelRemovals.set(client, removals);
      void removal.then(() => {
        if (removals.get(channelName) === removal) removals.delete(channelName);
      });
    };
  }, [enabled, polling, client, online, orgId, topic, attempt, pollMs, refetchMs, queryClient]);

  const state = config ? deriveLiveState({
    online,
    realtime,
    channel,
    failures,
    lastBeatAt,
    hasData: dataUpdatedAt > 0,
    catchingUp: refresh === 'pending',
    refreshFailed: refresh === 'failed',
    now: Date.now(),
  }, config) : !online ? 'offline' : policy.isPending ? 'syncing' : 'reconnecting';

  // Re-derive when the no-heartbeat window turns reconnecting into offline.
  useEffect(() => {
    if (state !== 'reconnecting' || channel !== 'lost' || polling || offlineAfterMs === undefined) return undefined;
    const id = window.setTimeout(
      () => setTick((t) => t + 1),
      Math.max(0, lastBeatAt + offlineAfterMs - Date.now()),
    );
    return () => window.clearTimeout(id);
  }, [state, channel, polling, lastBeatAt, offlineAfterMs]);

  useEffect(() => {
    publish(enabled ? { state, syncedAt: dataUpdatedAt } : null);
  }, [enabled, state, dataUpdatedAt]);
  useEffect(() => () => publish(null), []);

  const retry = useCallback(() => {
    if (pollMs === undefined) {
      if (online) void policy.refetch();
      return;
    }
    catchUpOnPoll.current = true;
    setFailures(0);
    setChannel('connecting');
    setAttempt((a) => a + 1);
  }, [online, pollMs, policy.refetch]);

  return { state, syncedAt: dataUpdatedAt, pollMs: pollMs ?? null, retry };
}
