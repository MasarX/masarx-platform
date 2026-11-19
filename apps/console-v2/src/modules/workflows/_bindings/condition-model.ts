// _bindings/condition-model.ts — Pure model + helpers for the workflow_binding
// condition editor. Module-local (leading underscore folder) so it stays out of
// the shared primitive surface.
//
// The shape mirrors a small JSONLogic subset that the backend evaluator already
// accepts. We keep the model strict and serialisable so the editor can round-trip
// through `proposeSettingsChange` without information loss.
//
// Backed by:
//   - public.workflow_binding_registry / workflow_binding_stage_registry
//   - public.settings (category=workflow_binding_policy)
//   - JSONLogic eval contract (safe_jsonlogic_apply_v1)

import { getLookups } from '@/lib/api';

export type FieldType = 'string' | 'number' | 'boolean' | 'unknown';

export type Operator =
  | 'equals'
  | 'not_equals'
  | 'in'
  | 'not_in'
  | 'matches'
  | 'gt'
  | 'gte'
  | 'lt'
  | 'lte'
  | 'exists'
  | 'not_exists';

export interface ConditionLeaf {
  kind: 'leaf';
  /** Path expression on the event payload (e.g. `payload.sender`). */
  field: string;
  op: Operator;
  /** Raw user input. We coerce on emit, never on input. */
  value: string;
}

export interface ConditionGroup {
  kind: 'group';
  /** AND requires every child to pass. OR requires any child. NOT inverts the single child. */
  combinator: 'and' | 'or' | 'not';
  children: ConditionNode[];
}

export type ConditionNode = ConditionLeaf | ConditionGroup;

/** Operators that don't take a value. */
export const NULLARY_OPS: Operator[] = ['exists', 'not_exists'];

/** Maximum allowed nesting depth (keeps editor sane).
 *
 *  Cycle E2 (Workflows P2 #11) — canonical SSOT for this depth lives at
 *  `workflow_binding_defaults.condition_max_depth` (resolved via the
 *  settings ladder). The exported constant remains as a deterministic
 *  pure-helper fallback for `validate(...)` (which must run without a
 *  query subscription) and as a baseline for the bindings + alerts
 *  surfaces. Tenants that need a different cap override at tenant scope
 *  via the canonical row; the consumer surfaces should prefer the
 *  policy-resolved value when available.
 */
export const MAX_DEPTH = 3;

/** Default leaf used when a row is added. */
export function makeLeaf(field = 'payload.sender'): ConditionLeaf {
  return { kind: 'leaf', field, op: 'equals', value: '' };
}

/** Default group used at the root or as a sub-group. */
export function makeGroup(combinator: 'and' | 'or' = 'and'): ConditionGroup {
  return { kind: 'group', combinator, children: [makeLeaf()] };
}

/**
 * Operators allowed for an inferred field type. Narrowing this server-side is
 * desirable; until then we narrow client-side based on observed payload type.
 *
 * Cycle E2 (Workflows P2 #11) — operator allowlist resolves canonically
 * through the `condition_operator_by_type` lookup. Each row pairs
 * `(field_type, operator)` so adding a new operator/type slot is a single
 * seed insert. Replaces the inline `Operator[]` literal arrays per
 * `FieldType`. Missing canonical rows → returns the empty list (loud
 * surface: the editor's operator dropdown shows nothing instead of a
 * fabricated default that hides the gap).
 */
export function operatorsFor(t: FieldType): Operator[] {
  type ConditionOperatorRow = {
    value: string;
    metadata?: { field_type?: string; operator?: string };
  };
  const rows = getLookups('condition_operator_by_type') as ConditionOperatorRow[];
  const matched: Operator[] = [];
  const seen = new Set<string>();
  for (const row of rows) {
    if (row.metadata?.field_type !== t) continue;
    const op = row.metadata?.operator;
    if (typeof op === 'string' && !seen.has(op)) {
      seen.add(op);
      matched.push(op as Operator);
    }
  }
  return matched;
}

/** Best-effort type inference from observed payload values. */
export function inferType(samples: unknown[]): FieldType {
  let sawString = false;
  let sawNumber = false;
  let sawBool = false;
  for (const s of samples) {
    if (s === undefined || s === null) continue;
    const t = typeof s;
    if (t === 'string') sawString = true;
    else if (t === 'number') sawNumber = true;
    else if (t === 'boolean') sawBool = true;
  }
  if (sawNumber && !sawString && !sawBool) return 'number';
  if (sawBool && !sawString && !sawNumber) return 'boolean';
  if (sawString && !sawNumber && !sawBool) return 'string';
  return 'unknown';
}

/** Pull every observed payload key from a list of recent events. */
export function discoverFields(events: Array<{ payload?: Record<string, unknown> | null }>): string[] {
  const out = new Set<string>();
  for (const e of events) {
    const payload = (e.payload || {}) as Record<string, unknown>;
    for (const k of Object.keys(payload)) out.add(`payload.${k}`);
  }
  return Array.from(out).sort();
}

/** Get the leaf samples for a field across events (used for type inference). */
export function valueSamples(field: string, events: Array<{ payload?: Record<string, unknown> | null }>): unknown[] {
  const key = field.replace(/^payload\./, '');
  const out: unknown[] = [];
  for (const e of events) {
    const payload = (e.payload || {}) as Record<string, unknown>;
    if (key in payload) out.push(payload[key]);
  }
  return out;
}

// ---------- Validation ----------

export interface ValidationIssue {
  path: number[];
  message: string;
  severity: 'error' | 'warn';
}

export function validate(node: ConditionNode, path: number[] = [], depth = 0): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  if (depth > MAX_DEPTH) {
    issues.push({ path, message: `Nesting too deep (max ${MAX_DEPTH}).`, severity: 'error' });
    return issues;
  }
  if (node.kind === 'leaf') {
    if (!node.field.trim()) {
      issues.push({ path, message: 'Field is required.', severity: 'error' });
    }
    if (!NULLARY_OPS.includes(node.op) && !node.value.trim()) {
      issues.push({ path, message: 'Value is empty.', severity: 'warn' });
    }
    if ((node.op === 'gt' || node.op === 'gte' || node.op === 'lt' || node.op === 'lte') && node.value && Number.isNaN(Number(node.value))) {
      issues.push({ path, message: 'Numeric value required.', severity: 'error' });
    }
    if (node.op === 'matches' && node.value) {
      try {
        new RegExp(node.value);
      } catch {
        issues.push({ path, message: 'Invalid regex.', severity: 'error' });
      }
    }
    return issues;
  }
  if (node.combinator === 'not' && node.children.length !== 1) {
    issues.push({ path, message: 'NOT must have exactly one child.', severity: 'error' });
  }
  if (node.children.length === 0) {
    issues.push({ path, message: 'Empty group.', severity: 'warn' });
  }
  node.children.forEach((c, i) => issues.push(...validate(c, [...path, i], depth + 1)));
  return issues;
}

// ---------- JSONLogic emit + eval ----------

/** Coerce a string value into the right JS type for evaluation. */
function coerce(v: string): unknown {
  if (v === 'true') return true;
  if (v === 'false') return false;
  if (v === 'null') return null;
  if (v.trim() !== '' && !Number.isNaN(Number(v))) return Number(v);
  // CSV for `in` / `not_in`
  if (v.includes(',')) return v.split(',').map((p) => coerce(p.trim()));
  return v;
}

/** Emit a JSONLogic-compatible expression. */
export function toJsonLogic(node: ConditionNode): unknown {
  if (node.kind === 'leaf') {
    const varRef = { var: node.field };
    const val = coerce(node.value);
    switch (node.op) {
      case 'equals':
        return { '==': [varRef, val] };
      case 'not_equals':
        return { '!=': [varRef, val] };
      case 'gt':
        return { '>': [varRef, val] };
      case 'gte':
        return { '>=': [varRef, val] };
      case 'lt':
        return { '<': [varRef, val] };
      case 'lte':
        return { '<=': [varRef, val] };
      case 'in':
        return { in: [varRef, Array.isArray(val) ? val : [val]] };
      case 'not_in':
        return { '!': [{ in: [varRef, Array.isArray(val) ? val : [val]] }] };
      case 'matches':
        // JSONLogic does not have native regex; backend wraps as `regex_match` op.
        return { regex_match: [varRef, String(val)] };
      case 'exists':
        return { '!=': [varRef, null] };
      case 'not_exists':
        return { '==': [varRef, null] };
    }
  }
  const childExprs = node.children.map(toJsonLogic);
  if (node.combinator === 'and') return { and: childExprs };
  if (node.combinator === 'or') return { or: childExprs };
  // NOT
  return { '!': childExprs[0] ?? true };
}

/** Read `a.b.c` style path on a payload-like object. */
function readPath(payload: Record<string, unknown>, expr: string): unknown {
  const parts = expr.replace(/^payload\./, '').split('.');
  let cur: unknown = payload;
  for (const p of parts) {
    if (cur === null || typeof cur !== 'object') return undefined;
    cur = (cur as Record<string, unknown>)[p];
  }
  return cur;
}

/** Pure client-side evaluator that mirrors the backend JSONLogic semantics for
 *  the operators we emit. Used for live preview against `recent_workflow_events`. */
export function evalCondition(node: ConditionNode, payload: Record<string, unknown>): boolean {
  if (node.kind === 'leaf') {
    const cell = readPath(payload, node.field);
    const val = coerce(node.value);
    switch (node.op) {
      case 'equals':
        return String(cell) === String(val);
      case 'not_equals':
        return String(cell) !== String(val);
      case 'gt':
        return Number(cell) > Number(val);
      case 'gte':
        return Number(cell) >= Number(val);
      case 'lt':
        return Number(cell) < Number(val);
      case 'lte':
        return Number(cell) <= Number(val);
      case 'in': {
        const arr = Array.isArray(val) ? val : [val];
        return arr.map(String).includes(String(cell));
      }
      case 'not_in': {
        const arr = Array.isArray(val) ? val : [val];
        return !arr.map(String).includes(String(cell));
      }
      case 'matches':
        try {
          return new RegExp(String(val)).test(String(cell ?? ''));
        } catch {
          return false;
        }
      case 'exists':
        return cell !== undefined && cell !== null;
      case 'not_exists':
        return cell === undefined || cell === null;
    }
  }
  if (node.combinator === 'and') return node.children.every((c) => evalCondition(c, payload));
  if (node.combinator === 'or') return node.children.some((c) => evalCondition(c, payload));
  return !evalCondition(node.children[0] ?? makeLeaf(), payload);
}

// ---------- Backwards-compat: import / export from legacy flat shape ----------

/** Legacy flat shape: `{ field: value, ... }`. We import as a flat AND of equals-leaves. */
export function fromLegacyFlat(obj: Record<string, unknown> | null | undefined): ConditionGroup {
  const root = makeGroup('and');
  root.children = [];
  for (const [k, v] of Object.entries(obj ?? {})) {
    root.children.push({ kind: 'leaf', field: `payload.${k}`, op: 'equals', value: String(v) });
  }
  if (root.children.length === 0) root.children.push(makeLeaf());
  return root;
}

/** When the user only used flat AND/equals leaves at root, we can emit a flat
 *  legacy shape for backwards compatibility with the existing seed/UI. */
export function toLegacyFlatIfPossible(node: ConditionNode): Record<string, unknown> | null {
  if (node.kind !== 'group' || node.combinator !== 'and') return null;
  const out: Record<string, unknown> = {};
  for (const c of node.children) {
    if (c.kind !== 'leaf' || c.op !== 'equals') return null;
    out[c.field.replace(/^payload\./, '')] = coerce(c.value);
  }
  return out;
}

/** Human-readable summary used in tables. */
export function summarize(node: ConditionNode | null | undefined): string {
  if (!node) return '— always —';
  if (node.kind === 'leaf') return `${node.field} ${node.op}${NULLARY_OPS.includes(node.op) ? '' : ` ${node.value || ''}`}`;
  if (node.children.length === 0) return '— always —';
  const join = node.combinator === 'or' ? ' OR ' : node.combinator === 'and' ? ' AND ' : 'NOT ';
  if (node.combinator === 'not') return `NOT (${summarize(node.children[0]!)})`;
  return node.children.map(summarize).join(join);
}
