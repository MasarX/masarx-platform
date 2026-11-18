// ExpiryChip.tsx — days-until-expiry pill with auto-tone.
//
// Pure presentational: caller passes `expiresAt` and the chip computes the
// tone label automatically against `thresholds`. Wraps the existing `<Chip>`
// primitive so tone classes/styles cascade from one place. The tone ladder is:
//   - days < 0  → danger ("Expired N days ago")
//   - 0 ≤ days ≤ thresholds.danger → danger ("Expires in N days")
//   - thresholds.danger < days ≤ thresholds.warn → warn ("Expires in N days")
//   - days > thresholds.warn → neutral ("N days left")
//   - expiresAt === null → neutral ("No expiry")
//
// W49 strict closure (AGENTS.md §2 ZERO HARDCODING + §4 SSOT):
// thresholds default to canonical `ui_presentation_policy.expiry_thresholds`
// resolved via `useResolveSettings`. When the canonical row is missing the
// chip renders a danger-toned `(missing)` pill so the gap is visible — no
// silent inline-default fallback. Callers may still override via the explicit
// `thresholds?` prop (e.g. ad-hoc threshold experimentation in stories).
import { Chip, type ChipSize } from './Chip';
import { computeExpiryDescriptor } from './expiryDescriptor';
import { useResolveSettings } from '@/lib/queries';

export interface ExpiryChipProps {
  expiresAt: string | null;
  thresholds?: { warn: number; danger: number };
  /** Optional prefix label (e.g. "License") rendered before the chip text. */
  prefix?: string;
  size?: ChipSize;
  className?: string;
  /** Inject a fixed reference time for deterministic tests. Defaults to `Date.now()`. */
  now?: string | Date;
}

export function ExpiryChip({
  expiresAt,
  thresholds,
  prefix,
  size = 'sm',
  className,
  now,
}: ExpiryChipProps) {
  // Resolve canonical UX-presentation thresholds. Caller-supplied `thresholds`
  // wins so storybook + targeted tests can pin specific values.
  const policy = useResolveSettings('ui_presentation_policy', undefined);
  const policyValue = policy.data?.value as
    | { expiry_thresholds?: { warn_days?: number; danger_days?: number } }
    | undefined;
  const warnDays = policyValue?.expiry_thresholds?.warn_days;
  const dangerDays = policyValue?.expiry_thresholds?.danger_days;

  if (thresholds == null) {
    if (policy.isLoading) {
      return <Chip label="…" kind="neutral" size={size} className={className} />;
    }
    if (warnDays == null || dangerDays == null) {
      // Operator-friendly fail-loud chip. The raw policy key is too leaky for
      // a tenant operator to read; the danger tone preserves the "fix this
      // gap" signal while the title attribute keeps the canonical key
      // available for engineers debugging the surface.
      return (
        <Chip
          label="Expiry policy not configured"
          kind="danger"
          size={size}
          className={className}
          title="ui_presentation_policy.expiry_thresholds is missing for this scope"
        />
      );
    }
  }

  const effectiveThresholds =
    thresholds ?? { warn: warnDays as number, danger: dangerDays as number };
  const descriptor = computeExpiryDescriptor(
    expiresAt,
    effectiveThresholds,
    now == null ? new Date() : new Date(now),
  );
  const label = prefix ? `${prefix} · ${descriptor.label}` : descriptor.label;
  return <Chip label={label} kind={descriptor.kind} size={size} className={className} />;
}
