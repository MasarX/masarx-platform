// _shared.tsx — Finance-domain shared helpers (zero-redundancy refactor).
//
// Before: DetailRow + SeamLine duplicated 3× across settlements/disputes/bank-recon.
// Pure helpers (matchBankStatementLines / agingBucket / varianceState) are split
// into _matcher.ts so they can be unit-tested without React.
import type { ReactNode } from 'react';

// ---------- Reusable detail row (replaces 3× duplication) ----------
export interface DetailRowProps {
  k: string;
  v: ReactNode;
  mono?: boolean;
  danger?: boolean;
}

export function DetailRow({ k, v, mono, danger }: DetailRowProps) {
  return (
    <div
      style={{
        display: 'flex',
        padding: '4px 0',
        borderBottom: '1px solid var(--line)',
        fontSize: '11.5px',
      }}
    >
      <span className="mono" style={{ color: 'var(--ink-3)', minWidth: '120px' }}>
        {k}
      </span>
      <span
        className={mono ? 'mono' : undefined}
        style={danger ? { color: 'var(--danger-ink)' } : undefined}
      >
        {v}
      </span>
    </div>
  );
}

// ---------- Reusable canonical-seam line (replaces 3× duplication) ----------
export interface SeamLineProps {
  k: string;
  v: string;
}

export function SeamLine({ k, v }: SeamLineProps) {
  return (
    <div
      style={{
        display: 'flex',
        gap: '8px',
        padding: '3px 0',
        borderBottom: '1px solid var(--line)',
      }}
    >
      <span style={{ color: 'var(--ink-3)', minWidth: '180px', fontSize: '10.5px' }}>{k}</span>
      <span>{v}</span>
    </div>
  );
}
