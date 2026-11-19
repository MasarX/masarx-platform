// ReferencePicker.tsx — wrapper around Palette that turns a typed `source`
// (lookup category, generic reference list, or scope tree) into palette items.
// Mirrors demo `openReferencePicker({ title, source, onPick, allowClear })`.
//
// Use when editing FK/lookup fields so callers never get free-text input
// where a backing collection exists (zero-hardcoding mandate).
import { useMemo, type ReactNode } from 'react';
import { Palette, type PaletteItem } from './Palette';
import { getLookups } from '../lib/api';

export interface LookupSource {
  kind: 'lookup';
  category: string;
}

export interface ReferenceSource<T = Record<string, unknown>> {
  kind: 'reference';
  items: T[];
  display: (row: T) => string;
  value: (row: T) => unknown;
  sub?: (row: T) => string | undefined;
  section?: string;
}

export interface ScopeNode {
  id?: string;
  label?: string;
  rank?: number;
}

export interface ScopeSource {
  kind: 'scope';
  tree: Record<string, ScopeNode>;
}

export type PickerSource = LookupSource | ReferenceSource | ScopeSource;

export interface ReferencePickerProps {
  open: boolean;
  title?: string;
  source: PickerSource;
  allowClear?: boolean;
  onPick: (value: unknown, item?: PaletteItem & { raw?: unknown }) => void;
  onClose: () => void;
  placeholder?: string;
}

interface RawPaletteItem extends PaletteItem {
  /** Original row from the source (for callers that need more than just the value). */
  raw?: unknown;
}

function buildItems(source: PickerSource, allowClear: boolean | undefined): RawPaletteItem[] {
  let items: RawPaletteItem[] = [];

  if (source.kind === 'lookup') {
    const rows = getLookups(source.category) || [];
    items = rows.map((r): RawPaletteItem => ({
      label: r.label,
      key: r.value,
      meta: (r.tone ?? (r.rank != null ? String(r.rank) : '')) as ReactNode,
      section: source.category,
      value: r.value,
      raw: r,
    }));
  } else if (source.kind === 'reference') {
    items = (source.items || []).map((row): RawPaletteItem => {
      const v = source.value(row);
      const sub = source.sub?.(row);
      return {
        label: source.display(row),
        key: v == null ? undefined : String(v),
        meta: sub,
        section: source.section || 'Items',
        value: v,
        raw: row,
      };
    });
  } else if (source.kind === 'scope') {
    items = Object.entries(source.tree || {}).map(([k, v]): RawPaletteItem => ({
      label: v.label || k,
      key: `${k}:${v.id || k}`,
      meta: v.rank != null ? `rank ${v.rank}` : undefined,
      section: 'Scope',
      value: { scope_type: k, scope_id: v.id ?? null },
      raw: v,
    }));
  }

  if (allowClear) {
    items.unshift({
      label: '— clear —',
      key: '__clear__',
      section: 'Action',
      value: null,
    });
  }

  return items;
}

export function ReferencePicker({
  open,
  title,
  source,
  allowClear,
  onPick,
  onClose,
  placeholder,
}: ReferencePickerProps) {
  const items = useMemo(() => buildItems(source, allowClear), [source, allowClear]);
  const ph = placeholder ?? `Pick ${title || 'value'}…`;

  return (
    <Palette<RawPaletteItem>
      open={open}
      placeholder={ph}
      items={items}
      onClose={onClose}
      onPick={(item) => {
        onPick(item.value, item);
      }}
    />
  );
}
