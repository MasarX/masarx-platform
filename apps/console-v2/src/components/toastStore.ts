// toastStore.ts — tiny pub/sub for transient notifications.
// Imperative `pushToast(...)` is the only public producer. The visual
// `<ToastRoot />` (in src/shell/ToastRoot.tsx) subscribes via
// `subscribeToasts`.
//
// W49 strict closure (AGENTS.md §2 ZERO HARDCODING + §4 SSOT):
// auto-dismiss timing is no longer baked into the store. Each entry carries
// an optional `durationMs` override; the actual timer is owned by
// `<ToastRoot />`, which reads canonical
// `ui_presentation_policy.toast.duration_ms` via `useResolveSettings` and
// drives dismissal from there. While the policy is unresolved, entries
// remain visible (no timer started) so missing seeds surface to operators
// rather than silently degrading to a 3.2s default.
//
import { sanitizeOperatorMessage } from './operatorMessages';

// Contract aligned with shell/ToastRoot.tsx:
//   ToastEntry = { id: string; message: string; tone?: 'good'|'warn'|'danger'|'info'; durationMs?: number }

export type ToastTone = 'good' | 'warn' | 'danger' | 'info';

export interface ToastEntry {
  id: string;
  message: string;
  tone?: ToastTone;
  /** Override the canonical-resolved auto-dismiss window. */
  durationMs?: number;
}

type Listener = (toasts: ToastEntry[]) => void;

let nextId = 1;
let entries: ToastEntry[] = [];
const listeners = new Set<Listener>();

function emit(): void {
  // Snapshot so subscribers receive an immutable list.
  const snapshot = entries.slice();
  for (const listener of listeners) listener(snapshot);
}

function dismiss(id: string): void {
  const before = entries.length;
  entries = entries.filter((e) => e.id !== id);
  if (entries.length !== before) emit();
}

export interface PushToastOptions {
  /** Override the canonical auto-dismiss window. Pass 0 to disable auto-dismiss. */
  durationMs?: number;
}

/**
 * Push a transient toast. Returns the toast id so callers can dismiss early
 * if needed (e.g. when a long-running action completes before the TTL).
 *
 * `kind` is named per the demo API; internally it maps to the shell's `tone`.
 *
 * Auto-dismiss timers are owned by `<ToastRoot />`, which sources the
 * canonical duration from `ui_presentation_policy.toast.duration_ms`.
 */
export function pushToast(
  message: string,
  kind: ToastTone = 'info',
  opts: PushToastOptions = {},
): string {
  const id = `t_${nextId++}`;
  const entry: ToastEntry = {
    id,
    message: sanitizeOperatorMessage(message),
    tone: kind,
    durationMs: opts.durationMs,
  };
  entries = [...entries, entry];
  emit();
  return id;
}

/** Manually dismiss a toast by id. Safe to call even if the id is already gone. */
export function dismissToast(id: string): void {
  dismiss(id);
}

/** Subscribe to toast changes. Returns an unsubscribe function. */
export function subscribeToasts(listener: Listener): () => void {
  listeners.add(listener);
  // Replay current snapshot so first-render is correct.
  listener(entries.slice());
  return () => {
    listeners.delete(listener);
  };
}

/** Read current toasts (used by tests / non-React consumers). */
export function getToasts(): ToastEntry[] {
  return entries.slice();
}

/** Clear all toasts. Used between tests. */
export function clearToasts(): void {
  if (entries.length === 0) return;
  entries = [];
  emit();
}
