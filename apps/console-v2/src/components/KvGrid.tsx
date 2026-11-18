// KvGrid.tsx — key/value grid used in detail summary cards.
//
// Mirrors demo `kvGrid(rows, { onEdit })`:
//   • Each row renders a label + value
//   • `lookup` rows render a tone-coloured Chip resolved via getLookups()
//   • When `onEdit` is supplied, click-to-edit is enabled per row:
//       – `lookup` → opens ReferencePicker(kind=lookup)
//       – `reference` → opens ReferencePicker(kind=reference)
//       – plain text → inline <input> (Enter commits, Esc cancels, blur commits)
//
// Capability gating: when a row provides `capability` and the user lacks it,
// the row falls back to read-only with a CapabilityLock chip — no inline
// "fail later" path (zero-hardcoded gate).
import { isValidElement, useState, type ReactNode } from 'react';
import { Chip } from './Chip';
import { CapabilityLock } from './CapabilityLock';
import { ReferencePicker, type ReferenceSource } from './ReferencePicker';
import type { ChipKind } from './Chip';
import { getLookups } from '../lib/api';
import { useCapability } from '../lib/identity';

export interface KvRow {
  key: string;
  label: string;
  value: unknown;
  /** Lookup category — if set, value renders as a tone Chip and editor opens a lookup picker. */
  lookup?: string;
  /** Render value with monospace styling. */
  mono?: boolean;
  /** Make this row uneditable even when onEdit is supplied (default: editable). */
  editable?: boolean;
  /** Generic FK reference — opens a reference picker on edit. */
  reference?: Omit<ReferenceSource, 'kind'>;
  /** Capability required for editing. When missing, row is read-only with a lock. */
  capability?: string;
}

export interface KvGridProps {
  rows: KvRow[];
  onEdit?: (key: string, value: unknown) => Promise<void> | void;
  className?: string;
}

interface LookupRow {
  value: string;
  label: string;
  tone?: string;
}

function lookupTone(category: string, value: unknown): ChipKind {
  const list = (getLookups(category) || []) as LookupRow[];
  const row = list.find((r) => r.value === value);
  return ((row?.tone as ChipKind | undefined) ?? 'neutral');
}

function lookupLabel(category: string, value: unknown): string {
  const list = (getLookups(category) || []) as LookupRow[];
  const row = list.find((r) => r.value === value);
  return row?.label ?? String(value ?? '');
}

interface PickerState {
  rowKey: string;
  source:
    | { kind: 'lookup'; category: string }
    | ({ kind: 'reference' } & Omit<ReferenceSource, 'kind'>);
  title: string;
}

export function KvGrid({ rows, onEdit, className }: KvGridProps) {
  const [editingKey, setEditingKey] = useState<string | null>(null);
  const [picker, setPicker] = useState<PickerState | null>(null);

  const classes = ['kvgrid', className].filter(Boolean).join(' ');

  return (
    <div className={classes}>
      {rows.map((r) => (
        <KvRowView
          key={r.key}
          row={r}
          onEdit={onEdit}
          isEditingInline={editingKey === r.key}
          onStartInline={() => setEditingKey(r.key)}
          onStopInline={() => setEditingKey(null)}
          onOpenLookup={() =>
            setPicker({ rowKey: r.key, source: { kind: 'lookup', category: r.lookup! }, title: r.label })
          }
          onOpenReference={() =>
            setPicker({
              rowKey: r.key,
              source: { kind: 'reference', ...(r.reference as Omit<ReferenceSource, 'kind'>) },
              title: r.label,
            })
          }
        />
      ))}
      {picker ? (
        <ReferencePicker
          open
          title={picker.title}
          source={picker.source}
          onClose={() => setPicker(null)}
          onPick={async (val) => {
            const targetKey = picker.rowKey;
            setPicker(null);
            if (onEdit) await onEdit(targetKey, val);
          }}
        />
      ) : null}
    </div>
  );
}

interface KvRowViewProps {
  row: KvRow;
  onEdit?: (key: string, value: unknown) => Promise<void> | void;
  isEditingInline: boolean;
  onStartInline: () => void;
  onStopInline: () => void;
  onOpenLookup: () => void;
  onOpenReference: () => void;
}

function KvRowView({
  row,
  onEdit,
  isEditingInline,
  onStartInline,
  onStopInline,
  onOpenLookup,
  onOpenReference,
}: KvRowViewProps) {
  const allowed = useCapability(row.capability ?? null);
  const editable = !!onEdit && row.editable !== false && (!row.capability || allowed);

  const handleClick = () => {
    if (!editable) return;
    if (row.lookup) {
      onOpenLookup();
      return;
    }
    if (row.reference) {
      onOpenReference();
      return;
    }
    onStartInline();
  };

  let valueNode: ReactNode;
  if (isEditingInline && editable && !row.lookup && !row.reference) {
    valueNode = (
      <InlineInput
        initial={row.value == null ? '' : String(row.value)}
        onCommit={async (next) => {
          onStopInline();
          if (onEdit) await onEdit(row.key, next);
        }}
        onCancel={onStopInline}
      />
    );
  } else {
    valueNode = renderKvValue(row);
  }

  const valClassName = [
    row.lookup ? 'kvgrid__val' : row.mono ? 'kvgrid__val mono' : 'kvgrid__val',
    editable ? 'kvgrid__val--editable' : '',
  ]
    .filter(Boolean)
    .join(' ');

  return (
    <div className="kvgrid__row">
      <span className="kvgrid__key mono">{row.label}</span>
      <span
        className={valClassName}
        title={editable ? 'Click to edit' : undefined}
        onClick={editable && !isEditingInline ? handleClick : undefined}
      >
        {valueNode}
        {row.capability && !allowed ? <CapabilityLock capability={row.capability} /> : null}
      </span>
    </div>
  );
}

function renderKvValue(r: KvRow): ReactNode {
  const v = r.value;
  if (v == null || v === '') {
    return (
      <span className="mono" style={{ color: 'var(--ink-3)' }}>
        —
      </span>
    );
  }
  if (r.lookup) {
    return <Chip label={lookupLabel(r.lookup, v)} kind={lookupTone(r.lookup, v)} size="xs" />;
  }
  if (isValidElement(v)) return v;
  return <span>{String(v)}</span>;
}

interface InlineInputProps {
  initial: string;
  onCommit: (value: string) => void | Promise<void>;
  onCancel: () => void;
}

function InlineInput({ initial, onCommit, onCancel }: InlineInputProps) {
  const [val, setVal] = useState(initial);
  let committed = false;

  const commit = async () => {
    if (committed) return;
    committed = true;
    await onCommit(val);
  };

  return (
    <input
      autoFocus
      className="dt-inline-input"
      value={val}
      onChange={(e) => setVal(e.target.value)}
      onBlur={() => {
        void commit();
      }}
      onFocus={(e) => e.currentTarget.select()}
      onKeyDown={(e) => {
        if (e.key === 'Enter') {
          e.preventDefault();
          void commit();
        } else if (e.key === 'Escape') {
          e.preventDefault();
          committed = true;
          onCancel();
        }
      }}
    />
  );
}
