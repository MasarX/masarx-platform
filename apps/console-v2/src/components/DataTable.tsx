// DataTable.tsx — TypeScript/React port of the Notion-class table from
// demo-v2/assets/js/components.js (lines ~474–1126: `dataTable(opts)` plus
// helpers `loadStash`, `saveStash`, `chipFromLookup`, `openDecisionTrail`,
// `exportSelectionCsv`).
//
// Behavior parity targets (what makes this Notion-class):
//   1. Single-row toolbar: view chip + tab strip + search + icon actions
//      (filter / sort / group / columns / density / export / save) +
//      filtered-count.
//   2. Multi-view stash in localStorage (key `demo-v2.view.{viewKey}`),
//      identical schema to the demo: { activeViewId, views: { [id]: { … } } }.
//   3. Inline cell editing on dbl-click for text/number/date/boolean and
//      via reference picker for `lookup` / `reference` columns.
//   4. Per-column filters with operators eq/neq/in/contains/gte/lte/gt/lt/
//      empty/not_empty.
//   5. Single-column sort, click header toggles direction.
//   6. Group-by with sticky group header showing collapse arrow + checkbox +
//      count + sum/avg/count cycle pill + group ⋯ menu.
//   7. Selection with sticky bulk action bar (≥1 selected). Bulk +
//      universal-default actions ("Export selected", "Copy references").
//   8. Padding-row windowing when ≥100 rows (ROW_H = 30).
//   9. Universal default row actions: Open / Open in new tab /
//      Copy reference / Decision trail.
//  10. CSV export (visible cols, processed rows).
//  11. Built-in search across `searchKeys` (or all non-lookup string cols).
//  12. Lookup chips when `col.lookup` is set, tones from data/lookups.
//
// Imperative overlays from the demo (`openDrawer`, `openModal`, `openPalette`,
// `openReferencePicker`) are replaced by React-native overlay hooks
// (useDrawer / useModal / usePalette). Each table instance owns its overlays
// and renders the overlay nodes inside its wrapper.

import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type ReactNode,
} from 'react';
import * as api from '@/lib/api';
import { useI18n } from '@/lib/i18n';
import { Icon } from '@/components/Icon';
import { Chip } from '@/components/Chip';
import { StateView } from '@/components/StateView';
import { buildDecisionTrailDrawerSpec, DecisionTrailDrawer } from '@/components/decisionTrail';
import { normalizeConsoleHref } from '@/lib/legacy-hash-navigation';
import { formatCapabilityTitle } from '@/lib/capabilities';

// ---------- Optional collaborator imports ----------
// These collaborators are owned by sibling tasks. We import permissively so
// the table degrades gracefully if a primitive isn't ready: missing modules
// fall back to inline implementations.
//
// `useDrawer / useModal / usePalette` come from a single overlay hook bundle.
// `pushToast` writes to a global toast store.
// `ScopePill / StateView` are visual primitives.

import {
  useDrawer as useDrawerImpl,
  usePalette as usePaletteImpl,
} from '@/hooks/useOverlay';
import { useIdentity } from '@/lib/identity';
import type { PaletteItem as CanonicalPaletteItem } from '@/components/Palette';
import { pushToast } from '@/components/toastStore';

// ---------- Types ----------

export type DataTableColumnType =
  | 'text'
  | 'number'
  | 'date'
  | 'datetime'
  | 'currency'
  | 'select'
  | 'reference'
  | 'boolean'
  | 'tags';

export type DataTableColumnFormat = 'currency' | 'percent' | 'datetime' | 'date' | 'ms';

export interface DataTableReference<TItem = Record<string, unknown>> {
  items: TItem[];
  display: (r: TItem) => string;
  value: (r: TItem) => unknown;
  sub?: (r: TItem) => string;
  section?: string;
}

export interface DataTableColumn<T = Record<string, unknown>> {
  key: string;
  label: string;
  type?: DataTableColumnType;
  lookup?: string;
  reference?: DataTableReference;
  filterable?: boolean;
  sortable?: boolean;
  editable?: boolean;
  mono?: boolean;
  align?: 'left' | 'right' | 'center';
  format?: DataTableColumnFormat;
  width?: string;
  hidden?: boolean;
  // Optional renderer override per column. The built-in formatters /
  // formatters[col.key] precedence match the demo behavior.
  render?: (raw: unknown, row: T) => ReactNode;
}

export interface DataTableAction<T = Record<string, unknown>> {
  label: string;
  icon?: string;
  capability?: string;
  capabilities?: string[];
  kind?: 'primary' | 'danger' | 'ghost';
  meta?: string;
  hidden?: boolean | ((row: T) => boolean);
  disabled?: boolean | ((row: T) => boolean);
  disabledReason?: string | ((row: T) => string | undefined);
  onClick: (row: T) => void;
}

export interface DataTableBulkAction<T = Record<string, unknown>> {
  label: string;
  icon?: string;
  capability?: string;
  capabilities?: string[];
  kind?: 'primary' | 'danger' | 'ghost';
  disabled?: boolean | ((rows: T[]) => boolean);
  disabledReason?: string | ((rows: T[]) => string | undefined);
  onClick: (rows: T[]) => void;
}

export interface DataTableGroupAction<T = Record<string, unknown>> {
  label: string;
  icon?: string;
  meta?: string;
  onClick: (rowsInGroup: T[], groupKey: unknown) => void;
}

export interface DataTableProps<T extends Record<string, unknown> = Record<string, unknown>> {
  columns: Array<DataTableColumn<T>>;
  rows: T[];
  formatters?: Record<string, (raw: unknown, row: T) => ReactNode>;
  onRowClick?: (row: T) => void;
  getRowClass?: (row: T) => string | undefined;
  onCellEdit?: (
    row: T,
    key: string,
    newValue: unknown,
    dryRun: boolean
  ) => Promise<{ ok: boolean; diff?: unknown; error?: string }>;
  bulkActions?: Array<DataTableBulkAction<T>>;
  rowActions?: Array<DataTableAction<T>>;
  groupActions?: Array<DataTableGroupAction<T>>;
  allowSelection?: boolean;
  emptyText?: string;
  viewKey?: string;
  defaultView?: ViewSnapshot;
  virtualize?: boolean;
  searchKeys?: string[];
  entityKind?: string;
  rowDeepLink?: (row: T) => string;
}

// ---------- View stash shape (mirrors the demo localStorage schema) ----------

interface ViewSnapshot {
  name?: string;
  sort?: string | null;
  sortDir?: 'asc' | 'desc';
  filters?: Record<string, FilterValue>;
  groupBy?: string | null;
  density?: DensityMode | null;
  groupAggMode?: GroupAggMode;
  cols?: Record<string, { hidden?: boolean }>;
}

interface ViewStash {
  activeViewId?: string;
  views?: Record<string, ViewSnapshot>;
}

type FilterOp = 'eq' | 'neq' | 'in' | 'contains' | 'gte' | 'lte' | 'gt' | 'lt' | 'empty' | 'not_empty';
interface FilterValue {
  op?: FilterOp;
  value: unknown;
}

type DensityMode = 'compact' | 'comfortable' | 'cozy';
type GroupAggMode = 'count' | 'sum' | 'avg';

// ---------- LocalStorage stash helpers (port of loadStash/saveStash) ----------

function viewStorageKey(key?: string): string {
  return `demo-v2.view.${key ?? ''}`;
}

function loadStash(key?: string): ViewStash {
  if (!key) return { views: { default: { name: 'Default' } }, activeViewId: 'default' };
  try {
    const raw = JSON.parse(localStorage.getItem(viewStorageKey(key)) || 'null');
    if (raw?.views) return raw as ViewStash;
    // Migrate single-view legacy shape (sort/filters/cols at root)
    if (raw && (raw.sort || raw.filters || raw.cols)) {
      return {
        activeViewId: 'default',
        views: { default: { name: 'Default', ...(raw as ViewSnapshot) } },
      };
    }
  } catch {
    /* ignore */
  }
  return { views: { default: { name: 'Default' } }, activeViewId: 'default' };
}

function saveStash(key: string | undefined, value: ViewStash): void {
  if (!key) return;
  try {
    localStorage.setItem(viewStorageKey(key), JSON.stringify(value));
  } catch {
    /* ignore */
  }
}

function reconcileColumnDefinitions<T>(
  current: Array<DataTableColumn<T>>,
  next: Array<DataTableColumn<T>>
): Array<DataTableColumn<T>> {
  const nextByKey = new Map(next.map((column) => [column.key, column]));
  const currentByKey = new Map(current.map((column) => [column.key, column]));
  const reconciled: Array<DataTableColumn<T>> = current
    .filter((column) => nextByKey.has(column.key))
    .map((column) => {
      const latest = nextByKey.get(column.key)!;
      return { ...latest, hidden: column.hidden ?? latest.hidden };
    });

  for (const column of next) {
    if (!currentByKey.has(column.key)) {
      reconciled.push({ ...column });
    }
  }

  return reconciled;
}

// ---------- Lookup helpers (strict; mirror data/lookups.js#lookupRow) -----
//
// AGENTS.md §2 (ZERO HARDCODING) + §4 (SSOT): tone/label come ONLY from
// the canonical lookup_values row. A missing (category, value) pair is
// surfaced as a danger-toned chip so the gap is visible rather than
// silently neutralized — fallbacks would mask the seed/category bug.

interface LookupEntry {
  value: unknown;
  label: string;
  tone?: string;
  rank?: number;
}

function getLookupRow(category: string, value: unknown): LookupEntry | null {
  try {
    const list = (api.getLookups(category) as LookupEntry[]) || [];
    return list.find((r) => r.value === value) ?? null;
  } catch {
    return null;
  }
}

function isInteractiveRowTarget(target: HTMLElement): boolean {
  if (target.closest('input,button,a,select,textarea,.dt-row-actions')) return true;

  const cell = target.closest('td');
  if (!cell) return false;

  return !!cell.querySelector('input,button,a,select,textarea,[role="button"],[role="link"]');
}

// Convert a snake_case / dotted lookup value into an operator-friendly Title
// Case label so a missing canonical row still renders something readable
// (e.g. `task_status/completed` -> `Completed`, `workflow_run_status/failed`
// -> `Failed`). Engineers debugging the gap still see the full canonical
// `<category>/<value>` path in the chip's title attribute.
function humanizeLookupValue(value: unknown): string {
  const raw = String(value ?? '').trim();
  if (!raw) return '—';
  return raw
    .replace(/[._-]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/\b\w/g, (m) => m.toUpperCase());
}

function ChipFromLookup({ category, value }: { category: string; value: unknown }): ReactNode {
  if (value == null) return <span className="mono">—</span>;
  const row = getLookupRow(category, value);
  if (!row) {
    // Loud-on-missing: render a danger-toned chip with an operator-friendly
    // humanized label, and put the canonical `<category>/<value>` in the
    // title attribute so engineers debugging the gap can still see the
    // exact missing lookup row.
    return (
      <Chip
        label={humanizeLookupValue(value)}
        kind="danger"
        size="xs"
        title={`Lookup row missing: ${category}/${String(value)}`}
      />
    );
  }
  const tone = (row.tone as
    | 'good'
    | 'warn'
    | 'danger'
    | 'info'
    | 'neutral'
    | 'ink'
    | undefined) ?? 'neutral';
  return <Chip label={row.label} kind={tone} size="xs" />;
}

// ---------- CSV export helpers (port of exportSelectionCsv + table exportCsv) ----------

function csvCell(v: unknown): string {
  if (v == null) return '';
  const s = String(v);
  if (s.includes(',') || s.includes('"') || s.includes('\n')) {
    return `"${s.replace(/"/g, '""')}"`;
  }
  return s;
}

function downloadCsv(filename: string, csv: string): void {
  const blob = new Blob([csv], { type: 'text/csv;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

function exportSelectionCsv<T extends Record<string, unknown>>(
  rows: T[],
  cols: Array<DataTableColumn<T>>
): void {
  if (!rows.length) return;
  const visible = cols.filter((c) => !c.hidden);
  const head = visible.map((c) => c.label).join(',');
  const lines = rows.map((r) => visible.map((c) => csvCell(r[c.key])).join(','));
  const csv = [head, ...lines].join('\n');
  downloadCsv(`selection-${Date.now()}.csv`, csv);
  pushToast(`Exported ${rows.length} rows`, 'good');
}

// ---------- Palette item shape (re-uses canonical Palette type so any
// extra fields like `value` / `disabled` flow through unchanged). ----------

type PaletteItem = CanonicalPaletteItem;

// ---------- Component ----------

const ROW_H = 30;
const VIRTUALIZE_THRESHOLD = 100;

export function DataTable<T extends Record<string, unknown> = Record<string, unknown>>(
  props: DataTableProps<T>
) {
  const {
    columns: cols0,
    rows: rows0,
    formatters = {},
    onRowClick,
    getRowClass,
    onCellEdit,
    bulkActions: bulkActions0 = [],
    rowActions: rowActions0 = [],
    groupActions = [],
    allowSelection = true,
    emptyText,
    viewKey,
    defaultView,
    virtualize = true,
    searchKeys,
    entityKind,
    rowDeepLink,
  } = props;

  const { fmtCurrency, fmtDateTime, fmtNumber } = useI18n();
  const { hasCapability } = useIdentity();

  function requiredCapabilities(action: { capability?: string; capabilities?: string[] }): string[] {
    return Array.from(new Set([action.capability, ...(action.capabilities ?? [])].filter(Boolean) as string[]));
  }

  function missingPermissionLabel(missing: string[]): string | undefined {
    if (!missing.length) return undefined;
    return missing.map(formatCapabilityTitle).join(' and ');
  }

  // ---------- Per-instance overlays ----------
  const drawer = useDrawerImpl();
  const palette = usePaletteImpl();

  // ---------- State init from stash (one-time) ----------
  const initialStash = useMemo<ViewStash>(() => loadStash(viewKey), [viewKey]);
  const initialActiveViewId = initialStash.activeViewId || 'default';
  const initialView: ViewSnapshot =
    initialStash.views?.[initialActiveViewId] ?? defaultView ?? {};

  const [activeViewId, setActiveViewId] = useState<string>(initialActiveViewId);
  const [columns, setColumns] = useState<Array<DataTableColumn<T>>>(() =>
    cols0.map((c) => ({ ...c, hidden: initialView.cols?.[c.key]?.hidden ?? c.hidden }))
  );
  const columnSchemaKey = useMemo(() => cols0.map((c) => c.key).join('\u001f'), [cols0]);
  const latestColumnByKey = useMemo(() => new Map(cols0.map((c) => [c.key, c])), [cols0]);
  const resolveColumn = useCallback(
    (column: DataTableColumn<T>): DataTableColumn<T> => {
      const latest = latestColumnByKey.get(column.key);
      if (!latest) return column;
      return { ...latest, hidden: column.hidden };
    },
    [latestColumnByKey],
  );
  const [rows, setRows] = useState<T[]>(rows0);
  const [sort, setSort] = useState<string | null>(initialView.sort ?? null);
  const [sortDir, setSortDir] = useState<'asc' | 'desc'>(initialView.sortDir ?? 'asc');
  const [filters, setFilters] = useState<Record<string, FilterValue>>(initialView.filters || {});
  const [groupBy, setGroupBy] = useState<string | null>(initialView.groupBy ?? null);
  const [density, setDensity] = useState<DensityMode | null>(initialView.density ?? null);
  const [groupAggMode, setGroupAggMode] = useState<GroupAggMode>(
    initialView.groupAggMode ?? 'count'
  );
  const [searchQuery, setSearchQuery] = useState<string>('');
  const [selected, setSelected] = useState<Set<string>>(() => new Set());
  const [collapsedGroups, setCollapsedGroups] = useState<Set<string>>(() => new Set());
  const [scrollTop, setScrollTop] = useState<number>(0);

  // Inline-edit state. `editing` keys the cell currently in input mode.
  const [editing, setEditing] = useState<{ rowKey: string; colKey: string } | null>(null);
  // Standalone fallback drawer for decision-trail when useDrawer hook isn't wired.
  const [dtRow, setDtRow] = useState<T | null>(null);

  // Keep `rows` in sync when caller-supplied rows change identity.
  useEffect(() => {
    setRows(rows0);
  }, [rows0]);

  useEffect(() => {
    setColumns((prev) => reconcileColumnDefinitions(prev, cols0));
    // Intentionally keyed by column identity only: renderers/labels resolve
    // through latestColumnByKey, while visibility/order live in table state.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [columnSchemaKey]);

  // ---------- Refs ----------
  const wrapRef = useRef<HTMLDivElement | null>(null);
  const tableHostRef = useRef<HTMLDivElement | null>(null);

  // ---------- Persist current state to active view ----------
  const persist = useCallback(() => {
    if (!viewKey) return;
    const cur = loadStash(viewKey);
    cur.activeViewId = activeViewId;
    cur.views = cur.views || { default: { name: 'Default' } };
    cur.views[activeViewId] = {
      ...(cur.views[activeViewId] || { name: 'Default' }),
      sort,
      sortDir,
      filters,
      groupBy,
      density,
      groupAggMode,
      cols: Object.fromEntries(columns.map((c) => [c.key, { hidden: !!c.hidden }])),
    };
    saveStash(viewKey, cur);
  }, [viewKey, activeViewId, sort, sortDir, filters, groupBy, density, groupAggMode, columns]);

  // Auto-persist on any tracked piece of state changing.
  useEffect(() => {
    persist();
  }, [persist]);

  // ---------- View management helpers ----------
  const getViews = useCallback((): Record<string, ViewSnapshot> => {
    return loadStash(viewKey).views || { default: { name: 'Default' } };
  }, [viewKey]);

  const getActiveView = useCallback((): ViewSnapshot => {
    return getViews()[activeViewId] || { name: 'Default' };
  }, [getViews, activeViewId]);

  const applyView = useCallback(
    (viewId: string) => {
      const v = getViews()[viewId];
      if (!v) return;
      setActiveViewId(viewId);
      setSort(v.sort ?? null);
      setSortDir(v.sortDir ?? 'asc');
      setFilters(v.filters || {});
      setGroupBy(v.groupBy ?? null);
      setDensity(v.density ?? null);
      setGroupAggMode(v.groupAggMode ?? 'count');
      setColumns(cols0.map((c) => ({ ...c, hidden: v.cols?.[c.key]?.hidden ?? c.hidden })));
    },
    [cols0, getViews]
  );

  const createView = useCallback(
    (name: string) => {
      const id = 'v_' + Date.now();
      const cur = loadStash(viewKey);
      cur.views = cur.views || { default: { name: 'Default' } };
      cur.views[id] = {
        name,
        sort,
        sortDir,
        filters: { ...filters },
        groupBy,
        density,
        groupAggMode,
        cols: Object.fromEntries(columns.map((c) => [c.key, { hidden: !!c.hidden }])),
      };
      cur.activeViewId = id;
      saveStash(viewKey, cur);
      setActiveViewId(id);
    },
    [viewKey, sort, sortDir, filters, groupBy, density, groupAggMode, columns]
  );

  const renameView = useCallback(
    (viewId: string, name: string) => {
      const cur = loadStash(viewKey);
      if (cur.views?.[viewId]) {
        cur.views[viewId].name = name;
        saveStash(viewKey, cur);
        // Force re-render: bump active id assignment to itself triggers persistence cycle.
        setActiveViewId((prev) => prev);
      }
    },
    [viewKey]
  );

  const deleteView = useCallback(
    (viewId: string) => {
      if (viewId === 'default') return;
      const cur = loadStash(viewKey);
      if (!cur.views) return;
      delete cur.views[viewId];
      if (activeViewId === viewId) {
        cur.activeViewId = 'default';
        saveStash(viewKey, cur);
        applyView('default');
      } else {
        saveStash(viewKey, cur);
        // Force re-render of view chip / tab strip.
        setActiveViewId((prev) => prev);
      }
    },
    [viewKey, activeViewId, applyView]
  );

  // ---------- Derived data ----------

  const visibleColumns = useCallback((): Array<DataTableColumn<T>> => {
    return columns.filter((c) => !c.hidden).map(resolveColumn);
  }, [columns, resolveColumn]);

  const rowKeyOf = useCallback((r: T, i: number): string => {
    const id = (r as { id?: unknown }).id ?? (r as { _key?: unknown })._key;
    return id != null ? String(id) : `_idx_${i}`;
  }, []);

  const applyFilters = useCallback(
    (input: T[]): T[] => {
      let out = input;
      for (const [k, f] of Object.entries(filters)) {
        if (!f || f.value == null || f.value === '') continue;
        const v = f.value;
        out = out.filter((r) => {
          const cell = (r as Record<string, unknown>)[k];
          if (f.op === 'eq' || !f.op) return String(cell ?? '') === String(v);
          if (f.op === 'neq') return String(cell ?? '') !== String(v);
          if (f.op === 'in')
            return Array.isArray(v)
              ? (v as unknown[]).includes(cell)
              : String(cell ?? '').includes(String(v));
          if (f.op === 'contains')
            return String(cell ?? '')
              .toLowerCase()
              .includes(String(v).toLowerCase());
          if (f.op === 'gte') return Number(cell) >= Number(v);
          if (f.op === 'lte') return Number(cell) <= Number(v);
          if (f.op === 'gt') return Number(cell) > Number(v);
          if (f.op === 'lt') return Number(cell) < Number(v);
          if (f.op === 'empty') return cell == null || cell === '';
          if (f.op === 'not_empty') return cell != null && cell !== '';
          return true;
        });
      }
      if (searchQuery) {
        const q = searchQuery.toLowerCase();
        const keys =
          searchKeys ||
          columns.filter((c) => !c.lookup).map((c) => c.key);
        out = out.filter((r) =>
          keys.some((k) =>
            String((r as Record<string, unknown>)[k] ?? '')
              .toLowerCase()
              .includes(q)
          )
        );
      }
      return out;
    },
    [filters, searchQuery, searchKeys, columns]
  );

  const applySort = useCallback(
    (input: T[]): T[] => {
      if (!sort) return input;
      const k = sort;
      const dir = sortDir === 'asc' ? 1 : -1;
      const out = [...input];
      out.sort((a, b) => {
        const av = (a as Record<string, unknown>)[k];
        const bv = (b as Record<string, unknown>)[k];
        if (av === bv) return 0;
        if (av == null) return 1;
        if (bv == null) return -1;
        return ((av as number | string) < (bv as number | string) ? -1 : 1) * dir;
      });
      return out;
    },
    [sort, sortDir]
  );

  const processed = useMemo<T[]>(
    () => applySort(applyFilters(rows)),
    [applySort, applyFilters, rows]
  );

  const displayReferenceForRow = useCallback((row: T): string | null => {
    const source = row as Record<string, unknown>;
    const keys = [
      'tracking_number',
      'tracking',
      'awb',
      'client_reference_number',
      'reference_number',
      'reference',
      'display_name',
      'provider_name',
      'name',
      'title',
      'email',
      'slug',
      'code',
      'key',
      'label',
      'provider_id',
      'operation_name',
    ];
    for (const key of keys) {
      const value = source[key];
      if (typeof value === 'string' && value.trim()) return value.trim();
      if (typeof value === 'number' && Number.isFinite(value)) return String(value);
    }
    return null;
  }, []);

  // ---------- Universal default actions (must be appended after caller's) ----------

  const universalRowActions = useMemo<Array<DataTableAction<T>>>(() => {
    const acts: Array<DataTableAction<T>> = [];
    if (onRowClick) {
      acts.push({ label: 'Open', icon: 'right', onClick: (r) => onRowClick(r) });
    }
    if (rowDeepLink) {
      acts.push({
        label: 'Open in new tab',
        icon: 'external',
        onClick: (r) => window.open(normalizeConsoleHref(rowDeepLink(r)), '_blank'),
      });
    }
    acts.push({
      label: 'Copy reference',
      icon: 'copy',
      onClick: (r) => {
        const reference = displayReferenceForRow(r);
        if (!reference) {
          pushToast('No display reference available for this row', 'warn');
          return;
        }
        navigator.clipboard?.writeText(reference);
        pushToast('Record reference copied', 'good');
      },
    });
    acts.push({
      label: 'Decision trail',
      icon: 'audit',
      onClick: (r) => {
        // Prefer the wired-up drawer hook; fall back to a standalone drawer.
        if (drawer && typeof drawer.open === 'function') {
          drawer.open(buildDecisionTrailDrawerSpec(r as Record<string, unknown>, entityKind));
        } else {
          setDtRow(r);
        }
      },
    });
    return acts;
  }, [onRowClick, rowDeepLink, drawer, entityKind, displayReferenceForRow]);

  const allRowActions = useMemo<Array<DataTableAction<T>>>(
    () => [...rowActions0, ...universalRowActions],
    [rowActions0, universalRowActions]
  );

  const universalBulkActions = useMemo<Array<DataTableBulkAction<T>>>(
    () => [
      {
        label: 'Export selected',
        icon: 'download',
        kind: 'ghost',
        onClick: (rs) => exportSelectionCsv(rs, columns),
      },
      {
        label: 'Copy references',
        icon: 'copy',
        kind: 'ghost',
        onClick: (rs) => {
          const references = rs.map((r) => displayReferenceForRow(r)).filter(Boolean);
          if (!references.length) {
            pushToast('No display references available for selected rows', 'warn');
            return;
          }
          navigator.clipboard?.writeText(references.join('\n'));
          pushToast(`Copied ${references.length} record references`, 'good');
        },
      },
    ],
    [columns, displayReferenceForRow]
  );

  const allBulkActions = useMemo<Array<DataTableBulkAction<T>>>(
    () => [...bulkActions0, ...universalBulkActions],
    [bulkActions0, universalBulkActions]
  );

  // ---------- Palette helpers ----------

  function openPaletteSafe(items: PaletteItem[], placeholder?: string) {
    if (palette && typeof palette.open === 'function') {
      palette.open({
        items,
        placeholder,
        onPick: (it: PaletteItem) => it.onPick?.(),
      });
    } else {
      // Fallback: linear prompt picker. Acceptable since the palette hook is
      // expected to ship in this same milestone.
      const labels = items.map((it, i) => `${i + 1}. ${it.label}`).join('\n');
      const choice = window.prompt(
        `${placeholder || 'Pick…'}\n${labels}\n\nEnter number:`
      );
      const idx = Number(choice) - 1;
      if (Number.isFinite(idx) && items[idx]) items[idx]!.onPick?.();
    }
  }

  // ---------- Toolbar menus ----------

  function openViewMenu() {
    const views = getViews();
    const items: PaletteItem[] = [
      ...Object.entries(views).map(([id, v]) => ({
        label: `${id === activeViewId ? '✓ ' : '  '}${v.name || id}`,
        key: id,
        section: 'Views',
        meta: id === 'default' ? '' : '⌫ del',
        onPick: () => applyView(id),
      })),
      {
        label: '＋ Create new view from current settings',
        key: '__new__',
        section: 'Manage',
        onPick: () => {
          const name = window.prompt(
            'Name this view:',
            `View ${Object.keys(views).length + 1}`
          );
          if (name) createView(name);
        },
      },
    ];
    if (activeViewId !== 'default') {
      items.push({
        label: '✎ Rename current view',
        key: '__rename__',
        section: 'Manage',
        onPick: () => {
          const name = window.prompt('New name:', getActiveView().name || '');
          if (name) renameView(activeViewId, name);
        },
      });
      items.push({
        label: '🗑 Delete current view',
        key: '__delete__',
        section: 'Manage',
        onPick: () => {
          if (window.confirm(`Delete "${getActiveView().name}"?`)) deleteView(activeViewId);
        },
      });
    }
    items.push({
      label: 'Reset all (filters + sort + group)',
      key: '__reset__',
      section: 'Reset',
      onPick: () => {
        setFilters({});
        setSort(null);
        setGroupBy(null);
        setColumns((prev) => prev.map((c) => ({ ...c, hidden: false })));
      },
    });
    openPaletteSafe(items, 'Switch / manage views…');
  }

  function openFilterMenu() {
    const filterable = columns.filter((c) => c.filterable !== false);
    const items: PaletteItem[] = filterable.map((c) => ({
      label: `Filter by ${c.label}`,
      key: c.key,
      section: 'Columns',
      onPick: () => promptFilter(c),
    }));
    openPaletteSafe(items, 'Filter…');
  }

  function promptFilter(col: DataTableColumn<T>) {
    const current = filters[col.key]?.value ?? '';
    if (col.lookup) {
      pickReference(col.label, { kind: 'lookup', category: col.lookup }, true, (val) => {
        if (val == null) {
          setFilters((prev) => {
            const next = { ...prev };
            delete next[col.key];
            return next;
          });
        } else {
          setFilters((prev) => ({ ...prev, [col.key]: { op: 'eq', value: val } }));
        }
      });
      return;
    }
    if (col.reference) {
      pickReference(col.label, { kind: 'reference', ...col.reference }, true, (val) => {
        if (val == null) {
          setFilters((prev) => {
            const next = { ...prev };
            delete next[col.key];
            return next;
          });
        } else {
          setFilters((prev) => ({ ...prev, [col.key]: { op: 'eq', value: val } }));
        }
      });
      return;
    }
    const v = window.prompt(`Filter ${col.label} contains:`, String(current ?? ''));
    if (v == null) return;
    if (!v) {
      setFilters((prev) => {
        const next = { ...prev };
        delete next[col.key];
        return next;
      });
    } else {
      setFilters((prev) => ({ ...prev, [col.key]: { op: 'contains', value: v } }));
    }
  }

  function openSortMenu() {
    const sortable = columns.filter((c) => c.sortable !== false);
    const items: PaletteItem[] = [
      ...sortable.map((c) => ({
        label: `${c.label} ↑`,
        key: `${c.key}:asc`,
        section: 'Ascending',
        onPick: () => {
          setSort(c.key);
          setSortDir('asc');
        },
      })),
      ...sortable.map((c) => ({
        label: `${c.label} ↓`,
        key: `${c.key}:desc`,
        section: 'Descending',
        onPick: () => {
          setSort(c.key);
          setSortDir('desc');
        },
      })),
      {
        label: 'Clear sort',
        key: 'clear',
        section: 'Reset',
        onPick: () => setSort(null),
      },
    ];
    openPaletteSafe(items, 'Sort…');
  }

  function openGroupMenu() {
    const items: PaletteItem[] = [
      {
        label: 'No grouping',
        key: 'none',
        section: 'Reset',
        onPick: () => setGroupBy(null),
      },
      ...columns
        .filter((c) => c.lookup || c.type === 'select')
        .map((c) => ({
          label: `Group by ${c.label}`,
          key: c.key,
          section: 'Columns',
          onPick: () => setGroupBy(c.key),
        })),
    ];
    openPaletteSafe(items, 'Group…');
  }

  function openColumnsMenu() {
    const items: PaletteItem[] = columns.map((c) => ({
      label: `${c.hidden ? '☐' : '☑'} ${c.label}`,
      key: c.key,
      section: 'Toggle visibility',
      onPick: () =>
        setColumns((prev) => prev.map((p) => (p.key === c.key ? { ...p, hidden: !p.hidden } : p))),
    }));
    openPaletteSafe(items, 'Columns…');
  }

  function openDensityMenu() {
    const items: PaletteItem[] = [
      {
        label: 'Compact',
        key: 'compact',
        section: 'Density',
        onPick: () => setDensity('compact'),
      },
      {
        label: 'Comfortable',
        key: 'comfortable',
        section: 'Density',
        onPick: () => setDensity('comfortable'),
      },
      { label: 'Cozy', key: 'cozy', section: 'Density', onPick: () => setDensity('cozy') },
      {
        label: 'Inherit (global)',
        key: 'inherit',
        section: 'Reset',
        onPick: () => setDensity(null),
      },
    ];
    openPaletteSafe(items, 'Density…');
  }

  function openRowContext(row: T) {
    const visibleRowActions = allRowActions.filter((a) =>
      !(typeof a.hidden === 'function' ? a.hidden(row) : Boolean(a.hidden))
    );
    const items: PaletteItem[] = visibleRowActions.map((a) => {
      const missing = requiredCapabilities(a).filter((capability) => !hasCapability(capability));
      const allowed = missing.length === 0;
      const actionDisabled =
        typeof a.disabled === 'function' ? a.disabled(row) : Boolean(a.disabled);
      const disabledReason =
        typeof a.disabledReason === 'function' ? a.disabledReason(row) : a.disabledReason;
      return {
        label: a.label,
        key: a.label,
        section: a.kind === 'danger' ? 'Danger' : 'Actions',
        meta: !allowed ? missingPermissionLabel(missing) : actionDisabled ? disabledReason ?? a.meta : a.meta,
        disabled: !allowed || actionDisabled,
        onPick: () => {
          if (!allowed || actionDisabled) return;
          a.onClick?.(row);
        },
      };
    });
    openPaletteSafe(items, 'Row actions…');
  }

  function openGroupActionsMenu(key: unknown, group: T[]) {
    const items: PaletteItem[] = [
      {
        label: `Select all in group (${group.length})`,
        key: 'sel-all',
        section: 'Selection',
        onPick: () => {
          setSelected((prev) => {
            const next = new Set(prev);
            group.forEach((r) => next.add(rowKeyOf(r, processed.indexOf(r))));
            return next;
          });
        },
      },
      {
        label: 'Clear selection in group',
        key: 'sel-none',
        section: 'Selection',
        onPick: () => {
          setSelected((prev) => {
            const next = new Set(prev);
            group.forEach((r) => next.delete(rowKeyOf(r, processed.indexOf(r))));
            return next;
          });
        },
      },
      {
        label: 'Collapse other groups',
        key: 'collapse-others',
        section: 'View',
        onPick: () => {
          if (!groupBy) return;
          const allKeys = Array.from(groupRows(processed, groupBy).keys());
          setCollapsedGroups(
            new Set(allKeys.filter((k) => String(k) !== String(key)).map(String))
          );
        },
      },
      {
        label: 'Expand all groups',
        key: 'expand-all',
        section: 'View',
        onPick: () => setCollapsedGroups(new Set()),
      },
      ...groupActions.map((a) => ({
        label: a.label,
        key: `ga-${a.label}`,
        section: 'Group actions',
        meta: a.meta,
        onPick: () => a.onClick?.(group, key),
      })),
    ];
    openPaletteSafe(items, 'Group actions…');
  }

  function pickReference(
    title: string,
    source:
      | { kind: 'lookup'; category: string }
      | ({ kind: 'reference' } & DataTableReference),
    allowClear: boolean,
    onPick: (val: unknown) => void
  ) {
    let items: PaletteItem[] = [];
    if (source.kind === 'lookup') {
      const list = (api.getLookups(source.category) as LookupEntry[]) || [];
      items = list.map((r) => ({
        label: r.label,
        key: r.value as string,
        meta: String(r.tone || r.rank || ''),
        section: source.category,
      }));
    } else {
      items = (source.items || []).map((r) => ({
        label: source.display(r),
        key: String(source.value(r) ?? ''),
        meta: source.sub?.(r),
        section: source.section || 'Items',
      }));
    }
    if (allowClear) {
      items.unshift({ label: '— clear —', key: null, section: 'Action' });
    }
    // Wrap onPick into a single closure so the palette can fire it with the chosen key.
    const wrapped: PaletteItem[] = items.map((it) => ({
      ...it,
      onPick: () => onPick(it.key),
    }));
    openPaletteSafe(wrapped, `Pick ${title || 'value'}…`);
  }

  // ---------- Inline editor commit ----------

  async function commitEdit(row: T, col: DataTableColumn<T>, newValue: unknown) {
    try {
      const res = await onCellEdit?.(row, col.key, newValue, false);
      if (res?.ok === false) {
        pushToast('Edit could not be saved. Try again.', 'danger');
        setEditing(null);
        return;
      }
      // Mutate local rows (caller is also expected to refresh via res.diff / rows).
      setRows((prev) => prev.map((r) => (r === row ? { ...r, [col.key]: newValue } : r)));
      pushToast(`Saved · ${col.label}`, 'good');
    } catch {
      pushToast('Edit could not be saved. Try again.', 'danger');
    } finally {
      setEditing(null);
    }
  }

  function startInlineEdit(col: DataTableColumn<T>, row: T) {
    if (!col.editable || !onCellEdit) return;
    if (col.lookup) {
      pickReference(col.label, { kind: 'lookup', category: col.lookup }, false, (val) =>
        commitEdit(row, col, val)
      );
      return;
    }
    if (col.reference) {
      pickReference(col.label, { kind: 'reference', ...col.reference }, false, (val) =>
        commitEdit(row, col, val)
      );
      return;
    }
    if (col.type === 'boolean') {
      commitEdit(row, col, !(row as Record<string, unknown>)[col.key]);
      return;
    }
    setEditing({ rowKey: rowKeyOf(row, processed.indexOf(row)), colKey: col.key });
  }

  // ---------- Cell rendering ----------

  function renderCellContent(c: DataTableColumn<T>, r: T): ReactNode {
    const raw = (r as Record<string, unknown>)[c.key];
    if (c.format === 'currency') {
      // AGENTS.md §2 (W30/G1): no ISO-code fallback. Per-row currency
      // sources strictly from the row's `cod_currency` / `currency`
      // field; missing ⇒ bare number (caller wraps the cell in
      // module-scoped tenant_currency context).
      const currency =
        ((r as Record<string, unknown>).cod_currency as string) ||
        ((r as Record<string, unknown>).currency as string) ||
        '';
      return fmtCurrency(Number(raw) || 0, currency);
    }
    if (c.format === 'percent') {
      return raw == null ? '—' : `${(Number(raw) * 100).toFixed(1)}%`;
    }
    if (c.format === 'datetime') {
      return raw == null || raw === '' || raw === 0 ? '—' : fmtDateTime(raw as string | number | Date);
    }
    if (c.format === 'date') {
      return raw ? fmtDateTime(raw as string | number | Date).split(',')[0] : '—';
    }
    if (c.format === 'ms') {
      return raw == null ? '—' : `${fmtNumber(Number(raw))}ms`;
    }
    if (c.render) return c.render(raw, r);
    if (formatters[c.key]) return formatters[c.key]!(raw, r);
    if (c.lookup) return <ChipFromLookup category={c.lookup} value={raw} />;
    if (c.type === 'boolean') return raw ? '✓' : '—';
    if (c.type === 'tags' && Array.isArray(raw)) {
      return (
        <span>
          {(raw as string[]).map((tt, i) => (
            <Chip key={`${tt}-${i}`} label={tt} kind="neutral" size="xs" />
          ))}
        </span>
      );
    }
    return raw == null ? '—' : String(raw);
  }

  function renderCell(c: DataTableColumn<T>, r: T, ri: number): ReactNode {
    const isEditableCell = !!(c.editable && onCellEdit);
    const isEditing =
      editing && editing.rowKey === rowKeyOf(r, ri) && editing.colKey === c.key;
    const cls = [
      c.align === 'right' ? 'cell-num' : '',
      c.mono ? 'mono' : '',
      isEditableCell ? 'is-editable' : '',
    ]
      .filter(Boolean)
      .join(' ');

    if (isEditing && c.type !== 'boolean' && !c.lookup && !c.reference) {
      return (
        <td
          key={c.key}
          className={cls || undefined}
          onDoubleClick={(e) => e.stopPropagation()}
        >
          <InlineInput
            type={c.type}
            initial={(r as Record<string, unknown>)[c.key]}
            onCommit={(value) => commitEdit(r, c, value)}
            onCancel={() => setEditing(null)}
          />
        </td>
      );
    }

    return (
      <td
        key={c.key}
        className={cls || undefined}
        title={isEditableCell ? 'Double-click to edit' : undefined}
        onDoubleClick={
          isEditableCell
            ? (e) => {
                e.stopPropagation();
                startInlineEdit(c, r);
              }
            : undefined
        }
      >
        {renderCellContent(c, r)}
      </td>
    );
  }

  // ---------- Group-by helpers ----------

  function groupRows(input: T[], key: string): Map<unknown, T[]> {
    const m = new Map<unknown, T[]>();
    input.forEach((r) => {
      const k = (r as Record<string, unknown>)[key] ?? '—';
      if (!m.has(k)) m.set(k, []);
      m.get(k)!.push(r);
    });
    return m;
  }

  function formatGroupKey(colKey: string, key: unknown): string {
    const col = columns.find((c) => c.key === colKey);
    if (col?.lookup) {
      const row = getLookupRow(col.lookup, key);
      // Loud-on-missing: surface the gap in the group header so the
      // operator can see the un-seeded value.
      return row?.label ?? `${col.lookup}/${String(key)} (missing)`;
    }
    return String(key);
  }

  function formatAgg(v: number, col: DataTableColumn<T>): string {
    // AGENTS.md §2 (W30/G1): no ISO-code fallback. Module-scoped
    // tenant_currency context wraps the table; aggregations render
    // bare numbers when no row-level currency is available.
    if (col.format === 'currency') return fmtCurrency(v, '');
    if (col.format === 'ms') return `${fmtNumber(Math.round(v))}ms`;
    return fmtNumber(typeof v === 'number' ? +v.toFixed(2) : v);
  }

  // ---------- CSV (full table) ----------

  function exportCsv() {
    const cols = visibleColumns();
    const head = cols.map((c) => c.label).join(',');
    const lines = processed.map((r) =>
      cols.map((c) => csvCell((r as Record<string, unknown>)[c.key])).join(',')
    );
    const csv = [head, ...lines].join('\n');
    downloadCsv(`${viewKey || 'table'}-${Date.now()}.csv`, csv);
    pushToast(`Exported ${processed.length} rows`, 'good');
  }

  function saveCurrentToView() {
    persist();
    pushToast(`Saved to "${getActiveView().name || 'Default'}"`, 'good');
  }

  // ---------- Scroll listener for virtualization ----------

  useEffect(() => {
    if (!virtualize || rows.length < VIRTUALIZE_THRESHOLD) return;
    const host = tableHostRef.current;
    if (!host) return;
    let ticking = false;
    const onScroll = () => {
      if (!ticking) {
        ticking = true;
        requestAnimationFrame(() => {
          setScrollTop(host.scrollTop);
          ticking = false;
        });
      }
    };
    host.addEventListener('scroll', onScroll);
    return () => host.removeEventListener('scroll', onScroll);
  }, [virtualize, rows.length]);

  // ---------- Render: toolbar ----------

  const filterCount = Object.keys(filters).length;
  const views = getViews();
  const view = getActiveView();
  const inlineViews = Object.entries(views).slice(0, 4);

  function renderToolbar(): ReactNode {
    const ibtn = (
      iconName: string,
      title: string,
      active: boolean,
      onClick: () => void,
      badge?: number | string | null
    ) => (
      <button
        type="button"
        className={`dt-tb-icon ${active ? 'is-active' : ''}`}
        title={title}
        aria-label={title}
        onClick={onClick}
      >
        <span>
          <Icon name={iconName} size={13} />
        </span>
        {badge ? <span className="dt-tb-icon__badge mono">{String(badge)}</span> : null}
      </button>
    );

    return (
      <div className="dt-toolbar">
        <button
          type="button"
          className="dt-tb-view"
          onClick={openViewMenu}
          title="Switch / manage views"
        >
          <span className="mono" style={{ fontWeight: 600 }}>
            {view.name || 'Default'}
          </span>
          <span className="dt-tb-view__count">· {Object.keys(views).length}</span>
          <span style={{ fontSize: '8px', opacity: 0.6 }}>▾</span>
        </button>
        {inlineViews.map(([id, v]) =>
          id === activeViewId ? null : (
            <button
              key={id}
              type="button"
              className="dt-tb-view-tab"
              onClick={() => applyView(id)}
              title={`Switch to "${v.name || id}"`}
            >
              {v.name || id}
            </button>
          )
        )}
        <div className="dt-tb-search">
          <span>
            <Icon name="search" size={12} />
          </span>
          <input
            type="text"
            placeholder="Search…"
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
          />
        </div>
        <div className="dt-tb-spacer" />
        {ibtn(
          'filter',
          filterCount ? `${filterCount} filters` : 'Filter',
          filterCount > 0,
          openFilterMenu,
          filterCount || null
        )}
        {ibtn(
          'list',
          sort ? `Sort · ${sort} ${sortDir === 'asc' ? '↑' : '↓'}` : 'Sort',
          !!sort,
          openSortMenu
        )}
        {ibtn(
          'layers',
          groupBy ? `Group by ${groupBy}` : 'Group',
          !!groupBy,
          openGroupMenu
        )}
        {ibtn(
          'grid',
          `Columns · ${visibleColumns().length}/${columns.length}`,
          false,
          openColumnsMenu
        )}
        {ibtn(
          'settings',
          `Density · ${density || 'inherit'}`,
          !!density,
          openDensityMenu
        )}
        <span className="dt-tb-divider" />
        {ibtn('download', 'Export CSV', false, exportCsv)}
        {ibtn('refresh', 'Save current settings to view', false, saveCurrentToView)}
        <span className="dt-tb-count mono">
          {processed.length}/{rows.length}
        </span>
      </div>
    );
  }

  // ---------- Render: filter chip row ----------

  function renderFilterRow(): ReactNode {
    const filterEntries = Object.entries(filters);
    const hasAny = filterEntries.length || sort || groupBy;
    if (!hasAny) return null;
    return (
      <div className="dt-filters" style={{ display: 'flex' }}>
        {filterEntries.map(([k, f]) => {
          const col = columns.find((c) => c.key === k);
          return (
            <span key={k} className="chip chip--info">
              <span>{`${col?.label || k}: `}</span>
              <span className="mono">{String(f.value)}</span>
              <button
                type="button"
                className="chip-clear"
                aria-label="Clear filter"
                onClick={() =>
                  setFilters((prev) => {
                    const next = { ...prev };
                    delete next[k];
                    return next;
                  })
                }
              >
                ×
              </button>
            </span>
          );
        })}
        {sort ? (
          <span className="chip">
            <span>{`Sort: ${sort} ${sortDir === 'asc' ? '↑' : '↓'}`}</span>
            <button
              type="button"
              className="chip-clear"
              aria-label="Clear sort"
              onClick={() => setSort(null)}
            >
              ×
            </button>
          </span>
        ) : null}
        {groupBy ? (
          <span className="chip">
            <span>{`Group: ${groupBy}`}</span>
            <button
              type="button"
              className="chip-clear"
              aria-label="Clear group"
              onClick={() => setGroupBy(null)}
            >
              ×
            </button>
          </span>
        ) : null}
      </div>
    );
  }

  // ---------- Render: bulk action bar ----------

  function renderBulkBar(): ReactNode {
    const count = selected.size;
    if (!count) return null;
    return (
      <div className="dt-bulkbar">
        <span className="mono" style={{ fontWeight: 600 }}>{`${count} selected`}</span>
        <div style={{ flex: 1 }} />
        {allBulkActions.map((a, i) => {
          const missing = requiredCapabilities(a).filter((capability) => !hasCapability(capability));
          const sel = processed.filter((r, idx) => selected.has(rowKeyOf(r, idx)));
          const disabledByAction = typeof a.disabled === 'function' ? a.disabled(sel) : Boolean(a.disabled);
          const actionDisabledReason = typeof a.disabledReason === 'function' ? a.disabledReason(sel) : a.disabledReason;
          const allowed = missing.length === 0;
          const disabled = !allowed || disabledByAction;
          const title = missingPermissionLabel(missing) || actionDisabledReason;
          return (
            <button
              key={`${a.label}-${i}`}
              type="button"
              className={`btn btn--sm ${
                a.kind === 'primary'
                  ? 'btn--primary'
                  : a.kind === 'danger'
                  ? 'btn--danger'
                  : 'btn--ghost'
              }`}
              disabled={disabled}
              aria-disabled={disabled || undefined}
              title={title}
              onClick={() => {
                if (disabled) return;
                a.onClick?.(sel);
              }}
            >
              {a.icon ? (
                <span>
                  <Icon name={a.icon} size={12} />
                </span>
              ) : null}
              <span>{a.label}</span>
            </button>
          );
        })}
        <button
          type="button"
          className="btn btn--sm btn--ghost"
          onClick={() => setSelected(new Set())}
        >
          Clear
        </button>
      </div>
    );
  }

  // ---------- Render: header ----------

  function renderHeader(): ReactNode {
    const cols = visibleColumns();
    const allChecked = selected.size > 0 && selected.size === processed.length;
    return (
      <thead>
        <tr>
          {allowSelection ? (
            <th className="dt-checkbox">
              <input
                type="checkbox"
                aria-label="Select all"
                checked={allChecked}
                onChange={(e) => {
                  if (e.target.checked) {
                    const next = new Set<string>();
                    processed.forEach((r, i) => next.add(rowKeyOf(r, i)));
                    setSelected(next);
                  } else {
                    setSelected(new Set());
                  }
                }}
              />
            </th>
          ) : null}
          {cols.map((c) => (
            <th
              key={c.key}
              className={c.align === 'right' ? 'cell-num' : undefined}
              style={c.width ? { width: c.width } : undefined}
              title={c.editable ? `${c.label} · double-click cells to edit` : c.label}
              onClick={
                c.sortable !== false
                  ? () => {
                      if (sort === c.key) {
                        setSortDir((d) => (d === 'asc' ? 'desc' : 'asc'));
                      } else {
                        setSort(c.key);
                        setSortDir('asc');
                      }
                    }
                  : undefined
              }
            >
              <span>{c.label}</span>
              {c.editable ? (
                <span className="dt-th-mark" title="editable">
                  {' ✎'}
                </span>
              ) : null}
              {sort === c.key ? (
                <span className="sort-mark">{sortDir === 'asc' ? '▲' : '▼'}</span>
              ) : null}
            </th>
          ))}
          {allRowActions.length ? (
            <th className="dt-th-actions" aria-label="Row actions" />
          ) : null}
        </tr>
      </thead>
    );
  }

  // ---------- Render: a single row ----------

  function renderRow(r: T, i: number, cols: Array<DataTableColumn<T>>): ReactNode {
    const k = rowKeyOf(r, i);
    const trClass = [getRowClass?.(r) || '', selected.has(k) ? 'is-selected' : '']
      .filter(Boolean)
      .join(' ');
    const canOpenRow = typeof onRowClick === 'function';
    const rowLabel = displayReferenceForRow(r) ?? k;
    return (
      <tr
        key={k}
        className={trClass || undefined}
        tabIndex={canOpenRow ? 0 : undefined}
        aria-label={canOpenRow ? `Open ${entityKind ?? 'record'} ${rowLabel}` : undefined}
        onClick={(e) => {
          // Mirror the demo guard: don't trigger row-click on form/action interactions.
          const target = e.target as HTMLElement;
          if (isInteractiveRowTarget(target)) return;
          onRowClick?.(r);
        }}
        onKeyDown={
          canOpenRow
            ? (e) => {
                const target = e.target as HTMLElement;
                if (isInteractiveRowTarget(target)) return;
                if (e.key !== 'Enter' && e.key !== ' ') return;
                e.preventDefault();
                onRowClick?.(r);
              }
            : undefined
        }
        onContextMenu={
          allRowActions.length
            ? (e) => {
                e.preventDefault();
                openRowContext(r);
              }
            : undefined
        }
      >
        {allowSelection ? (
          <td className="dt-checkbox">
            <input
              type="checkbox"
              aria-label="Select row"
              checked={selected.has(k)}
              onClick={(e) => e.stopPropagation()}
              onChange={(e) => {
                setSelected((prev) => {
                  const next = new Set(prev);
                  if (e.target.checked) next.add(k);
                  else next.delete(k);
                  return next;
                });
              }}
            />
          </td>
        ) : null}
        {cols.map((c) => renderCell(c, r, i))}
        {allRowActions.length ? (
          <td className="dt-row-actions">
            <button
              type="button"
              className="icon-btn"
              aria-label="Row actions"
              onClick={(e) => {
                e.stopPropagation();
                openRowContext(r);
              }}
            >
              ⋯
            </button>
          </td>
        ) : null}
      </tr>
    );
  }

  // ---------- Render: body (with grouping + virtualization) ----------

  function renderBody(): ReactNode {
    const cols = visibleColumns();
    const colCount = cols.length + (allowSelection ? 1 : 0) + (allRowActions.length ? 1 : 0);

    // The empty state renders beside the table, not in a cell (see the top-level render).
    if (!processed.length) return null;

    if (groupBy) {
      const groups = groupRows(processed, groupBy);
      const numericCols = cols.filter(
        (c) => c.type === 'number' || c.format === 'currency' || c.format === 'ms'
      );
      const tbodyChildren: ReactNode[] = [];
      for (const [key, group] of groups) {
        const collapsed = collapsedGroups.has(String(key));
        const allSelectedInGroup = group.every((r) =>
          selected.has(rowKeyOf(r, processed.indexOf(r)))
        );
        let aggLabel = `${group.length}`;
        if (groupAggMode !== 'count' && numericCols.length) {
          const c = numericCols[0]!;
          if (groupAggMode === 'sum') {
            const s = group.reduce(
              (acc, r) => acc + (Number((r as Record<string, unknown>)[c.key]) || 0),
              0
            );
            aggLabel = `Σ ${c.label} ${formatAgg(s, c)}`;
          } else if (groupAggMode === 'avg') {
            const a =
              group.reduce(
                (acc, r) => acc + (Number((r as Record<string, unknown>)[c.key]) || 0),
                0
              ) / Math.max(1, group.length);
            aggLabel = `μ ${c.label} ${formatAgg(a, c)}`;
          }
        }

        tbodyChildren.push(
          <tr
            key={`group-${String(key)}`}
            className="dt-group-row"
            data-group-key={String(key)}
          >
            <td colSpan={colCount}>
              <button
                type="button"
                className="dt-group-toggle"
                aria-label={collapsed ? 'Expand group' : 'Collapse group'}
                onClick={(e) => {
                  e.stopPropagation();
                  setCollapsedGroups((prev) => {
                    const next = new Set(prev);
                    if (collapsed) next.delete(String(key));
                    else next.add(String(key));
                    return next;
                  });
                }}
              >
                {collapsed ? '▸' : '▾'}
              </button>
              {allowSelection ? (
                <input
                  type="checkbox"
                  aria-label="Select all in group"
                  className="dt-group-check"
                  checked={allSelectedInGroup}
                  onClick={(e) => e.stopPropagation()}
                  onChange={(e) => {
                    setSelected((prev) => {
                      const next = new Set(prev);
                      if (e.target.checked) {
                        group.forEach((r) =>
                          next.add(rowKeyOf(r, processed.indexOf(r)))
                        );
                      } else {
                        group.forEach((r) =>
                          next.delete(rowKeyOf(r, processed.indexOf(r)))
                        );
                      }
                      return next;
                    });
                  }}
                />
              ) : null}
              <span className="dt-group-name">
                <span
                  style={{
                    color: 'var(--ink-3)',
                    fontSize: '11px',
                    marginRight: '6px',
                  }}
                >
                  {groupBy}
                </span>
                <span className="mono" style={{ fontWeight: 600 }}>
                  {formatGroupKey(groupBy, key)}
                </span>
              </span>
              <button
                type="button"
                className="dt-group-agg mono"
                title="Cycle: count → sum → avg"
                onClick={(e) => {
                  e.stopPropagation();
                  setGroupAggMode((m) =>
                    m === 'count' ? 'sum' : m === 'sum' ? 'avg' : 'count'
                  );
                }}
              >
                {aggLabel}
              </button>
              <div style={{ flex: 1 }} />
              {groupActions.length ? (
                <button
                  type="button"
                  className="dt-group-menu"
                  title="Group actions"
                  onClick={(e) => {
                    e.stopPropagation();
                    openGroupActionsMenu(key, group);
                  }}
                >
                  ⋯
                </button>
              ) : null}
            </td>
          </tr>
        );
        if (!collapsed) {
          group.forEach((r) => tbodyChildren.push(renderRow(r, processed.indexOf(r), cols)));
        }
      }
      return <tbody>{tbodyChildren}</tbody>;
    }

    // Virtualized window
    if (virtualize && processed.length >= VIRTUALIZE_THRESHOLD) {
      const viewportH = wrapRef.current?.clientHeight || 600;
      const visibleCount = Math.ceil(viewportH / ROW_H) + 16;
      const start = Math.max(0, Math.floor(scrollTop / ROW_H) - 8);
      const end = Math.min(processed.length, start + visibleCount);
      const padTop = start * ROW_H;
      const padBot = (processed.length - end) * ROW_H;
      const win = processed.slice(start, end);
      return (
        <tbody>
          {padTop > 0 ? (
            <tr aria-hidden="true">
              <td
                colSpan={colCount}
                style={{ padding: 0, height: `${padTop}px`, border: 'none' }}
              />
            </tr>
          ) : null}
          {win.map((r, i) => renderRow(r, i + start, cols))}
          {padBot > 0 ? (
            <tr aria-hidden="true">
              <td
                colSpan={colCount}
                style={{ padding: 0, height: `${padBot}px`, border: 'none' }}
              />
            </tr>
          ) : null}
        </tbody>
      );
    }

    return <tbody>{processed.map((r, i) => renderRow(r, i, cols))}</tbody>;
  }

  // ---------- Top-level render ----------

  const wrapStyle: CSSProperties | undefined = density
    ? ({ ['--dt-density' as const]: density } as CSSProperties)
    : undefined;

  return (
    <div
      ref={wrapRef}
      className="dt-wrap"
      tabIndex={0}
      data-density={density || undefined}
      style={wrapStyle}
    >
      {renderToolbar()}
      {renderFilterRow()}
      {renderBulkBar()}
      <div ref={tableHostRef} className="dt">
        <table className="dt__table">
          {renderHeader()}
          {renderBody()}
        </table>
        {/* Beside the table: a cell spanning every column is as wide as the columns, wider than a phone. */}
        {processed.length ? null : <StateView kind="empty" hint={emptyText} />}
      </div>
      {/* Per-instance overlay nodes — render them so the hooks have a portal anchor. */}
      {drawer?.node ?? null}
      {palette?.node ?? null}
      {/* Standalone fallback for decision-trail when no useDrawer is wired. */}
      {dtRow ? (
        <DecisionTrailDrawer
          row={dtRow as Record<string, unknown>}
          entityKind={entityKind}
          onClose={() => setDtRow(null)}
        />
      ) : null}
    </div>
  );
}

// ---------- Inline input (used for text/number/date/datetime inline edits) ----------

interface InlineInputProps {
  type?: DataTableColumnType;
  initial: unknown;
  onCommit: (value: unknown) => void;
  onCancel: () => void;
}

function InlineInput({ type, initial, onCommit, onCancel }: InlineInputProps) {
  const [value, setValue] = useState<string>(initial == null ? '' : String(initial));
  const ref = useRef<HTMLInputElement | null>(null);
  const committedRef = useRef<boolean>(false);
  useEffect(() => {
    ref.current?.focus();
    ref.current?.select();
  }, []);
  const inputType =
    type === 'number'
      ? 'number'
      : type === 'date'
      ? 'date'
      : type === 'datetime'
      ? 'datetime-local'
      : 'text';
  function done(commit: boolean) {
    if (committedRef.current) return;
    committedRef.current = true;
    if (commit) {
      onCommit(type === 'number' ? Number(value) : value);
    } else {
      onCancel();
    }
  }
  return (
    <input
      ref={ref}
      type={inputType}
      className="dt-inline-input"
      value={value}
      onChange={(e) => setValue(e.target.value)}
      onBlur={() => done(true)}
      onKeyDown={(e) => {
        if (e.key === 'Enter') {
          done(true);
          e.preventDefault();
        } else if (e.key === 'Escape') {
          done(false);
          e.preventDefault();
        }
      }}
    />
  );
}

export default DataTable;
