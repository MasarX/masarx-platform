// decisionTrail.tsx — Universal decision-trail drawer body. Ports `openDecisionTrail`
// from demo-v2/assets/js/components.js (lines 455–490). The demo's imperative
// `openDrawer({title, body})` is replaced here by a pure React component that
// renders the trail body. Consumers are expected to feed it into a `useDrawer()`
// hook (or any drawer/modal surface) — see DataTable.tsx for the wiring pattern.
//
// Two surfaces are exported:
//   1. <DecisionTrailBody row entityKind /> — the table body fragment, no chrome.
//   2. <DecisionTrailDrawer row entityKind onClose /> — body + a lightweight
//      drawer chrome (title + close), used as a fallback when no useDrawer hook
//      is available.
//   3. buildDecisionTrailDrawerSpec(row, entityKind) — returns
//      { title, size, body } shaped to feed `useDrawer().open(...)` directly.
import type { ReactNode } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Chip, type ChipKind } from '@/components/Chip';
import { ScopePill } from '@/components/ScopePill';
import { Drawer } from '@/components/Drawer';
import { Spinner } from '@/components/Spinner';
import * as api from '@/lib/api';
import { lookupRow } from '@/lib/api';
import { useResolveSettings } from '@/lib/queries';
import type { DecisionLogEntry } from '@/types/domain';
import type { ScopeType } from '@/types/domain';

export interface DecisionTrailEntry {
  ts: string;
  cat: string;
  verdict: string;
  resolved_from: string;
  srlv: string;
  detail: string;
}

export interface DecisionTrailRowShape {
  id?: string | number;
  _key?: string | number;
  [k: string]: unknown;
}

// Map a canonical decision_log row → the trail-row shape we render.
// When the real backend lands, this just consumes whatever ui_get_decision_trail_v1
// returns; the row shape is stable.
//
// SCHEMA-DRIFT NOTE (Wave 11 / W11-5 — see __audit__/SCHEMA-DRIFT/INSIGHTS.md §6):
//   • `timestamp` is the canonical `decision_log.timestamp` column (renamed
//     from FE-side `occurred_at`).
//   • `resolved_from` is NOT a direct column; it is projected from
//     `settings_resolution_log.winning_scope_type` via the canonical join.
type DecisionTrailRow = DecisionLogEntry & {
  detail?: string;
  verdict?: string;
  ts?: string;
  resolved_from?: string;
};

const DISPLAY_REFERENCE_KEYS = [
  'tracking_number',
  'awb',
  'order_number',
  'client_reference_number',
  'carrier_reference_number',
  'reference_number',
  'reference',
  'display_name',
  'name',
  'title',
  'email',
  'slug',
  'code',
  'key',
  'label',
];

function formatEntityKind(entityKind?: string): string {
  return String(entityKind || 'record').replace(/[_-]+/g, ' ');
}

function humanizeDecisionToken(value: unknown, fallback = 'Decision'): string {
  if (typeof value !== 'string' || !value.trim()) return fallback;
  return value
    .trim()
    .replace(/[_-]+/g, ' ')
    .replace(/\s+/g, ' ')
    .replace(/\b\w/g, (match) => match.toUpperCase());
}

function displayReferenceForDecisionRow(row: DecisionTrailRowShape, entityKind?: string): string {
  for (const key of DISPLAY_REFERENCE_KEYS) {
    const value = row[key];
    if (typeof value === 'string' && value.trim()) return value.trim();
    if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  }
  return `selected ${formatEntityKind(entityKind)}`;
}

function decisionToEntry(d: DecisionTrailRow): DecisionTrailEntry {
  const ts = (d.timestamp as string | undefined) ?? d.ts ?? '';
  return {
    ts: ts.slice(11, 19) || ts,
    cat: humanizeDecisionToken(d.decision_category, 'Decision'),
    // W74 closure (Cycle F-R-14 P1-8) — drop the literal `?? 'allowed'` fallback.
    // A missing verdict is now surfaced as an empty string so the chip resolver
    // (`verdictKind` below) can render the canonical missing-verdict chip via
    // the `decision_verdict._default` row instead of silently masking the gap
    // with a positive default. AGENTS.md §2 (ZERO HARDCODING) + §6 (row-driven).
    verdict: d.verdict ? String(d.verdict) : '',
    resolved_from: String(d.resolved_from ?? 'global'),
    srlv: String(d.settings_resolution_id ?? ''),
    detail: String(
      d.detail ??
      `${humanizeDecisionToken(d.decision_category)} decision for ${humanizeDecisionToken(d.resource_type, 'selected record')}`,
    ),
  };
}

// Live decision-trail loader — filters api.listDecisionLog to entries that
// reference the row's id (or limits to the most recent 10 if no id match).
//
// W78 (Cross-cutting Cycle F-R-18 P2) — react-query `staleTime` budget
// resolves canonically from
// `ui_presentation_policy.decision_trail_stale_ms` via the settings ladder.
// Replaces the inline `staleTime: 15_000` literal so cache freshness is
// row-driven (AGENTS.md §2 ZERO HARDCODING + §4 SSOT + §6 row-driven
// config). Missing canonical row → `staleTime: 0` (no caching) so the gap
// surfaces fail-loud instead of masking unseeded environments with a
// fabricated 15s default.
const DECISION_TRAIL_LINK_KEYS = [
  'id',
  '_key',
  'decision_log_id',
  'resource_id',
  'settlement_batch_id',
  'subject_id',
  'workflow_run_id',
  'task_id',
];

function collectDecisionTrailIdentifiers(row: DecisionTrailRowShape): Set<string> {
  const ids = new Set<string>();
  for (const key of DECISION_TRAIL_LINK_KEYS) {
    const value = row[key];
    if (typeof value === 'string' && value.trim()) ids.add(value.trim());
    if (typeof value === 'number' && Number.isFinite(value)) ids.add(String(value));
  }
  return ids;
}

function uniqueDecisionRows(rows: DecisionTrailRow[]): DecisionTrailRow[] {
  const seen = new Set<string>();
  const out: DecisionTrailRow[] = [];
  for (const row of rows) {
    const key = String(row.id ?? `${row.resource_type ?? ''}:${row.resource_id ?? ''}:${row.timestamp ?? ''}`);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(row);
  }
  return out;
}

function useDecisionTrail(row: DecisionTrailRowShape) {
  const candidateIds = collectDecisionTrailIdentifiers(row);
  const policy = useResolveSettings('ui_presentation_policy', undefined);
  const policyValue = policy.data?.value as
    | { decision_trail_stale_ms?: number }
    | undefined;
  const staleMs =
    typeof policyValue?.decision_trail_stale_ms === 'number'
      ? policyValue.decision_trail_stale_ms
      : 0;
  return useQuery({
    queryKey: ['decision_trail', [...candidateIds].sort().join('|')],
    queryFn: async () => {
      const targeted = candidateIds.size
        ? await Promise.all(
            [...candidateIds].flatMap((id) => [
              api.listDecisionLog({ id, limit: 10 }),
              api.listDecisionLog({ resource_id: id, limit: 10 }),
            ]),
          )
        : [];
      const matched = uniqueDecisionRows(targeted.flat() as DecisionTrailRow[]);
      const fallback = matched.length ? [] : await api.listDecisionLog({ limit: 50 });
      const slice = (matched.length ? matched : (fallback as DecisionTrailRow[])).slice(0, 10);
      return slice.map(decisionToEntry);
    },
    staleTime: staleMs,
  });
}

// W74 closure (Cycle F-R-14 P1-7) — row-driven verdict tone resolution.
// Replaces the inline `v === 'allowed' || v === 'pass' || v === 'matched'`
// triple-OR ternary with a canonical `decision_verdict` lookup (rows defined
// in `lib/seed-raw/lookups.js`). Each row carries its own canonical `tone`
// (chip palette) and `metadata.is_positive` flag so consumers resolve via
// SSOT instead of a hardcoded allowlist of verdict spellings.
//
// Strict no-fallback: a verdict outside the canonical set returns `'neutral'`
// so the operator sees the gap (the `_default` row carries `'neutral'`) rather
// than being silently coerced to `warn` by a literal else-branch.
// AGENTS.md §2 (ZERO HARDCODING) + §4 (SSOT) + §6 (row-driven by configuration).
function verdictKind(v: string): ChipKind {
  const tone = lookupRow('decision_verdict', v)?.tone as ChipKind | undefined;
  return tone ?? 'neutral';
}

export interface DecisionTrailBodyProps {
  row: DecisionTrailRowShape;
  entityKind?: string;
  entries?: DecisionTrailEntry[];
}

export function DecisionTrailBody({ row, entityKind, entries }: DecisionTrailBodyProps): ReactNode {
  const label = displayReferenceForDecisionRow(row, entityKind);
  const live = useDecisionTrail(row);
  const data = entries ?? live.data ?? [];
  if (!entries && live.isLoading) {
    return (
      <div style={{ display: 'flex', alignItems: 'center', gap: '8px', padding: '14px' }}>
        <Spinner size={12} />
        <span className="state__hint">Loading decision and settings evidence…</span>
      </div>
    );
  }
  return (
    <div>
      <div className="state__hint">
        Decisions, settings resolutions, and audit entries for {label}
      </div>
      <table className="dt__table">
        <thead>
          <tr>
            <th>Time</th>
            <th>Category</th>
            <th>Verdict</th>
            <th>Resolved from</th>
            <th>Detail</th>
            <th>Settings</th>
          </tr>
        </thead>
        <tbody>
          {data.map((e, i) => (
            <tr key={`${e.srlv}-${i}`}>
              <td className="mono">{e.ts}</td>
              <td>
                <Chip label={e.cat} kind="info" size="xs" />
              </td>
              <td>
                <Chip label={e.verdict} kind={verdictKind(e.verdict)} size="xs" />
              </td>
              <td>
                <ScopePill scopeType={e.resolved_from as ScopeType} />
              </td>
              <td className="mono" style={{ fontSize: '11px' }}>
                {e.detail}
              </td>
              <td className="mono" style={{ fontSize: '11px', color: 'var(--ink-3)' }}>
                {e.srlv ? 'Resolved' : 'Not recorded'}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export interface DecisionTrailDrawerProps {
  row: DecisionTrailRowShape;
  entityKind?: string;
  entries?: DecisionTrailEntry[];
  onClose: () => void;
}

// Standalone drawer used when the consumer does not pipe through useDrawer().
// Renders the canonical Drawer in the open state — backdrop / Esc / close
// behavior comes for free.
export function DecisionTrailDrawer({
  row,
  entityKind,
  entries,
  onClose,
}: DecisionTrailDrawerProps) {
  const label = displayReferenceForDecisionRow(row, entityKind);
  return (
    <Drawer open={true} title={`Decision trail · ${label}`} size="lg" onClose={onClose}>
      <DecisionTrailBody row={row} entityKind={entityKind} entries={entries} />
    </Drawer>
  );
}

// Spec builder — drops directly into useDrawer().open({...}). The body is a
// React node, so consumers don't need to know about the drawer chrome.
export interface DrawerSpec {
  title: string;
  size: 'sm' | 'md' | 'lg';
  body: ReactNode;
}

export function buildDecisionTrailDrawerSpec(
  row: DecisionTrailRowShape,
  entityKind?: string,
  entries?: DecisionTrailEntry[]
): DrawerSpec {
  const label = displayReferenceForDecisionRow(row, entityKind);
  return {
    title: `Decision trail · ${label}`,
    size: 'lg',
    body: <DecisionTrailBody row={row} entityKind={entityKind} entries={entries} />,
  };
}
