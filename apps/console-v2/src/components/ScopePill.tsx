// ScopePill.tsx — labeled scope pill (rank letter + scope_type). Mirrors demo `scopePill()`.
// Used in the ladder visualizer, decision trail rows, and detail headers.
//
// W56-B (F3) — Rank letter resolves through the canonical `scope_type`
// lookup_values rows (`metadata.rank_letter`) instead of an inline Record.
// Missing row → '?' marker so the operator sees the gap rather than a
// neutral-toned silent default.
import type { ScopeType } from '../types/domain';
import { lookupRow } from '@/lib/api';
import { fill, useT } from '@/lib/i18n';

export interface ScopePillProps {
  scopeType: ScopeType | string;
  scopeId?: string;
  className?: string;
}

export function ScopePill({ scopeType, className }: ScopePillProps) {
  const t = useT();
  const row = lookupRow('scope_type', scopeType) as
    | { metadata?: { rank_letter?: string } }
    | null;
  const rank = row?.metadata?.rank_letter ?? '?';
  const scopeLabel = t(`scopePill.type.${scopeType}`, String(scopeType));
  const title = fill(t('scopePill.title'), { scope: scopeLabel });
  const classes = ['scope-pill', className].filter(Boolean).join(' ');
  return (
    <span className={classes} title={title}>
      <span className="scope-pill__rank">{rank}</span>
      <span>{scopeLabel}</span>
    </span>
  );
}
