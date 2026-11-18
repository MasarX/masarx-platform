// StateView.tsx — semantic empty/loading/denied/error placeholder.
// Mirrors demo `stateView(kind, opts)` — defaults read from i18n
// (`states.{kind}.title|hint`) so callers can pass a kind alone.
import type { ReactNode } from 'react';
import { CapabilityLock } from './CapabilityLock';
import { useI18n } from '../lib/i18n';
import { GENERIC_VIEW_ERROR, sanitizeOperatorNode } from './operatorMessages';

export type StateKind = 'empty' | 'loading' | 'denied' | 'error';

export interface StateViewProps {
  kind: StateKind;
  title?: ReactNode;
  hint?: ReactNode;
  capability?: string;
  action?: ReactNode;
  className?: string;
}

export function StateView({ kind, title, hint, capability, action, className }: StateViewProps) {
  const { t } = useI18n();
  const titleFallback = kind === 'error' ? t('states.error.title', 'Something went wrong') : t(`states.${kind}.title`, kind);
  const hintFallback = kind === 'error' ? GENERIC_VIEW_ERROR : t(`states.${kind}.hint`, '');
  const resolvedTitle = sanitizeOperatorNode(title ?? titleFallback, titleFallback);
  const resolvedHint = sanitizeOperatorNode(hint ?? hintFallback, hintFallback);
  const classes = ['state', `state--${kind}`, className].filter(Boolean).join(' ');
  return (
    <div className={classes}>
      <h3 className="state__title">{resolvedTitle}</h3>
      {resolvedHint ? <p className="state__hint">{resolvedHint}</p> : null}
      {capability ? <CapabilityLock capability={capability} /> : null}
      {action ?? null}
    </div>
  );
}
