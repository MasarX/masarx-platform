// config.tsx — Configuration with Scope Ladder Visualizer, Compare scopes drawer, and
// Request change modal. Backed by api.getSettingsCategories() + useResolveSettings() +
// useProposeSettingsChange(). Compare-scopes renders only the category's allowed scopes.
// Request-change shows impact and diff preview, then persists justification.

import { useEffect, useMemo, useState, type CSSProperties } from 'react';
import { Button } from '@/components/Button';
import { Chip } from '@/components/Chip';
import { PageHeader } from '@/components/PageHeader';
import { ScopePill } from '@/components/ScopePill';
import { LadderViz } from '@/components/LadderViz';
import { StateView } from '@/components/StateView';
import {
  SettingsChangeForm,
  type SettingsChangePreviewResult,
  type SettingsScopeTypeRegistryRow as ScopeTypeRegistryRow,
} from '@/components/SettingsChangeForm';
import { useDrawer, useModal } from '@/hooks/useOverlay';
import { useResolveSettings, useProposeSettingsChange, useApplySettingsValue, useResourceList } from '@/lib/queries';
import { useCapability, useIdentity } from '@/lib/identity';
import { pushToast } from '@/components/toastStore';
import * as api from '@/lib/api';
import { CAP } from '@/lib/capabilities';
import { readConsoleScopeOverride, scopeContextFromOverride } from '@/lib/scope-url';
import { humanizeToken } from '@/lib/display-text';
import type { ScopeType, SettingsResolution } from '@/types/domain';

interface SettingsCategory {
  category: string;
  domain: string;
  scopes: ScopeType[];
  approval_required?: boolean;
  schema_id: string;
}

const SCOPE_BOX_GRID: CSSProperties = {
  display: 'grid',
  gap: '12px',
  padding: '12px 4px',
};

function normalizeSettingsCategory(row: Partial<SettingsCategory> & Record<string, unknown>): SettingsCategory {
  const metadata = row.metadata && typeof row.metadata === 'object' && !Array.isArray(row.metadata)
    ? (row.metadata as Record<string, unknown>)
    : {};
  const scopes = Array.isArray(row.scopes)
    ? row.scopes
    : Array.isArray(row.allowed_scopes)
      ? row.allowed_scopes
      : Array.isArray(metadata.scopes)
        ? metadata.scopes
        : [];
  const category = String(row.category ?? row.key ?? '');
  return {
    category,
    domain: String(row.domain ?? metadata.domain ?? 'General'),
    scopes: scopes.map((scope) => String(scope) as ScopeType),
    approval_required: Boolean(
      row.approval_required ??
      row.requires_approval ??
      row.side_effecting ??
      metadata.approval_required ??
      false,
    ),
    schema_id: String(row.schema_id ?? row.schema_category ?? metadata.schema_id ?? `${category}.v1`),
  };
}

// Compose the single-character "rank chip" deterministically from the
// canonical scope_type row set — uppercased first letter of `scope_type`,
// with disambiguation when multiple scope types share the same first letter
// (in the canonical seed: `source` and `sender` both start with 'S'). When
// a collision is detected, fall back to the second letter for the
// later-ranked row (canonical ordering = ascending `ladder_rank`).
function deriveScopeRankChip(rows: ScopeTypeRegistryRow[]): Record<string, string> {
  const sorted = [...rows].sort((a, b) => a.ladder_rank - b.ladder_rank);
  const used = new Set<string>();
  const map: Record<string, string> = {};
  for (const row of sorted) {
    const first = row.scope_type.charAt(0).toUpperCase();
    let chip = first;
    if (used.has(chip)) {
      // Collision — try second char (e.g. `source` → 'O' when `sender` → 'S').
      chip = (row.scope_type.charAt(1) || first).toUpperCase();
      // If even the second char is taken, fall back to '?' — the chip is
      // presentational; the canonical `ladder_rank` integer remains the
      // override-precedence authority.
      if (used.has(chip)) chip = '?';
    }
    used.add(chip);
    map[row.scope_type] = chip;
  }
  return map;
}

function ScopeBox({ label, rank, res }: { label: string; rank: string; res: SettingsResolution | null }) {
  return (
    <div className="card" style={{ padding: '10px' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: '6px', marginBottom: '8px' }}>
        <span className="scope-pill__rank">{rank}</span>
        <span>{label}</span>
        {res?.resolved_from && res.resolved_from !== (label.toLowerCase() as ScopeType) ? (
          <Chip label="inherit" size="xs" />
        ) : null}
      </div>
      <pre className="wf-code-block" style={{ margin: 0, fontSize: '10.5px', maxHeight: '160px' }}>
        {JSON.stringify(res?.value ?? '— inherit —', null, 2)}
      </pre>
      {res?.resolved_from ? (
        <div className="mono" style={{ fontSize: '10px', color: 'var(--ink-3)', marginTop: '6px' }}>
          {`resolved_from=${res.resolved_from}`}
        </div>
      ) : null}
    </div>
  );
}

// Phase G3 — reactive Compare-scopes modal body. Subscribes to
// `scope_type_registry` so display label + rank chip stay in sync with the
// canonical row set even when the registry resolves after the modal opens.
// Captured-at-click-time JSX snapshots would otherwise pin the labels to
// whatever the maps held at click moment (often empty during fast clicks).
const LARGE_RESOLVED_VALUE_JSON_LENGTH = 1200;

function safeJsonStringify(value: unknown): string {
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

function summarizeResolvedValue(value: unknown): string[] {
  if (Array.isArray(value)) {
    return [`${value.length} items`];
  }
  if (!value || typeof value !== 'object') {
    return [value == null ? 'No value' : String(value)];
  }

  const record = value as Record<string, unknown>;
  const keys = Object.keys(record);
  const summary = [`${keys.length} top-level keys`];
  for (const key of keys.slice(0, 6)) {
    const child = record[key];
    if (Array.isArray(child)) {
      summary.push(`${key}: ${child.length} items`);
    } else if (child && typeof child === 'object') {
      summary.push(`${key}: ${Object.keys(child as Record<string, unknown>).length} keys`);
    } else {
      summary.push(`${key}: ${String(child ?? 'empty')}`);
    }
  }
  if (keys.length > 6) summary.push(`+${keys.length - 6} more keys`);
  return summary;
}

function ResolvedValuePanel({ value }: { value: unknown }) {
  const json = safeJsonStringify(value);
  const isLarge = json.length > LARGE_RESOLVED_VALUE_JSON_LENGTH;

  if (!isLarge) {
    return (
      <pre
        className="mono"
        style={{
          background: 'var(--paper-3)',
          padding: '10px',
          borderRadius: '4px',
          fontSize: '11.5px',
          overflow: 'auto',
        }}
      >
        {json}
      </pre>
    );
  }

  return (
    <div data-testid="resolved-value-summary" style={{ display: 'grid', gap: '8px' }}>
      <div className="state__hint">
        Large saved policy value summarized for operator scanning. Full saved policy details are available below when needed.
      </div>
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: '6px' }}>
        {summarizeResolvedValue(value).map((item) => (
          <span key={item} className="chip chip--xs mono">
            {item}
          </span>
        ))}
      </div>
      <details>
        <summary className="mono" style={{ cursor: 'pointer', color: 'var(--accent-ink)' }}>
          Show full saved policy details
        </summary>
        <pre
          className="mono"
          data-testid="resolved-value-json"
          style={{
            background: 'var(--paper-3)',
            padding: '10px',
            borderRadius: '4px',
            fontSize: '11.5px',
            overflow: 'auto',
            maxHeight: '280px',
          }}
        >
          {json}
        </pre>
      </details>
    </div>
  );
}

function CompareScopesBody({
  allowed,
  results,
}: {
  allowed: ScopeType[];
  results: Array<SettingsResolution | null>;
}) {
  const scopeRegistryQuery = useResourceList<ScopeTypeRegistryRow>('scope_type_registry');
  const scopeRows = scopeRegistryQuery.data?.rows ?? [];
  const scopeLabelByType = scopeRows.reduce<Record<string, string>>((acc, row) => {
    acc[row.scope_type] =
      row.scope_type.charAt(0).toUpperCase() + row.scope_type.slice(1);
    return acc;
  }, {});
  const scopeRankByType = deriveScopeRankChip(scopeRows);
  const cols = `repeat(${Math.max(1, allowed.length)}, 1fr)`;
  return (
    <div data-testid="compare-scopes">
      <p className="state__hint">
        Resolves the same setting at every scope this category allows. Lower scopes override higher ones;
        "inherit" means no row exists at that scope (fall through to ladder).
      </p>
      <div style={{ ...SCOPE_BOX_GRID, gridTemplateColumns: cols }}>
        {allowed.map((s, i) => (
          <ScopeBox
            key={s}
            label={
              scopeLabelByType[s] ??
              // Pre-load fallback: deterministic title-case from `scope_type`
              // itself. Stays SSOT-faithful (the row's primary key IS the
              // canonical scope identifier) and avoids visual flicker when
              // the registry resolves after the modal opens.
              s.charAt(0).toUpperCase() + s.slice(1)
            }
            rank={scopeRankByType[s] ?? s.charAt(0).toUpperCase()}
            res={results[i] ?? null}
          />
        ))}
      </div>
    </div>
  );
}

export function ConfigModule() {
  const canRead = useCapability(CAP.SETTINGS_READ);
  const { scope } = useIdentity();
  const drawer = useDrawer();
  const modal = useModal();
  const propose = useProposeSettingsChange();
  const applySettings = useApplySettingsValue();
  const requestedScope = useMemo(() => readConsoleScopeOverride(), []);
  const requestedCategory = useMemo(() => {
    if (typeof window === 'undefined') return '';
    return new URLSearchParams(window.location.search).get('category') ?? '';
  }, []);

  // CLAIM-OBJECTIVES-LADDER (Phase G3) — `scope_type_registry` is the SSOT
  // for override-ladder rank + scope catalog (Global 0 < Tenant 10 < Client
  // 20 < Sender 30 < Source/Resource 40). Modal bodies + form components
  // each subscribe to the registry independently via `useResourceList` so
  // they stay reactive when the registry resolves after their JSX is
  // captured (modal.open() snapshots the body at click time).
  // W34c — module-level scope catalog used by openCompareScopes() so the
  // fallback when `selected.scopes` is null/empty is derived from the
  // canonical registry (sorted ascending by ladder_rank), not an inline
  // ['global','tenant','client','sender'] literal.
  const moduleScopeRegistryQuery = useResourceList<ScopeTypeRegistryRow>('scope_type_registry');
  const canonicalScopeOrder = useMemo<string[]>(() => {
    const rows = moduleScopeRegistryQuery.data?.rows ?? [];
    return rows.slice().sort((a, b) => a.ladder_rank - b.ladder_rank).map((r) => r.scope_type);
  }, [moduleScopeRegistryQuery.data]);

  const categoriesQuery = useResourceList<Record<string, unknown>>('settings_category_registry', {
    page_size: 500,
    sort: { key: 'category', dir: 'asc' },
  });
  const cats = useMemo<SettingsCategory[]>(() => {
    const liveRows = categoriesQuery.data?.rows ?? [];
    const rows = liveRows.length > 0
      ? liveRows
      : ((api.getSettingsCategories() as Array<Record<string, unknown>>) || []);
    return rows.map((row) => normalizeSettingsCategory(row)).filter((row) => row.category);
  }, [categoriesQuery.data]);

  const grouped = useMemo<Record<string, SettingsCategory[]>>(() => {
    return cats.reduce<Record<string, SettingsCategory[]>>((acc, c) => {
      (acc[c.domain] = acc[c.domain] || []).push(c);
      return acc;
    }, {});
  }, [cats]);

  const initial = useMemo(
    () =>
      cats.find((c) => c.category === requestedCategory) ??
      cats.find((c) => c.category === 'pod.required_evidence') ??
      cats[0] ??
      null,
    [cats, requestedCategory]
  );
  const [selected, setSelected] = useState<SettingsCategory | null>(initial);

  useEffect(() => {
    const requested = requestedCategory
      ? cats.find((c) => c.category === requestedCategory)
      : null;
    if (requested && selected?.category !== requested.category) {
      setSelected(requested);
      return;
    }
    if (!selected && initial) setSelected(initial);
  }, [cats, selected, initial, requestedCategory]);

  const activeScopeContext = useMemo(
    () =>
      scopeContextFromOverride(requestedScope) ??
      (scope.tenant?.id
        ? { tenant: { id: scope.tenant.id }, organization_id: scope.tenant.id }
        : undefined),
    [requestedScope, scope.tenant?.id],
  );

  const { data: resolution } = useResolveSettings(selected?.category ?? '', activeScopeContext);

  const scopeIdForType = (scopeType: ScopeType): string => {
    if (requestedScope?.scopeType === scopeType && requestedScope.scopeId) return requestedScope.scopeId;
    switch (scopeType) {
      case 'global':
        return 'global';
      case 'tenant':
        return scope.tenant?.id ?? '';
      case 'client':
        return scope.client?.id ?? '';
      case 'sender':
        return scope.sender?.id ?? '';
      case 'source':
        return scope.source?.id ?? '';
      case 'resource':
        return scope.resource?.id ?? '';
      default:
        return '';
    }
  };

  const openCompareScopes = () => {
    if (!selected) return;
    // W34c — fallback derives from canonical `scope_type_registry`. When the
    // category does not declare an explicit scopes whitelist AND the registry
    // hasn't resolved yet, the comparator renders no rows rather than a
    // synthesized literal ladder.
    const allowed = selected.scopes ?? canonicalScopeOrder;
    // Compare-scopes samples derive from the active identity scope chain
    // (seed mode populates from seed.current_scope; live mode from real
    // session). No hardcoded client/sender/source/resource placeholders —
    // empty ids signal "scope not present in current identity" and the
    // CompareScopesBody renders that scope as unresolved (W50 closure
    // mirrors the W22b pattern for tenant/client/sender ids).
    const samples: Record<string, Record<string, { id: string }>> = {
      global: { global: { id: scopeIdForType('global') } },
      tenant: { tenant: { id: scopeIdForType('tenant') } },
      client: { client: { id: scopeIdForType('client') } },
      sender: { sender: { id: scopeIdForType('sender') } },
      source: { source: { id: scopeIdForType('source') } },
      resource: { resource: { id: scopeIdForType('resource') } },
    };
    Promise.all(allowed.map((s) => api.resolveSettings(selected.category, samples[s] ?? samples.global)))
      .then((results) => {
        modal.open({
          title: `Compare scopes · ${selected.category}`,
          // CompareScopesBody subscribes to `scope_type_registry` so display
          // labels + rank chips stay reactive (the captured JSX snapshot
          // would otherwise pin labels to whatever the parent maps held at
          // click time — empty if the registry hasn't loaded yet).
          body: (
            <CompareScopesBody
              allowed={allowed}
              results={results as Array<SettingsResolution | null>}
            />
          ),
          footer: <Button label="Close" kind="ghost" onClick={() => modal.close()} />,
        });
      })
      .catch(() => pushToast('Compare scopes failed', 'danger'));
  };

  const openChangeRequest = () => {
    if (!selected) return;
    modal.open({
      title: 'Request settings change',
      body: (
        <SettingsChangeForm
          category={selected.category}
          // W54-D — fallback derives from canonical `scope_type_registry`
          // (already resolved into `canonicalScopeOrder` above, sorted by
          // ladder_rank). Replaces the inline literal
          // `['global', 'tenant', 'client', 'sender']`. AGENTS.md §2 (ZERO
          // HARDCODING) + §4 (SSOT).
          allowedScopes={selected.scopes ?? canonicalScopeOrder}
          defaultScopeType={requestedScope?.scopeType as ScopeType | undefined}
          initialValue={resolution?.value}
          canAutoApply={!selected.approval_required}
          onClose={() => modal.close()}
          onSubmit={async ({ scopeType, value, justification, dryRun }) => {
            try {
              const parsed = JSON.parse(value);
              const scopeId = scopeIdForType(scopeType);
              const res = (await propose.mutateAsync({
                category: selected.category,
                scope: { [scopeType]: { id: scopeId } },
                value: parsed,
                dryRun,
                justification,
              })) as SettingsChangePreviewResult;
              pushToast(dryRun ? 'Change preview ready' : 'Change request submitted', 'good');
              if (!dryRun) modal.close();
              return res;
            } catch (err) {
              pushToast(
                'Change preview could not be prepared. Review the setting details and try again.',
                'danger'
              );
              return undefined;
            }
          }}
          onApply={async ({ scopeType, value, justification }) => {
            try {
              const parsed = JSON.parse(value);
              const scopeId = scopeIdForType(scopeType);
              const res = await applySettings.mutateAsync({
                category: selected.category,
                scope: { [scopeType]: { id: scopeId } },
                value: parsed,
                justification,
              });
              pushToast(
                'Setting applied',
                'good'
              );
              modal.close();
              return res;
            } catch (err) {
              pushToast(
                'Setting could not be applied. Review the setting details and try again.',
                'danger'
              );
              return undefined;
            }
          }}
        />
      ),
    });
  };

  const tenantId = requestedScope?.scopeType === 'tenant' ? requestedScope.scopeId : scope.tenant?.id;

  if (!canRead) {
    return (
      <div className="page">
        <PageHeader
          moduleKey="config"
          eyebrow="Platform"
          titleAccent="Configuration"
          titlePlain="— scope ladder"
          pills={[
            tenantId ? <ScopePill scopeType="tenant" scopeId={tenantId} /> : null,
            <span className="chip chip--xs">Policy resolver</span>,
          ].filter(Boolean) as React.ReactNode[]}
        />
        <StateView
          kind="denied"
          capability={CAP.SETTINGS_READ}
          hint="You do not have permission to view configuration & scope ladder."
        />
      </div>
    );
  }

  return (
    <div className="page">
      <PageHeader
        moduleKey="config"
        eyebrow="Platform"
        titleAccent="Configuration"
        titlePlain="— scope ladder"
        pills={[
          tenantId ? <ScopePill scopeType="tenant" scopeId={tenantId} /> : null,
          <span className="chip chip--xs">Policy resolver</span>,
        ].filter(Boolean) as React.ReactNode[]}
        actions={[
          <Button label="Compare scopes" iconName="git" kind="ghost" onClick={openCompareScopes} />,
          <Button
            label="Request change"
            iconName="edit"
            kind="primary"
            anyCapabilities={[CAP.SETTINGS_WRITE, CAP.SYSTEM_WRITE]}
            onClick={openChangeRequest}
          />,
        ]}
      />

      <div
        style={{
          flex: 1,
          display: 'grid',
          gridTemplateColumns: '280px 1fr',
          minHeight: 0,
          overflow: 'hidden',
        }}
      >
        <div
          style={{
            borderRight: '1px solid var(--line)',
            overflow: 'auto',
            background: 'var(--paper)',
          }}
        >
          {Object.entries(grouped).map(([domain, list]) => (
            <div key={domain}>
              <div className="section-eyebrow">{domain}</div>
              {list.map((c) => {
                const isActive = selected?.category === c.category;
                return (
                  <button
                    key={c.category}
                    type="button"
                    className="nav-item"
                    style={{
                      width: 'calc(100% - 16px)',
                      margin: '0 8px',
                      textAlign: 'left',
                      background: isActive ? 'var(--accent-soft)' : 'transparent',
                      color: isActive ? 'var(--accent-ink)' : 'var(--ink-2)',
                      display: 'flex',
                      alignItems: 'center',
                      gap: '6px',
                    }}
                    onClick={() => setSelected(c)}
                    data-testid={`config-cat-${c.category}`}
                  >
                    <span className="mono" style={{ fontSize: '11px' }}>
                      {c.category}
                    </span>
                    <div style={{ flex: 1 }} />
                    {c.approval_required ? (
                      <span className="chip chip--info chip--xs" title="approval-required">~</span>
                    ) : null}
                  </button>
                );
              })}
            </div>
          ))}
        </div>

        <div
          style={{
            overflow: 'auto',
            padding: '16px',
            display: 'flex',
            flexDirection: 'column',
            gap: '14px',
          }}
        >
          {!selected ? (
            <StateView kind="empty" hint="No settings categories registered." />
          ) : !resolution ? (
            <StateView kind="loading" />
          ) : (
            <>
              <div className="card">
                <div className="eyebrow">Setting</div>
                <div style={{ display: 'flex', alignItems: 'center', gap: '8px', marginTop: '4px', flexWrap: 'wrap' }}>
                  <span
                    style={{
                      fontFamily: 'var(--font-display)',
                      fontWeight: 600,
                      fontSize: '18px',
                      letterSpacing: '-0.015em',
                    }}
                  >
                    {selected.category}
                  </span>
                  <span className="chip chip--xs mono" title="schema id (server-side ajv-validates here)">{selected.schema_id}</span>
                  {selected.approval_required ? (
                    <span className="chip chip--info chip--xs">approval-required</span>
                  ) : (
                    <span className="chip chip--xs">auto-apply</span>
                  )}
                  <div style={{ flex: 1 }} />
                  <span className="mono" style={{ fontSize: '10.5px', color: 'var(--ink-3)' }}>
                    {`scopes: ${(selected.scopes ?? []).join(' · ')}`}
                  </span>
                </div>
                <div style={{ marginTop: '8px', display: 'flex', alignItems: 'center', gap: '8px', flexWrap: 'wrap' }}>
                  {/* W-Cycle-E (P2 #12) — derive the canonical winning
                      scope_id from `resolution.ladder_path` (the entry whose
                      `scope_type` matches `resolved_from`). The prior code
                      hardcoded `global`-vs-`tenantId` and silently fell
                      through to '' for client/sender/source/resource
                      winners. Render an explicit error chip when the
                      projection is missing the ladder entry rather than
                      masking the gap. */}
                  {(() => {
                    const winning = resolution.ladder_path.find(
                      (p) => p.scope_type === resolution.resolved_from,
                    );
                    if (!winning || (winning.scope_id == null && winning.scope_type !== 'global')) {
                      return (
                        <StateView
                          kind="error"
                          hint="The saved policy source is missing required scope details."
                        />
                      );
                    }
                    return (
                      <ScopePill
                        scopeType={resolution.resolved_from}
                        scopeId={winning.scope_id ?? undefined}
                      />
                    );
                  })()}
                  <span className="mono" style={{ fontSize: '11px', color: 'var(--ink-3)' }}>
                    Resolution recorded
                  </span>
                  <a
                    href={`/insights/resolutions?category=${encodeURIComponent(selected.category)}`}
                    className="chip chip--xs mono"
                    style={{ textDecoration: 'none' }}
                    data-testid="config-resolution-log-link"
                  >
                    Open policy history
                  </a>
                </div>
                {resolution.override_of ? (
                  <div className="chip chip--warn chip--xs" style={{ marginTop: '8px' }}>
                    {`Override: ${resolution.resolved_from} replaces ${resolution.override_of}`}
                  </div>
                ) : null}
                <h4 className="eyebrow" style={{ marginTop: '12px' }}>
                  Resolved value
                </h4>
                <ResolvedValuePanel value={resolution.value} />
              </div>

              <div className="eyebrow">Scope ladder</div>
              <LadderViz resolution={resolution} />

              <div className="eyebrow">Related workflows</div>
              <div className="card mono" style={{ fontSize: '11px' }}>
                {`${humanizeToken(selected.category, 'Selected policy')} resolves at the ${resolution.resolved_from} scope. Related workflows use this saved policy decision automatically.`}
              </div>
            </>
          )}
        </div>
      </div>

      {drawer.node}
      {modal.node}
    </div>
  );
}
