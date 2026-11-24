import { CAP } from '../capabilities';
import {
  backendOutcomeError,
  type BankAccountBalanceResult,
  type ComputeBankAccountBalanceArgs,
  type ComputeKpiRollupArgs,
  hasCapability,
  type KpiRollupResolution,
  liveBackendUnavailableError,
  liveRpc,
  type LogFilter,
  normalizeLiveListResult,
  objectRecord,
  requireLiveRpcRecord,
  RESOURCE_DATA,
  seed,
  sleep,
  state,
} from '../data-source';
import { SEED_MODE_ENABLED } from '../seed-loader';
import { getSupabaseClient } from '../supabase';
import { asNonEmptyString } from './shared';

// ----------- Dashboard projection (mirrors a planned api.ui_resource_metrics_v1('dashboard_kpis')) -----------
export async function dashboardKpis(): Promise<
  Array<{ label: string; key: string; value: number | string; delta?: string; tone?: string; spark?: number[] }>
> {
  const live = await liveRpc('ui_list_resource_v1', {
    p_resource: 'kpi_rollup_directory',
    p_filters: {},
    p_limit: 12,
    p_offset: 0,
    p_sort: { key: 'rank', direction: 'asc' },
  });
  if (live) {
    return normalizeLiveListResult<Record<string, unknown>>(live.data, 0, 12).rows.map((row) => ({
      label: String(row.label ?? row.name ?? row.group_label ?? row.kpi_key ?? row.key ?? 'KPI'),
      key: String(row.kpi_key ?? row.key ?? row.id ?? ''),
      value: (row.display_value ?? row.value ?? row.value_num ?? row.numerator ?? 0) as number | string,
      delta: row.delta == null ? undefined : String(row.delta),
      tone: row.tone == null ? undefined : String(row.tone),
      spark: Array.isArray(row.spark) ? (row.spark as number[]) : undefined,
    }));
  }

  await sleep(20);
  const runs = seed.route_runs as Array<{ status: string; stops: number; risk?: boolean }>;
  const tasks = seed.tasks as Array<{ task_type: string; status: string }>;
  return [
    {
      label: 'Active runs',
      key: 'active_runs',
      value: runs.filter((r) => r.status !== 'completed' && r.status !== 'cancelled').length,
      delta: '+12 vs avg',
      tone: 'neutral',
      spark: [4, 8, 6, 9, 12, 11, 14],
    },
    {
      label: 'Stops in flight',
      key: 'stops',
      value: runs.reduce((s, r) => s + r.stops, 0),
      delta: '94% on-time',
      tone: 'good',
      spark: [22, 28, 30, 27, 35, 32, 38],
    },
    {
      label: 'At-risk SLA',
      key: 'at_risk',
      value:
        runs.filter((r) => r.risk).length +
        tasks.filter((t) => t.task_type === 'dispatch_exception_review' && t.status === 'open').length,
      delta: '↑ in last 15m',
      tone: 'warn',
      spark: [2, 1, 3, 4, 3, 5, 6],
    },
    { label: 'Failed attempts', key: 'failed', value: 14, delta: 'NDR queue · 6', tone: 'danger', spark: [1, 0, 2, 1, 2, 3, 1] },
    { label: 'Unassigned', key: 'unassigned', value: 23, delta: '4 partner-eligible', tone: 'info', spark: [5, 4, 6, 5, 7, 6, 8] },
    { label: 'Avg solve', key: 'avg_solve', value: '1.4s', delta: 'p95 · 3.8s', tone: 'neutral', spark: [1.2, 1.4, 1.3, 1.5, 1.2, 1.4, 1.4] },
  ];
}

function _resolveKpiTone(
  defn: Record<string, unknown> | undefined,
  value: number | null,
): KpiRollupResolution['tone'] {
  if (value === null || value === undefined) return 'neutral';
  const block = (defn?.tone_thresholds as Record<string, unknown> | undefined) ?? undefined;
  const fallback = (defn?.tone as KpiRollupResolution['tone'] | undefined) ?? 'neutral';
  if (!block) return fallback;
  const ga = typeof block.good_at_or_above === 'number' ? (block.good_at_or_above as number) : null;
  const wb = typeof block.warn_below === 'number' ? (block.warn_below as number) : null;
  const gb = typeof block.good_at_or_below === 'number' ? (block.good_at_or_below as number) : null;
  const wa = typeof block.warn_above === 'number' ? (block.warn_above as number) : null;
  const da = typeof block.danger_above === 'number' ? (block.danger_above as number) : null;
  // Higher-is-better
  if (ga !== null) {
    if (value >= ga) return 'good';
    if (wb !== null && value < wb) return 'danger';
    return 'warn';
  }
  // Lower-is-better
  if (gb !== null) {
    if (value <= gb) return 'good';
    if (da !== null && value > da) return 'danger';
    if (wa !== null && value > wa) return 'warn';
  }
  return fallback;
}

function _resolveKpiDelta(
  rollupMeta: Record<string, unknown> | undefined,
  defnMeta: Record<string, unknown> | undefined,
  todayValue: number | null,
  prevValue: number | null,
  format: string,
): string | null {
  const explicit = (rollupMeta?.delta_text as string | undefined) ?? null;
  if (explicit && explicit.trim()) return explicit;
  const label = (defnMeta?.delta_label as string | undefined) ?? '';
  if (todayValue === null || prevValue === null) return label || null;
  const diff = todayValue - prevValue;
  if (Math.abs(diff) < 0.0001) return label || null;
  const sign = diff > 0 ? '+' : '−';
  const abs = Math.abs(diff);
  let formatted: string;
  if (format === 'percent') formatted = `${sign}${abs.toFixed(1)} pts`;
  else if (format === 'duration_minutes') formatted = `${sign}${abs.toFixed(0)}m`;
  else if (format === 'duration_seconds') formatted = `${sign}${abs.toFixed(1)}s`;
  else formatted = `${sign}${Math.round(abs)}`;
  return label ? `${formatted} · ${label}` : formatted;
}

export async function compute_kpi_rollup_v1(
  args: ComputeKpiRollupArgs,
): Promise<KpiRollupResolution> {
  const client = getSupabaseClient();
  if (client) {
    // W44 cutover: use canonical (p_args jsonb) RETURNS jsonb sibling
    // `compute_kpi_rollup_v2` (migration 202605020200_w44_rpc_v2_normalizations.sql).
    // Envelope: { ok, rows: [<row>] } where each row matches the *_v1 RETURNS
    // TABLE shape. The exported adapter signature is unchanged.
    const { data, error } = await client.rpc('compute_kpi_rollup_v2', {
      p_args: {
        definition_key: args.definition_key,
        day: args.day ?? null,
        window_days: args.window_days ?? 1,
        scope_organization_id:
          args.scope?.organization_id ?? state.user.organization_id ?? null,
      },
    });
    if (error) {
      // Tolerate the canonical RPC not yet existing — fall through to the
      // direct-read path below so the surface remains functional during the
      // backend rollout window.
      if (!/function|not found|undefined|does not exist/i.test(error.message)) {
        throw new Error(error.message);
      }
    } else if (data) {
      const envelope = data as { ok?: boolean; rows?: unknown[] };
      const rows = Array.isArray(envelope?.rows) ? envelope.rows : [];
      const row = rows[0];
      if (row) return row as KpiRollupResolution;
    }
    if (!SEED_MODE_ENABLED) throw new Error(`KPI rollup did not return a row for ${args.definition_key}`);
  }
  if (!SEED_MODE_ENABLED) throw liveBackendUnavailableError('RPC compute_kpi_rollup_v1');
  await sleep(20);

  const orgId = args.scope?.organization_id ?? state.user.organization_id ?? null;
  const defs = (RESOURCE_DATA().kpi_definitions ?? []) as Array<{
    key: string;
    organization_id: string;
    name: string;
    unit: string | null;
    definition: Record<string, unknown>;
  }>;
  const rolls = (RESOURCE_DATA().kpi_rollups_daily ?? []) as Array<{
    organization_id: string;
    kpi_key: string;
    day: string;
    value_num: number | null;
    numerator: number | null;
    denominator: number | null;
    metadata: Record<string, unknown>;
  }>;

  const def = defs.find(
    (d) => d.key === args.definition_key && (orgId === null || d.organization_id === orgId),
  );
  if (!def) {
    throw new Error(`kpi_definition_not_found:${args.definition_key}`);
  }
  const matching = rolls
    .filter(
      (r) =>
        r.kpi_key === args.definition_key &&
        (orgId === null || r.organization_id === orgId),
    )
    .sort((a, b) => (a.day < b.day ? 1 : a.day > b.day ? -1 : 0));
  const target = args.day
    ? (matching.find((r) => r.day === args.day) ?? matching[0] ?? null)
    : (matching[0] ?? null);
  const previous = (matching[1] ?? null) as
    | { value_num: number | null; numerator: number | null; denominator: number | null; day: string }
    | null;

  const definition = (def.definition ?? {}) as Record<string, unknown>;
  const format = (definition.format as string | undefined) ?? 'integer';
  const groupKey = (definition.group as string | undefined) ?? 'general';

  const tone = _resolveKpiTone(definition, target?.value_num ?? null);
  const delta = _resolveKpiDelta(
    target?.metadata,
    definition,
    target?.value_num ?? null,
    previous?.value_num ?? null,
    format,
  );

  return {
    kpi_key: def.key,
    label: def.name,
    group: groupKey,
    value_num: target?.value_num ?? null,
    numerator: target?.numerator ?? null,
    denominator: target?.denominator ?? null,
    format,
    unit: def.unit ?? null,
    tone,
    delta,
    day: target?.day ?? null,
    scope_organization_id: orgId,
    settings_resolution_id: `srlv_kpi_${def.key}`,
  };
}

export async function compute_bank_account_balance_v1(
  args: ComputeBankAccountBalanceArgs,
): Promise<BankAccountBalanceResult> {
  const client = getSupabaseClient();
  if (client) {
    const { data, error } = await client.rpc('compute_bank_account_balance_v1', {
      p_args: { bank_account_id: args.bank_account_id },
    });
    if (error) throw new Error(error.message);
    if (data) return data as BankAccountBalanceResult;
    if (!SEED_MODE_ENABLED) throw new Error(`Bank balance did not return a row for ${args.bank_account_id}`);
  }
  if (!SEED_MODE_ENABLED) throw liveBackendUnavailableError('RPC compute_bank_account_balance_v1');
  await sleep(20);

  // Fallback: project from seed bank_accounts + finance_events_bank_statement
  // + bank_recon_matches. Mirrors the SQL contract in
  // 202604301110_compute_bank_account_balance_v1.sql:99-134.
  const accounts = (RESOURCE_DATA().bank_accounts ?? []) as Array<{
    id: string;
    organization_id?: string;
    currency?: string;
    balance?: number;
    last_match_at?: string | null;
    open_items?: number;
  }>;
  const account = accounts.find((a) => a.id === args.bank_account_id);
  if (!account) {
    throw new Error(`bank_account_not_found:${args.bank_account_id}`);
  }
  const statements = (RESOURCE_DATA().finance_events_bank_statement ?? []) as Array<{
    id: string;
    account_id?: string;
    direction?: 'in' | 'out';
    amount?: number;
    occurred_at?: string;
    attached?: boolean;
  }>;
  const matches = (RESOURCE_DATA().bank_recon_matches ?? []) as Array<{
    id: string;
    bank_statement_event_id?: string;
    status?: 'matched' | 'unmatched';
    updated_at?: string;
  }>;

  // Ledger-derived balance: sum(in) - sum(out) over this account's bank-statement events.
  const accountStatements = statements.filter((s) => s.account_id === args.bank_account_id);
  let derivedBalance = 0;
  for (const s of accountStatements) {
    const amt = typeof s.amount === 'number' ? s.amount : 0;
    if (s.direction === 'in') derivedBalance += amt;
    else if (s.direction === 'out') derivedBalance -= amt;
  }

  // Open items: bank_statement events without an active matched row.
  const matchedStatementIds = new Set(
    matches
      .filter((m) => m.status === 'matched' && m.bank_statement_event_id)
      .map((m) => m.bank_statement_event_id as string),
  );
  const derivedOpenItems = accountStatements.filter(
    (s) => !matchedStatementIds.has(s.id) && s.attached !== true,
  ).length;

  // Last match: MAX(updated_at) of matched matches whose statement event belongs to this account.
  const accountStatementIds = new Set(accountStatements.map((s) => s.id));
  let derivedLastMatchAt: string | null = null;
  for (const m of matches) {
    if (m.status !== 'matched') continue;
    if (!m.bank_statement_event_id || !accountStatementIds.has(m.bank_statement_event_id)) continue;
    const updated = m.updated_at ?? null;
    if (!updated) continue;
    if (derivedLastMatchAt === null || updated > derivedLastMatchAt) derivedLastMatchAt = updated;
  }

  // Tolerate empty-ledger demo seeds: prefer derived values when the seed
  // produced any bank-statement events for this account; otherwise fall back
  // to the seed's pre-computed snapshot (so demo cards keep showing data).
  const hasLedgerActivity = accountStatements.length > 0 || matches.length > 0;
  return {
    ok: true,
    bank_account_id: args.bank_account_id,
    organization_id: account.organization_id ?? state.user.organization_id ?? null,
    currency: account.currency ?? null,
    balance: hasLedgerActivity ? derivedBalance : (account.balance ?? 0),
    last_match_at: derivedLastMatchAt ?? account.last_match_at ?? null,
    open_items: hasLedgerActivity ? derivedOpenItems : (account.open_items ?? 0),
    correlation_id: `cor_demo_${args.bank_account_id}`,
    settings_resolution_id: `srlv_demo_${args.bank_account_id}`,
  };
}

export async function listDecisionLog(filters: LogFilter = {}): Promise<Record<string, unknown>[]> {
  const pageSize = filters.limit ?? 50;
  const liveFilters: Record<string, unknown> = {};
  if (filters.category) liveFilters.decision_category = filters.category;
  if (filters.id) liveFilters.id = filters.id;
  if (filters.resource_id) liveFilters.resource_id = filters.resource_id;
  if (filters.resource_type) liveFilters.resource_type = filters.resource_type;
  const live = await liveRpc<Record<string, unknown>>('ui_list_resource_v1', {
    p_resource: 'decision_log',
    p_filters: liveFilters,
    p_limit: pageSize,
    p_offset: 0,
    p_sort: { key: 'timestamp', direction: 'desc' },
  });
  if (live) {
    return normalizeLiveListResult<Record<string, unknown>>(live.data, 0, pageSize).rows;
  }

  await sleep(30);
  let rows = [...((seed.decision_log as Record<string, unknown>[]) ?? [])];
  if (filters.category) rows = rows.filter((r) => (r as { decision_category?: string }).decision_category === filters.category);
  if (filters.id) rows = rows.filter((r) => String((r as { id?: unknown }).id ?? '') === filters.id);
  if (filters.resource_id) rows = rows.filter((r) => String((r as { resource_id?: unknown }).resource_id ?? '') === filters.resource_id);
  if (filters.resource_type) rows = rows.filter((r) => String((r as { resource_type?: unknown }).resource_type ?? '') === filters.resource_type);
  if (filters.limit) rows = rows.slice(0, filters.limit);
  return rows;
}

export async function listResolutionLog(filters: LogFilter = {}): Promise<Record<string, unknown>[]> {
  const pageSize = filters.limit ?? 50;
  const live = await liveRpc<Record<string, unknown>>('ui_list_resource_v1', {
    p_resource: 'settings_resolution_log',
    p_filters: filters.category ? { category: filters.category } : {},
    p_limit: pageSize,
    p_offset: 0,
    p_sort: { key: 'resolved_at', direction: 'desc' },
  });
  if (live) {
    return normalizeLiveListResult<Record<string, unknown>>(live.data, 0, pageSize).rows;
  }

  await sleep(30);
  let rows = [...((seed.settings_resolution_log as Record<string, unknown>[]) ?? [])];
  if (filters.category) rows = rows.filter((r) => (r as { category?: string }).category === filters.category);
  if (filters.limit) rows = rows.slice(0, filters.limit);
  return rows;
}

export async function listAuditLog(filters: { limit?: number } = {}): Promise<Record<string, unknown>[]> {
  const pageSize = filters.limit ?? 50;
  const live = await liveRpc<Record<string, unknown>>('ui_list_resource_v1', {
    p_resource: 'audit_table_changes',
    p_filters: {},
    p_limit: pageSize,
    p_offset: 0,
    p_sort: { key: 'created_at', direction: 'desc' },
  });
  if (live) {
    return normalizeLiveListResult<Record<string, unknown>>(live.data, 0, pageSize).rows.map((row) => {
      const pk = row.pk;
      return {
        ...row,
        occurred_at: row.occurred_at ?? row.created_at,
        table: row.table ?? row.table_name,
        actor: row.actor ?? row.changed_by,
        pk: pk && typeof pk === 'object' && 'id' in pk ? (pk as { id?: unknown }).id : pk,
      };
    });
  }

  if (!hasCapability(CAP.AUDIT_LOG_READ)) {
    const err = new Error(`Capability denied: ${CAP.AUDIT_LOG_READ}`) as Error & {
      code?: string;
      capability?: string;
    };
    err.code = 'capability_denied';
    err.capability = CAP.AUDIT_LOG_READ;
    throw err;
  }
  await sleep(30);
  let rows = [...((seed.audit_log as Record<string, unknown>[]) ?? [])];
  if (filters.limit) rows = rows.slice(0, filters.limit);
  return rows;
}

export async function listUiEventLog(filters: { limit?: number } = {}): Promise<Record<string, unknown>[]> {
  const pageSize = filters.limit ?? 50;
  const live = await liveRpc<Record<string, unknown>>('ui_list_resource_v1', {
    p_resource: 'ui_event_log',
    p_filters: {},
    p_limit: pageSize,
    p_offset: 0,
    p_sort: { key: 'created_at', direction: 'desc' },
  });
  if (live) {
    return normalizeLiveListResult<Record<string, unknown>>(live.data, 0, pageSize).rows;
  }

  await sleep(30);
  let rows = [...((seed.ui_event_log as Record<string, unknown>[]) ?? [])];
  if (filters.limit) rows = rows.slice(0, filters.limit);
  return rows;
}

// ----------- Trace (canonical ui_get_trace_v1 envelope) -----------
//
// Mirrors `public.ui_get_trace_v1(uuid)` per
// `supabase/migrations/202601051630_ui_get_trace_v1.sql:6,56-62` — returns
// `{ correlation_id, observability_events, domain_events, workflow_runs }`.
// On Supabase swap, the live branch routes through `client.rpc(...)`. In
// demo mode we synthesize a representative 3-section envelope from a
// deterministic seed of the correlation_id so the FE renders something
// useful without backend.
//
// The legacy `{ spans: [...] }` shape (REAUDIT INSIGHTS §D3) is retired —
// the FE consumer now reads observability_events directly and treats each
// event as a timeline row.
export async function ui_get_trace_v1(correlationId: string): Promise<{
  correlation_id: string;
  observability_events: Array<Record<string, unknown>>;
  domain_events: Array<Record<string, unknown>>;
  workflow_runs: Array<Record<string, unknown>>;
}> {
  const live = await liveRpc<Record<string, unknown>>('ui_get_trace_v2', {
    p_args: { correlation_id: correlationId },
  });
  if (live) {
    // W44 cutover: use canonical (p_args jsonb) RETURNS jsonb sibling
    // `ui_get_trace_v2` (migration 202605020200_w44_rpc_v2_normalizations.sql).
    // Envelope: { ok, trace: { correlation_id, observability_events,
    // domain_events, workflow_runs } }. The exported adapter signature is
    // unchanged (still takes a string correlationId).
    const envelope = requireLiveRpcRecord(live.data, 'ui_get_trace_v2 returned no backend trace outcome');
    const outcomeError = backendOutcomeError(envelope, 'ui_get_trace_v2 was rejected by the backend');
    if (outcomeError) throw outcomeError;
    const env = objectRecord(envelope.trace);
    if (Object.keys(env).length === 0) {
      throw new Error('ui_get_trace_v2 did not return backend trace evidence');
    }
    const liveCorrelationId = asNonEmptyString(env.correlation_id) ?? asNonEmptyString(envelope.correlation_id);
    if (!liveCorrelationId) {
      throw new Error('ui_get_trace_v2 did not return backend correlation evidence');
    }
    return {
      correlation_id: liveCorrelationId,
      observability_events: (env.observability_events as Array<Record<string, unknown>>) ?? [],
      domain_events: (env.domain_events as Array<Record<string, unknown>>) ?? [],
      workflow_runs: (env.workflow_runs as Array<Record<string, unknown>>) ?? [],
    };
  }

  await sleep(60);
  // Demo synth — derive a small representative 3-section payload anchored on
  // the supplied correlation_id so the FE has stable rows to render.
  const baseTime = Date.now() - 30 * 1000;
  const observability_events = [
    {
      event_id: `oev_${correlationId}_1`,
      organization_id: state.user.organization_id ?? null,
      event_source: 'api_call_log',
      event_type: 'webhook.receive',
      resource_type: 'webhook_inbox',
      resource_id: `wbi_${correlationId.slice(0, 6)}`,
      correlation_id: correlationId,
      status: 'succeeded',
      event_time: new Date(baseTime).toISOString(),
      metadata: { method: 'POST', url: '/v1/webhook', response_status: 202, duration_ms: 28 },
    },
    {
      event_id: `oev_${correlationId}_2`,
      organization_id: state.user.organization_id ?? null,
      event_source: 'decision_log',
      event_type: 'workflow_dispatch',
      resource_type: 'workflow_run',
      resource_id: `wr_${correlationId.slice(0, 6)}`,
      correlation_id: correlationId,
      status: 'started',
      event_time: new Date(baseTime + 12).toISOString(),
      metadata: { decision_point: 'workflow.start_workflow_run', performed_by: 'orchestrator', duration_ms: 14 },
    },
    {
      event_id: `oev_${correlationId}_3`,
      organization_id: state.user.organization_id ?? null,
      event_source: 'decision_log',
      event_type: 'mapping_apply',
      resource_type: 'mapping_config',
      resource_id: `mp_exampleparcel_ksa_v3`,
      correlation_id: correlationId,
      status: 'succeeded',
      event_time: new Date(baseTime + 18).toISOString(),
      metadata: { decision_point: 'mapping.apply', performed_by: 'mapping-engine', duration_ms: 6 },
    },
    {
      event_id: `oev_${correlationId}_4`,
      organization_id: state.user.organization_id ?? null,
      event_source: 'decision_log',
      event_type: 'shipments_create',
      resource_type: 'shipment',
      resource_id: `shp_${correlationId.slice(0, 6)}`,
      correlation_id: correlationId,
      status: 'succeeded',
      event_time: new Date(baseTime + 22).toISOString(),
      metadata: { decision_point: 'shipments.create', performed_by: 'shipments-service', duration_ms: 4 },
    },
  ];
  const domain_events = [
    {
      id: `de_${correlationId}_1`,
      organization_id: state.user.organization_id ?? null,
      event_type: 'shipment.created',
      resource_type: 'shipment',
      resource_id: `shp_${correlationId.slice(0, 6)}`,
      correlation_id: correlationId,
      payload: { tracking_number: 'TR-DEMO-1' },
      created_at: new Date(baseTime + 24).toISOString(),
    },
  ];
  // W27-cycle-D §1 — workflow_runs.status canonical SSOT is the
  // workflow_run_status enum (pending|running|succeeded|failed|timeout|
  // cancelled). The legacy FE-projection alias `'completed'` is retired here;
  // emit the canonical `'succeeded'` value so insights/traces (and any other
  // consumer driven by the workflow_run_status lookup) renders the correct
  // tone without inline equality branches.
  const workflow_runs = [
    {
      id: `wr_${correlationId.slice(0, 6)}`,
      organization_id: state.user.organization_id ?? null,
      workflow_template_id: 'wt_exampleparcel_ksa_v3',
      status: 'succeeded',
      triggered_by_request_id: correlationId,
      created_at: new Date(baseTime + 12).toISOString(),
      completed_at: new Date(baseTime + 28).toISOString(),
    },
  ];
  return {
    correlation_id: correlationId,
    observability_events,
    domain_events,
    workflow_runs,
  };
}
