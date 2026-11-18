// Chip.tsx — small inline status pill. Visual parity with demo's `chip()` helper:
// classes are `chip chip--{kind}` plus optional `chip--xs` for the dense variant.
import type { ReactNode } from 'react';

export type ChipKind = 'good' | 'warn' | 'danger' | 'info' | 'neutral' | 'ink';
export type ChipSize = 'xs' | 'sm';

export interface ChipProps {
  label: ReactNode;
  kind?: ChipKind;
  size?: ChipSize;
  className?: string;
  title?: string;
  /**
   * Test hook — forwarded to the rendered `<span>` so tests can target the
   * chip without relying on its label text (which is i18n-sensitive).
   */
  'data-testid'?: string;
}

export function Chip({
  label,
  kind = 'neutral',
  size = 'sm',
  className,
  title,
  'data-testid': dataTestId,
}: ChipProps) {
  const classes = ['chip', `chip--${kind}`, size === 'xs' ? 'chip--xs' : '', className]
    .filter(Boolean)
    .join(' ');
  return (
    <span className={classes} title={title} data-testid={dataTestId}>
      {label}
    </span>
  );
}
