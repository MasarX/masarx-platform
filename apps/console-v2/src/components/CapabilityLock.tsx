// CapabilityLock.tsx — small lock chip rendered next to actions/values that the
// current user lacks the capability for. Mirrors demo `capabilityLock()`.
import { Icon } from './Icon';
import { formatCapabilityRequirement, formatCapabilityTitle } from '../lib/capabilities';

export interface CapabilityLockProps {
  capability: string;
  className?: string;
}

export function CapabilityLock({ capability, className }: CapabilityLockProps) {
  const classes = ['cap-lock', className].filter(Boolean).join(' ');
  return (
    <span className={classes} title={formatCapabilityTitle(capability)}>
      <Icon name="lock" size={9} />
      <span>{formatCapabilityRequirement(capability)}</span>
    </span>
  );
}
