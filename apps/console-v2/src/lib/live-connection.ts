// live-connection.ts — one connection hook per page for live refresh (#405).
//
// Contract (#405 backend): private Broadcast channel
// `console-live:<organization_id>:<topic>` sends event `invalidate` with an
// empty payload; the page refetches its existing scoped reads. When realtime is
// off for the build, or the channel fails `maxReconnects` times, the page polls
// every `pollMs`. The page's LiveChip and the Statusbar read the same state.
import { useCallback, useEffect, useState, useSyncExternalStore } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { CAP } from '@/lib/capabilities';
import { useIdentity } from '@/lib/identity';
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
const channelRemovals = new WeakMap<LiveClient, Promise<unknown>>();
type ChannelStatus = 'connecting' | 'joined' | 'lost';

/** Single source for live-refresh timing. Heartbeat timing comes from the realtime client itself. */
export const LIVE_CONFIG = {
  pollMs: 30_000,
  offlineAfterMs: 60_000,
  maxReconnects: 3,
} as const;

export interface LiveInputs {
  online: boolean;
  realtime: boolean;
  channel: ChannelStatus;
  failures: number;
  lastBeatAt: number;
  hasData: boolean;
  catchingUp: boolean;
  now: number;
}

export function deriveLiveState(i: LiveInputs, cfg: typeof LIVE_CONFIG = LIVE_CONFIG): LiveState {
  if (!i.online) return 'offline';
  if (!i.hasData || i.catchingUp) return 'syncing';
  if (!i.realtime || i.failures >= cfg.maxReconnects) return 'polling';
  if (i.channel === 'joined') return 'live';
  if (i.channel === 'connecting') return 'syncing';
  return i.now - i.lastBeatAt >= cfg.offlineAfterMs ? 'offline' : 'reconnecting';
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
  pollMs: number;
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
  const { user, scope, hasCapability, isAuthenticated } = useIdentity();
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
  const [catchingUp, setCatchingUp] = useState(false);
  const [attempt, setAttempt] = useState(0);
  const [, setTick] = useState(0);

  const refetch = useCallback(() => {
    void queryClient.invalidateQueries({
      predicate: ({ queryKey: [kind, resource] }) =>
        (kind === 'list' || kind === 'lists_by_filters')
        && typeof resource === 'string' && LIVE_RESOURCES[topic].includes(resource),
      refetchType: 'active',
    });
  }, [queryClient, topic]);

  useEffect(() => {
    if (!enabled) return undefined;
    const up = () => {
      setOnline(true);
      setCatchingUp(true);
      refetch();
    };
    const down = () => setOnline(false);
    window.addEventListener('online', up);
    window.addEventListener('offline', down);
    return () => {
      window.removeEventListener('online', up);
      window.removeEventListener('offline', down);
    };
  }, [enabled, refetch]);

  const polling = !realtime || failures >= LIVE_CONFIG.maxReconnects;
  useEffect(() => {
    if (polling || !client || !online) return undefined;
    let active = true;
    let lost = false;
    const markLost = () => {
      lost = true;
      setChannel('lost');
    };
    let channel: ReturnType<LiveClient['channel']> | undefined;
    const join = () => {
      if (!active) return;
      channel = client
        .channel(`console-live:${orgId}:${topic}`, { config: { private: true } })
        .on('broadcast', { event: 'invalidate' }, () => refetch())
        .subscribe((status) => {
          if (!active) return;
          if (status === 'SUBSCRIBED') {
            setChannel('joined');
            setFailures(0);
            setLastBeatAt(Date.now());
            if (lost) {
              setCatchingUp(true);
              refetch();
            }
            lost = false;
          } else if (status === 'CHANNEL_ERROR' || status === 'TIMED_OUT') {
            markLost();
            setFailures((f) => f + 1);
          }
        });
      // One missed heartbeat (the client's own heartbeatIntervalMs) means reconnecting.
      client.realtime.onHeartbeat((beat) => {
        if (beat === 'ok') setLastBeatAt(Date.now());
        else if (beat === 'timeout' || beat === 'error' || beat === 'disconnected') markLost();
      });
    };

    // Realtime reuses a topic until its previous channel has left.
    const pendingRemoval = channelRemovals.get(client);
    if (pendingRemoval) void pendingRemoval.then(join);
    else join();

    return () => {
      active = false;
      if (!channel) return;
      client.realtime.onHeartbeat(() => undefined);
      const removal = client.removeChannel(channel);
      channelRemovals.set(client, removal);
      void removal.then(() => {
        if (channelRemovals.get(client) === removal) channelRemovals.delete(client);
      });
    };
  }, [polling, client, online, orgId, topic, attempt, refetch]);

  useEffect(() => {
    setCatchingUp(false);
  }, [dataUpdatedAt]);

  const state = deriveLiveState({
    online,
    realtime,
    channel,
    failures,
    lastBeatAt,
    hasData: dataUpdatedAt > 0,
    catchingUp,
    now: Date.now(),
  });

  // Re-derive when the no-heartbeat window turns reconnecting into offline.
  useEffect(() => {
    if (state !== 'reconnecting') return undefined;
    const id = window.setTimeout(
      () => setTick((t) => t + 1),
      Math.max(0, lastBeatAt + LIVE_CONFIG.offlineAfterMs - Date.now()),
    );
    return () => window.clearTimeout(id);
  }, [state, lastBeatAt]);

  useEffect(() => {
    if (!enabled || !online || !polling) return undefined;
    const id = window.setInterval(refetch, LIVE_CONFIG.pollMs);
    return () => window.clearInterval(id);
  }, [enabled, online, polling, refetch]);

  useEffect(() => {
    publish(enabled ? { state, syncedAt: dataUpdatedAt } : null);
  }, [enabled, state, dataUpdatedAt]);
  useEffect(() => () => publish(null), []);

  const retry = useCallback(() => {
    setFailures(0);
    setChannel('connecting');
    setAttempt((a) => a + 1);
    setCatchingUp(true);
    refetch();
  }, [refetch]);

  return { state, syncedAt: dataUpdatedAt, pollMs: LIVE_CONFIG.pollMs, retry };
}
