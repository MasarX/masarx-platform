// _shared.tsx — Insights-only React COMPONENTS + hooks (JSX file).
//
// Pure helpers (RangeKey/ScopeKey/clampByRange/buildCurlGet/etc.) live in the
// sibling `_shared.ts` so this `.tsx` file only exports components and the
// hooks that consume them — keeping `react-refresh/only-export-components`
// satisfied and HMR healthy.
//
// Components:
//   <RangeChips />  — typed time-window chip rail (5m/1h/24h/7d/all).
//   <ScopeChips />  — typed override-ladder scope chip rail.
//   <CurlBlock />   — copy-paste curl template + Copy button + toast.
//
// Hooks:
//   useUpdateSearch()   — write-side; PATCH typed search params on the URL.
//   useInsightsSearch() — read-side; coerced view of typed search params.

import { useCallback, type ReactNode } from 'react';
import { Chip } from '@/components/Chip';
import { pushToast } from '@/components/toastStore';
import { RANGE_OPTIONS, type RangeKey, type ScopeKey } from './_shared';
import { useScopeOptions } from './_hooks';

// (Pure helpers + types live in `./_shared` — modules import from both files.)

// ---------- <RangeChips> ----------

export interface RangeChipsProps {
  value: RangeKey;
  onChange: (next: RangeKey) => void;
  /** Aria-label root. Default: "Time range" */
  label?: string;
}

const CHIP_BTN_STYLE = {
  background: 'none',
  border: 0,
  padding: 0,
  cursor: 'pointer',
} as const;

/**
 * Typed time-window chip rail. Each chip is a button so screen readers and
 * keyboard navigation work for free; the active chip uses the canonical
 * `info` chip kind so it lines up visually with other DataTable filter chips.
 */
export function RangeChips({ value, onChange, label = 'Time range' }: RangeChipsProps) {
  return (
    <div role="group" aria-label={label} className="view-bar__group">
      <span className="eyebrow" aria-hidden>
        {label}
      </span>
      {RANGE_OPTIONS.map((opt) => {
        const active = opt.key === value;
        return (
          <button
            key={opt.key}
            type="button"
            aria-pressed={active}
            data-range={opt.key}
            onClick={() => onChange(opt.key)}
            style={CHIP_BTN_STYLE}
          >
            <Chip
              label={opt.label}
              kind={active ? 'info' : 'neutral'}
              size="xs"
              className="mono"
            />
          </button>
        );
      })}
    </div>
  );
}

// ---------- <ScopeChips> ----------

export interface ScopeChipsProps {
  value: ScopeKey;
  onChange: (next: ScopeKey) => void;
  label?: string;
}

export function ScopeChips({ value, onChange, label = 'Scope' }: ScopeChipsProps) {
  // W54-D — option list is row-driven via `useScopeOptions()` which
  // subscribes to `scope_type_registry`. Replaces the inline SCOPE_OPTIONS
  // map. Static fallback to SCOPE_OPTIONS happens inside the hook when the
  // registry has not yet resolved, so the chip rail never renders empty.
  const options = useScopeOptions();
  return (
    <div role="group" aria-label={label} className="view-bar__group">
      <span className="eyebrow" aria-hidden>
        {label}
      </span>
      {options.map((opt) => {
        const active = opt.key === value;
        return (
          <button
            key={opt.key}
            type="button"
            aria-pressed={active}
            data-scope={opt.key}
            onClick={() => onChange(opt.key)}
            style={CHIP_BTN_STYLE}
          >
            <Chip
              label={opt.label}
              kind={active ? 'info' : 'neutral'}
              size="xs"
              className="mono"
            />
          </button>
        );
      })}
    </div>
  );
}

// ---------- <CurlBlock> ----------

export interface CurlBlockProps {
  value: string;
  /** Optional caption above the block (e.g. "REST · decision_log"). */
  caption?: ReactNode;
}

const CURL_PRE_STYLE = {
  background: 'var(--paper-3)',
  padding: '10px',
  borderRadius: '4px',
  fontSize: '11px',
  margin: 0,
  overflow: 'auto' as const,
  whiteSpace: 'pre' as const,
};

/**
 * Renders a copy-paste curl snippet with a Copy button. The block itself is
 * scrollable horizontally so long predicates don't blow out the drawer.
 */
export function CurlBlock({ value, caption }: CurlBlockProps) {
  const onCopy = useCallback(() => {
    try {
      navigator.clipboard?.writeText(value);
      pushToast('Copied curl', 'good');
    } catch {
      pushToast('Clipboard blocked', 'warn');
    }
  }, [value]);
  return (
    <div data-testid="curl-block" style={{ marginTop: '8px' }}>
      {caption ? <h4 className="eyebrow">{caption}</h4> : null}
      <pre className="mono" aria-label="curl command" style={CURL_PRE_STYLE}>
        {value}
      </pre>
      <div style={{ display: 'flex', justifyContent: 'flex-end', marginTop: '4px' }}>
        <button
          type="button"
          className="btn btn--sm btn--ghost"
          onClick={onCopy}
          aria-label="Copy curl"
        >
          Copy
        </button>
      </div>
    </div>
  );
}

// (Hooks live in `./_hooks` — see useUpdateSearch / useInsightsSearch.)
