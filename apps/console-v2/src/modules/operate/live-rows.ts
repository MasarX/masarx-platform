import { useCallback, useEffect, useRef, useState } from 'react';
import type { LiveState } from '@/lib/live-connection';

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
      // Unchanged rows keep the same view, so a caller's fresh `[]` per render cannot loop.
      const sameSig = !!prev && sig.size === prev.sig.size && [...sig].every(([id, s]) => prev.sig.get(id) === s);
      if (prev && sameSig && prev.resetKey === resetKey && (!pinnedId || !sig.has(pinnedId) || prev.order.includes(pinnedId))) {
        return prev;
      }
      if (!prev || prev.order.length === 0 || prev.resetKey !== resetKey) {
        return { resetKey, order: rows.map(key), sig, updated: new Set() };
      }
      const updated = new Set(prev.order.filter((id) => sig.has(id) && prev.sig.has(id) && prev.sig.get(id) !== sig.get(id)));
      // Keep a pinned row on screen after it is no longer pinned.
      const pin = pinnedId && sig.has(pinnedId) && !prev.order.includes(pinnedId) ? [pinnedId] : [];
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
