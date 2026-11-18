import { readUrlParam, type UrlParamSource } from '@/lib/url-params';

export type FinanceUrlScope = { kind: 'client' | 'partner'; id: string };
export interface FinanceScopeFilterOptions {
  backendSafe?: boolean;
}
export interface FinanceScopeLabelRow extends Record<string, unknown> {
  id?: string | null;
  client_id?: string | null;
  partner_id?: string | null;
  participant_id?: string | null;
  supplier_participant_profile_id?: string | null;
  name?: string | null;
  legal_name?: string | null;
  display_name?: string | null;
  label?: string | null;
  slug?: string | null;
  client_name?: string | null;
  partner_name?: string | null;
}

const NIL_UUID = '00000000-0000-0000-0000-000000000000';
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export function readFinanceUrlScope(source?: UrlParamSource): FinanceUrlScope | null {
  const client = readUrlParam('client', source);
  if (client) return { kind: 'client', id: client };

  const partner = readUrlParam('partner', source);
  if (partner) return { kind: 'partner', id: partner };

  return null;
}

function titleWord(value: string): string {
  if (value.length <= 3) return value.toUpperCase();
  return `${value.slice(0, 1).toUpperCase()}${value.slice(1).toLowerCase()}`;
}

function firstText(row: FinanceScopeLabelRow, keys: string[]): { key: string; value: string } | null {
  for (const key of keys) {
    const value = row[key];
    if (typeof value === 'string' && value.trim()) return { key, value: value.trim() };
  }
  return null;
}

function rowMatchesScope(row: FinanceScopeLabelRow, scope: FinanceUrlScope): boolean {
  if (valueMatchesScopeId(row.id, scope.id)) return true;
  const keys =
    scope.kind === 'client'
      ? ['client_id', 'sender_id', 'subject_id']
      : ['partner_id', 'participant_id', 'supplier_participant_profile_id', 'subject_id'];
  return keys.some((key) => valueMatchesScopeId(row[key], scope.id));
}

function titleLabel(value: string): string {
  return value.split(/\s+/).map(titleWord).join(' ');
}

export function financeUrlScopeLabel(
  scope: FinanceUrlScope,
  rows: FinanceScopeLabelRow[] = [],
): string {
  const kind = scope.kind === 'client' ? 'client' : 'partner';
  const row = rows.find((candidate) => rowMatchesScope(candidate, scope));
  const rowLabel = row
    ? firstText(
        row,
        scope.kind === 'client'
          ? ['name', 'legal_name', 'display_name', 'label', 'client_name', 'slug']
          : ['name', 'display_name', 'legal_name', 'label', 'partner_name', 'slug'],
      )
    : null;
  if (rowLabel) {
    const label =
      rowLabel.key === 'slug'
        ? titleLabel(rowLabel.value.replace(/[_-]+/g, ' '))
        : rowLabel.value;
    return `Scoped ${kind} ${label}`;
  }

  const normalized = scope.id
    .trim()
    .replace(/^(cl|mpp|client|partner)[_-]+/i, '')
    .replace(/[_-]+/g, ' ')
    .trim();
  if (!normalized || UUID_RE.test(scope.id)) return `Scoped ${kind} selected ${kind}`;
  return `Scoped ${kind} ${titleLabel(normalized)}`;
}

export function rowMetadata(row: Record<string, unknown>): Record<string, unknown> {
  return row.metadata && typeof row.metadata === 'object'
    ? (row.metadata as Record<string, unknown>)
    : {};
}

export function valueMatchesScopeId(value: unknown, scopeId: string): boolean {
  return typeof value === 'string' && value.trim() === scopeId;
}

function uniqueFilters(filters: Array<Record<string, unknown>>): Array<Record<string, unknown>> {
  const seen = new Set<string>();
  const out: Array<Record<string, unknown>> = [];
  for (const filter of filters) {
    const clean = Object.fromEntries(
      Object.entries(filter).filter(([, value]) => value !== undefined && value !== null && value !== ''),
    );
    if (Object.keys(clean).length === 0) continue;
    const key = JSON.stringify(Object.entries(clean).sort(([a], [b]) => a.localeCompare(b)));
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(clean);
  }
  return out;
}

function uuidFilterValue(scopeId: string, backendSafe: boolean): string {
  if (!backendSafe || UUID_RE.test(scopeId)) return scopeId;
  return NIL_UUID;
}

function uuidSubjectFilter(scope: FinanceUrlScope, backendSafe: boolean): Record<string, unknown> | null {
  if (backendSafe && !UUID_RE.test(scope.id)) return null;
  return { subject_type: scope.kind, subject_id: scope.id };
}

export function settlementScopeFilters(
  scope: FinanceUrlScope,
  options: FinanceScopeFilterOptions = {},
): Array<Record<string, unknown>> {
  const backendSafe = options.backendSafe === true;
  if (scope.kind === 'client') {
    const clientId = uuidFilterValue(scope.id, backendSafe);
    return uniqueFilters([
      { client_id: clientId },
      { sender_id: clientId },
      uuidSubjectFilter(scope, backendSafe) ?? {},
    ]);
  }
  return uniqueFilters([
    { partner_id: scope.id },
    { participant_id: scope.id },
    { supplier_participant_profile_id: scope.id },
    uuidSubjectFilter(scope, backendSafe) ?? {},
  ]);
}

export function financeEventScopeFilters(
  scope: FinanceUrlScope,
  settlementBatchIds: string[] = [],
  options: FinanceScopeFilterOptions = {},
): Array<Record<string, unknown>> {
  const backendSafe = options.backendSafe === true;
  const direct =
    scope.kind === 'client'
      ? [
          { client_id: uuidFilterValue(scope.id, backendSafe) },
          { sender_id: uuidFilterValue(scope.id, backendSafe) },
        ]
      : [
          { partner_id: scope.id },
          { participant_id: scope.id },
          { supplier_participant_profile_id: scope.id },
        ];
  return uniqueFilters([
    ...direct,
    ...settlementBatchIds.map((id) => ({ settlement_batch_id: id })),
  ]);
}

export function disputeDirectoryScopeFilters(
  scope: FinanceUrlScope,
  options: FinanceScopeFilterOptions = {},
): Array<Record<string, unknown>> {
  const backendSafe = options.backendSafe === true;
  return uniqueFilters([
    scope.kind === 'client'
      ? { client_id: uuidFilterValue(scope.id, backendSafe) }
      : { partner_id: scope.id },
  ]);
}
