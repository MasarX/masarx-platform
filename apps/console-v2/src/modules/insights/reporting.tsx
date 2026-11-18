// reporting.tsx — Insights · Reporting (KPI dashboards).
//
// Phase F1 / CLAIM-INSIGHTS-REPORTING. Every grouped card on this surface now
// resolves through the canonical KPI catalog + daily rollups projection in
// supabase/migrations/202601311830_kpi_catalog_rollups_v1.sql:
//   • public.kpi_definitions   (canonical key + name + unit + tone thresholds)
//   • public.kpi_rollups_daily (canonical value_num + numerator + denominator)
//
// W50 — The card list is row-driven from the canonical `kpi_definitions`
// resource (`useResourceList<KpiDefinitionRow>('kpi_definitions')`). Section
// eyebrows derive from the canonical `kpi_group` lookup so adding/removing a
// KPI requires only updating the canonical seed/migration — no parallel
// FE registry. The hook `useKpiRollup(definition_key, { scope })` resolves
// each card's value, tone and delta string via `compute_kpi_rollup_v1`
// (data-source adapter; the production swap-seam routes through
// `client.rpc(...)`). Tenant scope is pulled from `useIdentity()` so every
// read is isolated to the caller's organization (RLS-safe; no hardcoded
// tenant ids).
//
// The previous static/proj `source` chip is gone — all cards now render the
// `proj` (canonical projection) state because every value comes from the
// canonical projection. If a definition_key has no rollup row, the card
// renders "—" with neutral tone instead of inventing a literal number.
//
// Capability gate: surface-level `insights.read` (declared in registry.js
// capabilities array; navigation.js `insights → reporting`).

import { useMemo, type CSSProperties, type ReactElement } from 'react';
import { PageHeader } from '@/components/PageHeader';
import { Chip } from '@/components/Chip';
import { KPICard, type KPITone } from '@/components/KPICard';
import { StateView } from '@/components/StateView';
import { useDashboardKpis, useKpiRollup, useResourceList } from '@/lib/queries';
import { useI18n } from '@/lib/i18n';
import { useIdentity, useCapability } from '@/lib/identity';
import type { KpiRollupResolution } from '@/lib/api';
import { CAP } from '@/lib/capabilities';
import { getLookups, lookupRow } from '@/lib/api';

// W30 — `KpiRollupDirectoryRow` mirrors the SQL view
// `public.v_kpi_rollup_directory` (supabase/migrations/202604302800_v_kpi_rollup_directory.sql).
// Read-only projection; consumed additively as a freshness / catalog summary
// chip source. The canonical SSOT seam for per-card resolution stays
// `useKpiRollup(definition_key, { scope })` (compute_kpi_rollup_v1 + the base
// kpi_definitions / kpi_rollups_daily tables).
interface KpiRollupDirectoryRow extends Record<string, unknown> {
  id: string;
  kpi_key: string;
  kpi_label: string | null;
  group_label: string | null;
  format: string | null;
  value_num: number | null;
  scope_label: string | null;
  is_active: boolean;
  is_fresh: boolean;
  is_stale: boolean;
  has_rollup: boolean;
}

// W50 — KPI card catalog derives from canonical `kpi_definitions` resource
// (already registered in data-source.ts; mirrors public.kpi_definitions). The
// previous parallel registry of 12 hardcoded definition_key + group bindings
// is gone — every card now resolves from the canonical row's `key` and the
// `definition.group` jsonb projection. Group section labels resolve from the
// canonical `kpi_group` lookup (lookupRow('kpi_group', group)?.label).
//
// Adding or removing a card now requires only updating the canonical
// kpi_definitions seed/migration; the FE no longer has to know about the
// individual KPIs. Active-only filtering keeps deactivated rows out of the
// surface without a parallel allow-list.
interface KpiDefinitionRow extends Record<string, unknown> {
  /** SSOT: kpi_definitions.id */
  id: string;
  /** SSOT: kpi_definitions.key (matches kpi_rollups_daily.kpi_key). */
  key: string;
  /** SSOT: kpi_definitions.is_active */
  is_active?: boolean;
  /** SSOT: kpi_definitions.definition jsonb (carries `group` etc.). */
  definition?: Record<string, unknown>;
}

type KpiGroup = string;
interface KpiCardDef {
  definition_key: string;
  group: KpiGroup;
}

function groupOfDefinition(row: KpiDefinitionRow): string {
  const g = row.definition?.['group'];
  return typeof g === 'string' && g.length > 0 ? g : '';
}

const GRID_STYLE: CSSProperties = {
  display: 'grid',
  gridTemplateColumns: 'repeat(auto-fit, minmax(280px, 1fr))',
  gap: '12px',
  padding: '16px',
  overflow: 'auto',
  flex: 1,
};

const SPAN_FULL_ROW: CSSProperties = { gridColumn: '1 / -1' };
const SECTION_HEADER_STYLE: CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: '8px',
};

interface KpiRollupCardProps {
  definition_key: string;
  scopeOrgId: string | null;
}

/**
 * Renders a single KPI card driven by `useKpiRollup`. Stays a tiny leaf
 * component so each card is its own React Query subscription — invalidating
 * one rollup (e.g. a worker job rolling forward) doesn't refetch the others.
 */
function KpiRollupCard({ definition_key, scopeOrgId }: KpiRollupCardProps): ReactElement {
  const { fmtNumber } = useI18n();
  const { data, isLoading, isError } = useKpiRollup(definition_key, {
    scope: { organization_id: scopeOrgId },
  });
  return (
    <div data-testid={`kpi-card-${definition_key}`} style={{ display: 'contents' }}>
      <KPICard
        label={data?.label ?? definition_key}
        value={renderKpiValue(data, isLoading, isError, fmtNumber)}
        tone={resolveTone(data, isLoading, isError)}
        delta={data?.delta ?? undefined}
      />
    </div>
  );
}

// W-Cycle-E (P2 #10) — kpi format taxonomy (suffix + decimals) is row-driven
// via the canonical `kpi_format` lookup catalog (lookups.js). Replaces the
// prior inline `switch (data.format) { case 'percent': ... }` block, so
// adding a new format ("currency_sar"/"per_thousand"/...) is a lookup
// mutation rather than a code change. Missing canonical row falls through
// to numeric formatting so the operator still sees the value.
function renderKpiValue(
  data: KpiRollupResolution | undefined,
  isLoading: boolean,
  isError: boolean,
  fmtNumber: (n: number) => string,
): string {
  if (isLoading) return '…';
  if (isError || !data || data.value_num === null) return '—';
  const meta = (lookupRow('kpi_format', data.format)?.metadata ?? null) as
    | { suffix?: string; decimals?: number | null }
    | null;
  if (!meta) {
    // Missing canonical row — numeric default with 2-decimal precision so the
    // operator still sees the underlying value while the gap surfaces
    // through the missing lookup row (catch in pgTAP/lookup-parity test).
    return fmtNumber(roundTo(data.value_num, 2));
  }
  const decimals = meta.decimals;
  const formatted =
    decimals == null
      ? fmtNumber(Math.round(data.value_num))
      : fmtNumber(roundTo(data.value_num, decimals));
  return `${formatted}${meta.suffix ?? ''}`;
}

function resolveTone(
  data: KpiRollupResolution | undefined,
  isLoading: boolean,
  isError: boolean,
): KPITone {
  if (isLoading) return 'neutral';
  if (isError || !data) return 'neutral';
  return (data.tone as KPITone) ?? 'neutral';
}

function roundTo(value: number, decimals: number): number {
  const factor = 10 ** decimals;
  return Math.round(value * factor) / factor;
}

export function ReportingModule(): ReactElement {
  const { fmtNumber } = useI18n();
  const { user, currentTenantId } = useIdentity();
  const scopeOrgId = currentTenantId() ?? user?.organization_id ?? null;
  const canRead = useCapability(CAP.INSIGHTS_READ);
  const { data: kpis, isLoading, isError } = useDashboardKpis();

  // W30 — paired projection view `public.v_kpi_rollup_directory`
  // (supabase/migrations/202604302800_v_kpi_rollup_directory.sql) surfaces
  // per-definition derivations: kpi_label / group_label / format / scope_label
  // (resolved from definition jsonb + dimensions JSONB), plus lifecycle
  // booleans (is_active / is_fresh / is_stale / has_rollup). Consumed
  // additively as a freshness indicator chip source — the canonical
  // per-card resolution path stays `useKpiRollup(definition_key)`.
  const directoryQuery = useResourceList<KpiRollupDirectoryRow>('kpi_rollup_directory');
  const directory = useMemo(
    () => directoryQuery.data?.rows ?? [],
    [directoryQuery.data],
  );

  const directoryStats = useMemo(() => {
    let total = 0;
    let active = 0;
    let withRollup = 0;
    let fresh = 0;
    let stale = 0;
    for (const row of directory) {
      total += 1;
      if (row.is_active) active += 1;
      if (row.has_rollup) withRollup += 1;
      if (row.is_fresh) fresh += 1;
      if (row.is_stale) stale += 1;
    }
    return { total, active, withRollup, fresh, stale };
  }, [directory]);

  // W50 — Card catalog resolves from canonical `kpi_definitions` resource
  // (active rows only). Order is determined by canonical seed order; cards
  // populate within each group as definitions load. No parallel registry.
  const definitionsQuery = useResourceList<KpiDefinitionRow>('kpi_definitions');
  const definitions = useMemo<KpiDefinitionRow[]>(
    () => (definitionsQuery.data?.rows ?? []).filter((d) => d.is_active !== false),
    [definitionsQuery.data],
  );

  // Group section ordering derives from the canonical `kpi_group` lookup so
  // the section eyebrows render synchronously (independent of the async
  // kpi_definitions query). Cards within each group populate from the
  // canonical kpi_definitions rows as the query resolves.
  const groupOrder = useMemo<string[]>(() => {
    const rows = (getLookups('kpi_group') ?? []) as Array<{ value: string }>;
    return rows.map((r) => r.value);
  }, []);

  const groups = useMemo<Record<string, KpiCardDef[]>>(() => {
    const groupsOut: Record<string, KpiCardDef[]> = {};
    for (const g of groupOrder) groupsOut[g] = [];
    for (const row of definitions) {
      const group = groupOfDefinition(row);
      if (!group || !row.key) continue;
      if (!groupsOut[group]) groupsOut[group] = [];
      groupsOut[group].push({ definition_key: row.key, group });
    }
    return groupsOut;
  }, [definitions, groupOrder]);

  // W50 — Group labels resolve via canonical `kpi_group` lookup. Returns the
  // raw key (with first-letter uppercase fallback) when the canonical row is
  // missing so the operator sees the gap rather than a silent neutral default.
  function groupLabel(group: string): string {
    const row = lookupRow('kpi_group', group);
    if (row?.label) return row.label;
    if (!group) return '—';
    return group.charAt(0).toUpperCase() + group.slice(1);
  }

  if (!canRead) {
    return (
      <div className="page">
        <PageHeader
          moduleKey="reporting"
          eyebrow="Insights"
          titleAccent="Reporting"
          titlePlain="— operational summary"
        />
        <StateView
          kind="denied"
          capability={CAP.INSIGHTS_READ}
          hint="You do not have permission to view reporting projections (insights.read)."
        />
      </div>
    );
  }

  return (
    <div className="page">
      <PageHeader
        moduleKey="reporting"
        eyebrow="Insights"
        titleAccent="Reporting"
        titlePlain="— operational summary"
        pills={[
          <Chip
            key="src"
            label="kpi_rollups_daily"
            kind="good"
            size="xs"
            className="mono"
            title="All cards backed by the canonical kpi_definitions + kpi_rollups_daily projection"
          />,
          // W30 — Freshness summary pill, sourced from
          // `public.v_kpi_rollup_directory` (joined kpi_definitions +
          // most-recent kpi_rollups_daily). Surfaces fresh/total + stale
          // counts so operators can spot rollup-worker lag at a glance.
          directoryStats.total > 0 ? (
            <Chip
              key="freshness"
              label={`fresh ${directoryStats.fresh}/${directoryStats.total}${directoryStats.stale > 0 ? ` · ${directoryStats.stale} stale` : ''}`}
              kind={directoryStats.stale > 0 ? 'warn' : 'good'}
              size="xs"
              className="mono"
              data-testid="kpi-freshness-pill"
              title={`v_kpi_rollup_directory: ${directoryStats.fresh} fresh (<24h), ${directoryStats.withRollup} with rollups, ${directoryStats.active} active definitions`}
            />
          ) : null,
        ]}
        actions={[]}
      />

      {isError ? (
        <StateView kind="error" hint="Could not load dashboard projections." />
      ) : isLoading || !kpis ? (
        <StateView kind="loading" hint="Loading projections…" />
      ) : (
        <>
          <div className="kpi-strip" data-testid="kpi-strip-canonical">
            {kpis.map((k) => (
              <KPICard
                key={k.key}
                label={k.label}
                value={typeof k.value === 'number' ? fmtNumber(k.value) : k.value}
                tone={(k.tone as KPITone | undefined) ?? 'neutral'}
                delta={k.delta}
                spark={k.spark}
              />
            ))}
          </div>

          <div style={GRID_STYLE} data-testid="kpi-rollup-groups">
            {groupOrder.map((groupKey) => {
              const cards = groups[groupKey] ?? [];
              return (
                <div key={groupKey} style={{ display: 'contents' }}>
                  <div
                    style={{ ...SPAN_FULL_ROW, ...SECTION_HEADER_STYLE }}
                    className="section-eyebrow"
                    data-testid={`kpi-group-${groupKey}`}
                  >
                    <span>{groupLabel(groupKey)}</span>
                    <Chip
                      label="kpi_rollups_daily"
                      kind="good"
                      size="xs"
                      className="mono"
                      title="Backed by canonical kpi_definitions + kpi_rollups_daily projection"
                    />
                  </div>
                  {cards.map((c) => (
                    <KpiRollupCard
                      key={c.definition_key}
                      definition_key={c.definition_key}
                      scopeOrgId={scopeOrgId}
                    />
                  ))}
                </div>
              );
            })}
          </div>
        </>
      )}
    </div>
  );
}
