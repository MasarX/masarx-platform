// PageHeader.tsx — module-level header with eyebrow + accent/plain title +
// pills + actions. Mirrors demo `pageHeader()`.
//
// When `moduleKey` is supplied, the eyebrow/accent/plain text is read from
// the i18n catalog under `modules.{moduleKey}.{eyebrow|accent|plain}`. If
// any of those keys are missing the explicit prop wins (or the value falls
// back to an empty string), so this stays row-/catalog-driven without
// blowing up on partial translations.
import type { ReactNode } from 'react';
import { useI18n } from '../lib/i18n';

export interface PageHeaderProps {
  moduleKey?: string;
  eyebrow?: ReactNode;
  titleAccent?: ReactNode;
  titlePlain?: ReactNode;
  pills?: ReactNode[];
  actions?: ReactNode[];
  className?: string;
}

function resolved<T>(catalogValue: string, key: string, prop: T | undefined): T | string | undefined {
  // i18n.t() returns the path itself when the key is missing, so we can detect that.
  if (catalogValue && catalogValue !== key) return catalogValue;
  return prop;
}

export function PageHeader({
  moduleKey,
  eyebrow,
  titleAccent,
  titlePlain,
  pills,
  actions,
  className,
}: PageHeaderProps) {
  const { t } = useI18n();

  let resolvedEyebrow: ReactNode = eyebrow;
  let resolvedAccent: ReactNode = titleAccent;
  let resolvedPlain: ReactNode = titlePlain;

  if (moduleKey) {
    const eyeKey = `modules.${moduleKey}.eyebrow`;
    const accentKey = `modules.${moduleKey}.accent`;
    const plainKey = `modules.${moduleKey}.plain`;
    if (resolvedEyebrow == null) resolvedEyebrow = resolved(t(eyeKey), eyeKey, eyebrow);
    if (resolvedAccent == null) resolvedAccent = resolved(t(accentKey), accentKey, titleAccent);
    if (resolvedPlain == null) resolvedPlain = resolved(t(plainKey), plainKey, titlePlain);
  }

  const classes = ['page-header', className].filter(Boolean).join(' ');

  return (
    <div className={classes}>
      <div className="page-header__title-block">
        <div className="page-header__eyebrow">{resolvedEyebrow ?? ''}</div>
        <h1 className="page-header__title">
          {resolvedAccent ? <span className="word-strong">{resolvedAccent} </span> : null}
          {resolvedPlain ?? ''}
        </h1>
      </div>
      {pills && pills.length > 0 ? (
        <div className="page-header__pills">
          {pills.map((p, i) => (
            <span key={i}>{p}</span>
          ))}
        </div>
      ) : null}
      <div className="page-header__spacer" />
      {actions && actions.length > 0 ? (
        <div className="page-header__actions">
          {actions.map((a, i) => (
            <span key={i}>{a}</span>
          ))}
        </div>
      ) : null}
    </div>
  );
}
