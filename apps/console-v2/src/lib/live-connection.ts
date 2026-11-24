// live-connection.ts — one connection hook per page for live refresh (#405).
//
// Contract (#405 backend): private Broadcast channel
// `console-live:<organization_id>:<topic>` sends event `invalidate` with an
// empty payload; the page refetches its existing scoped reads. When realtime is
// off for the build, or the channel fails `maxReconnects` times, the page polls
// every `pollMs`. The page's LiveChip and the Statusbar read the same state.
import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { useIdentity } from '@/lib/identity';
import { getSupabaseClient, isRealtimeEnabled } from '@/lib/supabase';

export type LiveState = 'syncing' | 'live' | 'reconnecting' | 'offline' | 'polling';
export type LiveTopic = 'routes' | 'shipments';
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
  const { user, scope } = useIdentity();
  const orgId = user?.organization_id || scope?.tenant?.id || null;
  const client = getSupabaseClient();
  const realtime = Boolean(enabled && client && orgId && isRealtimeEnabled());

  const [online, setOnline] = useState(() => (typeof navigator === 'undefined' ? true : navigator.onLine));
  const [channel, setChannel] = useState<ChannelStatus>('connecting');
  const [failures, setFailures] = useState(0);
  const [lastBeatAt, setLastBeatAt] = useState(() => Date.now());
  const [catchingUp, setCatchingUp] = useState(false);
  const [attempt, setAttempt] = useState(0);
  const [, setTick] = useState(0);

  const refetch = useCallback(() => {
    void queryClient.invalidateQueries({ refetchType: 'active' });
  }, [queryClient]);

  useEffect(() => {
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
  }, [refetch]);

  useEffect(() => {
    if (!realtime || !client) return undefined;
    let lost = false;
    const markLost = () => {
      lost = true;
      setChannel('lost');
    };
    const ch = client
      .channel(`console-live:${orgId}:${topic}`, { config: { private: true } })
      .on('broadcast', { event: 'invalidate' }, () => refetch())
      .subscribe((status) => {
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
    return () => {
      client.realtime.onHeartbeat(() => undefined);
      void client.removeChannel(ch);
    };
  }, [realtime, client, orgId, topic, attempt, refetch]);

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
    if (state !== 'polling') return undefined;
    const id = window.setInterval(refetch, LIVE_CONFIG.pollMs);
    return () => window.clearInterval(id);
  }, [state, refetch]);

  useEffect(() => {
    if (enabled) publish({ state, syncedAt: dataUpdatedAt });
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

// ---- rows: hold new rows behind "Show", keep order, mark in-place updates ----

interface HeldView {
  resetKey: string;
  order: string[];
  sig: Map<string, string>;
  updated: Set<string>;
}

function signatures<T>(rows: readonly T[], keyOf: (row: T) => string): Map<string, string> {
  return new Map(rows.map((r) => [keyOf(r), JSON.stringify(r)]));
}

/**
 * Keeps the on-screen order fixed while data refreshes. Rows that were not on
 * screen are counted and held until `show()`; rows on screen update in place and
 * are listed in `updated` until the next change. An empty list adopts new rows
 * directly, so the empty state fills without a click. A new `resetKey` (the
 * list's filters) starts over, and `pinnedId` (a row the user opened) is never held.
 */
export function useHeldRows<T>(
  rows: readonly T[] | undefined,
  keyOf: (row: T) => string,
  { resetKey = '', pinnedId = null }: { resetKey?: string; pinnedId?: string | null } = {},
) {
  const keyRef = useRef(keyOf);
  keyRef.current = keyOf;
  const [view, setView] = useState<HeldView | null>(null);

  useEffect(() => {
    if (!rows) return;
    const key = keyRef.current;
    setView((prev) => {
      const sig = signatures(rows, key);
      if (!prev || prev.order.length === 0 || prev.resetKey !== resetKey) {
        return { resetKey, order: rows.map(key), sig, updated: new Set() };
      }
      const updated = new Set(prev.order.filter((id) => sig.has(id) && prev.sig.has(id) && prev.sig.get(id) !== sig.get(id)));
      const sameSig = sig.size === prev.sig.size && [...sig].every(([id, s]) => prev.sig.get(id) === s);
      // Keep a pinned row on screen after it is no longer pinned.
      const pin = pinnedId && sig.has(pinnedId) && !prev.order.includes(pinnedId) ? [pinnedId] : [];
      if (sameSig && pin.length === 0) return prev;
      return { resetKey, order: [...pin, ...prev.order], sig, updated };
    });
  }, [rows, resetKey, pinnedId]);

  const list = rows ?? [];
  const byId = new Map(list.map((r) => [keyOf(r), r]));
  const held = view?.resetKey === resetKey ? view.order : list.map(keyOf);
  const order = pinnedId && byId.has(pinnedId) && !held.includes(pinnedId) ? [pinnedId, ...held] : held;
  const known = new Set(order);
  const visible = order.map((id) => byId.get(id)).filter((r): r is T => r !== undefined);
  const newCount = list.filter((r) => !known.has(keyOf(r))).length;

  const show = useCallback(() => {
    setView((prev) => (prev && rows ? { ...prev, order: rows.map(keyRef.current), updated: new Set() } : prev));
  }, [rows]);

  return { visible, newCount, updated: view?.resetKey === resetKey ? view.updated : new Set<string>(), show };
}

/**
 * Online-only edit conflict: true when the record changed after the edit began
 * (`baseline` is the record's snapshot when the form opened). Offline never conflicts.
 */
export function useEditConflict(baseline: unknown, record: unknown, state: LiveState) {
  const base = baseline == null ? null : JSON.stringify(baseline);
  const now = record == null ? null : JSON.stringify(record);
  const [dismissed, setDismissed] = useState<string | null>(null);
  const conflict = base != null && now != null && now !== base && now !== dismissed && state !== 'offline';
  return { conflict, dismiss: () => setDismissed(now) };
}
