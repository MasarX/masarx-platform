// Button.tsx — opinionated app button.
// Mirrors demo `btn({ label, kind, iconName, onClick, disabled, capability })`:
// when a `capability` is required and the current user does not hold it, the
// button is disabled and a CapabilityLock chip is appended (zero-redundancy:
// callers never fork their own gate logic).
// Actions run on click only, never on pointer or mouse down, so a press can be
// cancelled by releasing outside the button (WCAG 2.5.2, #420).
import type { ReactNode } from 'react';
import { Icon } from './Icon';
import { CapabilityLock } from './CapabilityLock';
import { useIdentity } from '../lib/identity';

export type ButtonKind = 'primary' | 'ghost' | 'danger';
export type ButtonSize = 'sm' | 'md';

export interface ButtonProps {
  label?: ReactNode;
  children?: ReactNode;
  iconName?: string;
  kind?: ButtonKind;
  onClick?: (event: React.MouseEvent<HTMLButtonElement>) => void;
  disabled?: boolean;
  capability?: string;
  capabilities?: string[];
  anyCapabilities?: string[];
  size?: ButtonSize;
  type?: 'button' | 'submit' | 'reset';
  className?: string;
  title?: string;
  ariaLabel?: string;
  testId?: string;
}

export function Button({
  label,
  children,
  iconName,
  kind,
  onClick,
  disabled,
  capability,
  capabilities,
  anyCapabilities,
  size = 'md',
  type = 'button',
  className,
  title,
  ariaLabel,
  testId,
}: ButtonProps) {
  const { hasCapability } = useIdentity();
  const requiredCapabilities = [capability, ...(capabilities ?? [])].filter(Boolean) as string[];
  const missingCapabilities = requiredCapabilities.filter((cap) => !hasCapability(cap));
  const anyCapabilityOptions = (anyCapabilities ?? []).filter(Boolean);
  const missingAnyCapability =
    anyCapabilityOptions.length > 0 && !anyCapabilityOptions.some((cap) => hasCapability(cap));
  const denied = missingCapabilities.length > 0 || missingAnyCapability;
  const lockCapabilities = [
    ...missingCapabilities,
    ...(missingAnyCapability ? anyCapabilityOptions : []),
  ];
  const isDisabled = !!disabled || denied;

  const classes = [
    'btn',
    kind ? `btn--${kind}` : '',
    size === 'sm' ? 'btn--sm' : '',
    className,
  ]
    .filter(Boolean)
    .join(' ');

  const handleClick = (event: React.MouseEvent<HTMLButtonElement>) => {
    if (isDisabled) return;
    onClick?.(event);
  };

  return (
    <button
      type={type}
      className={classes}
      onClick={handleClick}
      disabled={isDisabled}
      aria-disabled={isDisabled || undefined}
      aria-label={ariaLabel}
      data-testid={testId}
      title={title}
    >
      {iconName ? <Icon name={iconName} size={12} /> : null}
      {label != null ? <span>{label}</span> : null}
      {children}
      {denied ? lockCapabilities.map((cap) => <CapabilityLock key={cap} capability={cap} />) : null}
    </button>
  );
}
