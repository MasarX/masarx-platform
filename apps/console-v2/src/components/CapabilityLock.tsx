// CapabilityLock.tsx — small lock chip rendered next to actions/values that the
// current user lacks the capability for. Mirrors demo `capabilityLock()`.
import { Icon } from './Icon';
import { formatCapabilityRequirement, formatCapabilityTitle } from '../lib/capabilities';
import { useT } from '../lib/i18n';

export interface CapabilityLockProps {
  capability: string;
  className?: string;
}

export function CapabilityLock({ capability, className }: CapabilityLockProps) {
  const t = useT();
  const classes = ['cap-lock', className].filter(Boolean).join(' ');
  return (
    <span className={classes} title={formatCapabilityTitle(capability, t)}>
      <Icon name="lock" size={9} />
      <span>{formatCapabilityRequirement(capability, t)}</span>
    </span>
  );
}
