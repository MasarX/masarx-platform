// expiryDescriptor.ts — pure helper for ExpiryChip's tone-ladder logic.
// Kept separate from `ExpiryChip.tsx` so the .tsx file only exports
// components (react-refresh hot-reload friendly).
//
// W49 strict closure: the previous `DEFAULT_EXPIRY_THRESHOLDS` constant has
// been removed in line with AGENTS.md §2 (ZERO HARDCODING). Thresholds MUST
// be sourced from canonical `ui_presentation_policy.expiry_thresholds`
// (resolved via `useResolveSettings`) and passed to this helper explicitly.
// The `thresholds` parameter is now required at the type level so a missing
// canonical row surfaces as a danger-toned chip at the call site instead of
// silently masking the gap with a baked-in default.
import type { ChipKind } from './Chip';

export interface ExpiryDescriptor {
  kind: ChipKind;
  label: string;
}

function diffInDays(target: Date, now: Date): number {
  const ms = target.getTime() - now.getTime();
  return Math.ceil(ms / 86_400_000);
}

export function computeExpiryDescriptor(
  expiresAt: string | null,
  thresholds: { warn: number; danger: number },
  now: Date = new Date(),
): ExpiryDescriptor {
  if (expiresAt == null) return { kind: 'neutral', label: 'No expiry' };
  const target = new Date(expiresAt);
  if (Number.isNaN(target.getTime())) return { kind: 'neutral', label: 'Invalid date' };
  const days = diffInDays(target, now);
  if (days < 0) {
    const ago = Math.abs(days);
    return { kind: 'danger', label: `Expired ${ago} day${ago === 1 ? '' : 's'} ago` };
  }
  if (days <= thresholds.danger) {
    return {
      kind: 'danger',
      label: days === 0 ? 'Expires today' : `Expires in ${days} day${days === 1 ? '' : 's'}`,
    };
  }
  if (days <= thresholds.warn) {
    return { kind: 'warn', label: `Expires in ${days} days` };
  }
  return { kind: 'neutral', label: `${days} days left` };
}
