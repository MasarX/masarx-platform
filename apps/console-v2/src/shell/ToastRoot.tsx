// ToastRoot.tsx — portal-rendered toast stack. Subscribes to the global toast
// store and renders the visual <Toast /> component for each entry.
//
// W49 strict closure (AGENTS.md §2 ZERO HARDCODING + §4 SSOT):
// auto-dismiss timing now lives here, sourced from canonical
// `ui_presentation_policy.toast.duration_ms` via `useResolveSettings`. While
// the policy is unresolved, no timers are scheduled — entries persist visibly
// so missing seeds surface to operators rather than silently defaulting.
// Each entry's effective duration is `entry.durationMs ?? policy.duration_ms`;
// the per-tone icon mapping is also canonical (`toast.icon_for_tone`) and
// passed down to `<Toast />` as a required prop.
//
// Mounts via `createPortal` to `#toast-root` if it exists, otherwise to <body>.
// `index.html` already provides `#toast-root` per the demo shell; falling back
// to `<body>` keeps the component robust if it is ever rendered without that
// container (e.g. in tests).
import { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import { subscribeToasts, dismissToast, type ToastEntry } from '@/components/toastStore';
import { Toast } from '@/components/Toast';
import { useResolveSettings } from '@/lib/queries';
import { useIdentity } from '@/lib/identity';

export function ToastRoot() {
  const [toasts, setToasts] = useState<ToastEntry[]>([]);
  const [target, setTarget] = useState<Element | null>(null);
  const { isAuthenticated, isAuthLoading } = useIdentity();

  // Canonical UX-presentation policy — SSOT for toast duration + per-tone
  // iconography. While unresolved, timers do not start (entries persist) so
  // missing seeds become visible to operators.
  const policy = useResolveSettings('ui_presentation_policy', undefined, {
    enabled: isAuthenticated && !isAuthLoading,
  });
  const policyValue = policy.data?.value as
    | {
        toast?: {
          duration_ms?: number;
          icon_for_tone?: Record<string, string>;
        };
      }
    | undefined;
  const policyDurationMs = policyValue?.toast?.duration_ms;
  const iconForTone = policyValue?.toast?.icon_for_tone ?? {};

  // Resolve the portal target once. Falls back to <body> when the explicit
  // `#toast-root` slot is not present.
  useEffect(() => {
    if (typeof document === 'undefined') return;
    const explicit = document.getElementById('toast-root');
    setTarget(explicit ?? document.body);
  }, []);

  // Subscribe to the global toast store; the store is now timer-free, so this
  // component owns the dismissal lifecycle below.
  useEffect(() => {
    const unsubscribe = subscribeToasts((next) => setToasts(next));
    return () => {
      unsubscribe?.();
    };
  }, []);

  // Schedule dismissal timers per active entry. Each effect run tracks its
  // own timer ids in a local array so React strict-mode double-mount cleans
  // up correctly without double-firing the underlying `dismissToast`.
  useEffect(() => {
    if (policyDurationMs == null) return; // Hold entries until policy lands.
    const timers: ReturnType<typeof setTimeout>[] = [];
    for (const entry of toasts) {
      const ttl = entry.durationMs ?? policyDurationMs;
      if (ttl > 0) {
        const id = setTimeout(() => dismissToast(entry.id), ttl);
        timers.push(id);
      }
    }
    return () => {
      for (const id of timers) clearTimeout(id);
    };
  }, [toasts, policyDurationMs]);

  if (!target) return null;

  return createPortal(
    <div className="toast-stack" role="status" aria-live="polite">
      {toasts.map((t) => (
        <Toast
          key={t.id}
          toast={t}
          iconForTone={iconForTone}
          onDismiss={dismissToast}
        />
      ))}
    </div>,
    target
  );
}
