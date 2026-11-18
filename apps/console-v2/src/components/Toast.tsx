// Toast.tsx — single visual toast row. The shell-level ToastRoot
// (src/shell/ToastRoot.tsx) is responsible for subscribing to the store
// and rendering this component for each entry.
//
// Mirrors demo `toast(message, kind)` styling: `toast toast--{tone}` plus
// a small leading icon driven by the canonical
// `ui_presentation_policy.toast.icon_for_tone` mapping injected by the
// parent. When the resolved tone is not present in the mapping the icon
// slot renders an explicit `?` placeholder so the gap is visible — no
// silent fallback.
//
// W49 strict closure (AGENTS.md §2 ZERO HARDCODING + §4 SSOT):
// the previous inline `ICON_FOR_TONE` constant has been removed; callers
// (currently only `<ToastRoot />`) MUST pass the canonical `iconForTone`
// mapping resolved via `useResolveSettings`.
import { Icon } from './Icon';
import type { ToastEntry, ToastTone } from './toastStore';

export interface ToastProps {
  toast: ToastEntry;
  /** Canonical tone→icon mapping resolved from `ui_presentation_policy.toast.icon_for_tone`. */
  iconForTone: Record<string, string>;
  onDismiss?: (id: string) => void;
  className?: string;
}

export function Toast({ toast, iconForTone, onDismiss, className }: ToastProps) {
  const tone: ToastTone = toast.tone ?? 'info';
  const classes = ['toast', `toast--${tone}`, className].filter(Boolean).join(' ');
  const iconName = iconForTone[tone];
  return (
    <div
      className={classes}
      role="status"
      aria-live="polite"
      onClick={onDismiss ? () => onDismiss(toast.id) : undefined}
    >
      {iconName ? (
        <Icon name={iconName} size={12} />
      ) : (
        <span aria-hidden="true">?</span>
      )}
      <span>{toast.message}</span>
    </div>
  );
}
