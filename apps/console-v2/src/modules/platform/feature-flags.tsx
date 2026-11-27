// platform/feature-flags.tsx — CLAIM-PLATFORM-FLAGS (Wave 3, Phase C).
//
// Operator feature-flag management surface — LaunchDarkly / Unleash /
// GrowthBook parity. DataTable + Editor drawer with `<LadderViz>` so the
// per-scope override path (Global → Tenant → Client → Sender) renders from the
// canonical `targeting.scopes` payload without fabricating ladder data at
// render time.
//
// Backend invariants honored:
//   - Reads via `useResourceList<FeatureFlag>('feature_flag_summary')` — the
//     paired projection view `public.v_feature_flag_summary` (W6-6 / W11-3).
//     RLS gated by `feature_flags.read`. SSOT remains `public.feature_flags`.
//   - All write actions (`New flag`, `Bulk toggle`, drawer mutations,
//     `Engage/Release kill switch`) are gated by `feature_flags.write` via the
//     shared `<Button capability={CAP.FEATURE_FLAGS_WRITE}>`. Buttons disabled +
//     CapabilityLock chip surfaces when the role lacks the capability — no
//     inline gate code in this module.
//   - Per-scope overrides come from `targeting.scopes` (LaunchDarkly Targeting
//     / Unleash Strategies parity); when missing, the LadderViz still resolves
//     a synthetic global-only step so the ladder is never empty.
//
// Operator UX:
//   - KPI strip: total / on / off / percentage / kill-switched.
//   - Page-header actions: "New flag" + "Bulk toggle" (both capability-gated).
//   - DataTable columns: flag key (mono) + label + status pill (with mini bar
//     for percentage rollouts) + targeting summary chip + owners + updated_at
//     + kill-switch icon when engaged.
//   - Editor drawer (5 tabs): Profile · Targeting (LadderViz + per-scope
//     toggle + rollout slider) · Rollout (full-flag percentage slider with
//     impact estimate chip) · History · Kill switch (big red toggle).

import { useMemo, useState, type ReactNode } from 'react';
import { Button } from '@/components/Button';
import { Chip, type ChipKind } from '@/components/Chip';
import { Dot } from '@/components/Dot';
import { Icon } from '@/components/Icon';
import { KPICard } from '@/components/KPICard';
import { KvGrid, type KvRow } from '@/components/KvGrid';
import { LadderViz } from '@/components/LadderViz';
import { PageHeader } from '@/components/PageHeader';
import { ScopePill } from '@/components/ScopePill';
import { StateView } from '@/components/StateView';
import {
  DataTable,
  type DataTableColumn,
  type DataTableAction,
  type DataTableBulkAction,
} from '@/components/DataTable';
import { useDrawer, useModal } from '@/hooks/useOverlay';
import { pushToast } from '@/components/toastStore';
import {
  useResourceList,
  useCreateFeatureFlag,
  useUpdateFeatureFlag,
  useEngageKillSwitch,
  useReleaseKillSwitch,
  useSetRollout,
  useBulkToggleFeatureFlags,
  useResolveSettings,
} from '@/lib/queries';
import { useCapability, useIdentity } from '@/lib/identity';
import { CAP } from '@/lib/capabilities';
import { lookupRow } from '@/lib/api';
import type { Scope, ScopeType, SettingsResolution } from '@/types/domain';
import { fill, useI18n, type Translate } from '@/lib/i18n';

type SettingsResolutionStep = SettingsResolution['ladder_path'][number];

// W-Cycle-E (P2 #7) — resolves the canonical scope identifier for a given
// ladder tier from the active identity scope chain. Replaces the prior
// hardcoded global/tenant/client/sender ternary cascade — the lookup is
// now driven by the `Scope` keyset (which itself mirrors
// `scope_type_registry`), so adding a new tier (source/resource/...)
// requires no module-side change.
function resolveScopeId(scopeType: string, scope: Scope): string {
  if (scopeType === 'global') return 'global';
  const target = (scope as Record<string, { id?: string } | undefined>)[scopeType];
  return target?.id ?? '';
}

// ---------- Domain types (UI-shaped) ----------
//
// W10-5 schema-drift remediation (PLATFORM §4) — Wave 6 / W6-6 closed the
// FeatureFlag drift via a backend projection rather than an FE rename. The
// canonical SSOT is the additive read-only view
// `public.v_feature_flag_summary` (migration 202604300100), which projects
// `public.feature_flags` (`name/enabled/rollout_percentage/conditions/...`)
// onto this exact FE-friendly shape:
//   • feature_flags.name                         → key
//   • initcap(replace(name, '_', ' '))           → label (humanized)
//   • CASE on (enabled, rollout_percentage)      → status ('on'/'off'/'percentage')
//   • jsonb_build_object('summary','scopes')     → targeting
//   • NOT enabled                                → kill_switch
//   • COALESCE(conditions->'owners', '[]')       → owners
//   • updated_at                                 → last_updated_at
//   • conditions->>'last_updated_by_user_id'     → last_updated_by_user_id
// All previously REMOVE/RENAME-flagged FE fields (label/kill_switch/owners/
// last_updated_at/last_updated_by_user_id) are now backed by this view, and
// `key` aliases the canonical `name` column. Mutations stay on the canonical
// `create_feature_flag_v1`, `update_feature_flag_v1`,
// `toggle_feature_flag_v1`, and `bulk_toggle_feature_flags_v1` RPCs.
// See __audit__/SCHEMA-DRIFT/PLATFORM.md §4 and the view migration for the
// authoritative projection contract.
// W-Cycle-E2 (P1 #3) — `scope_type` is now sourced as a wider `string` so the
// row interface can absorb any ladder tier registered in
// `scope_type_registry` (currently global/tenant/client/sender, but extensible
// to source/resource/...). The previous literal union was flagged as active
// "deferred coupling" — closed by widening here. Consumers that need to
// re-narrow MUST use canonical resolvers (e.g. `useResourceList<ScopeTypeRegistryRow>('scope_type_registry')`)
// instead of literal-type narrowing. AGENTS.md §2 (ZERO HARDCODING) +
// §4 (SSOT).
interface FeatureFlagScopeOverride {
  scope_type: string;
  scope_id: string;
  enabled: boolean;
  rollout_pct: number;
}

interface FeatureFlagTargeting {
  summary: string;
  scopes: FeatureFlagScopeOverride[];
}

interface FeatureFlag extends Record<string, unknown> {
  id: string;
  key: string;                         // SSOT: v_feature_flag_summary.key (= feature_flags.name)
  label: string;                       // SSOT: v_feature_flag_summary.label (humanized name)
  description?: string;                // SSOT: feature_flags.description
  status: 'on' | 'off' | 'percentage'; // SSOT: v_feature_flag_summary.status (CASE)
  rollout_percentage: number;          // SSOT: feature_flags.rollout_percentage
  targeting: FeatureFlagTargeting;     // SSOT: v_feature_flag_summary.targeting (jsonb_build_object)
  scope_type: string;                  // SSOT: feature_flags.scope_type (any registered ladder tier; widened from literal union — P1 #3)
  scope_id: string;                    // SSOT: feature_flags.scope_id
  kill_switch: boolean;                // SSOT: v_feature_flag_summary.kill_switch (NOT enabled)
  owners?: string[];                   // SSOT: v_feature_flag_summary.owners (conditions->'owners')
  last_updated_at?: string;            // SSOT: v_feature_flag_summary.last_updated_at (= updated_at)
  last_updated_by_user_id?: string;    // SSOT: v_feature_flag_summary.last_updated_by_user_id
}

// ---------- Helpers ----------

// W54-D — status pill tone + label resolve through canonical
// `feature_flag_status` lookup rows (seeded by platform-flags.js Object.assign
// extension). Kill-switch always overrides to `danger` per the platform
// invariant. Missing canonical row falls through to `danger`/`(missing)` so the
// gap is visible to operators rather than silently masked. AGENTS.md §2 (ZERO
// HARDCODING) + §4 (SSOT).
function statusKind(status: FeatureFlag['status'], killSwitch: boolean): ChipKind {
  if (killSwitch) return 'danger';
  const row = lookupRow('feature_flag_status', status);
  return ((row?.tone as ChipKind | undefined) ?? 'danger');
}

function statusLabel(status: FeatureFlag['status']): string {
  const row = lookupRow('feature_flag_status', status);
  return row?.label ?? `${status} (missing)`;
}

// CLAIM-OBJECTIVES-LADDER (Phase G3) — `scope_type_registry` is the SSOT for
// override-ladder ordering (Global 0 < Tenant 10 < Client 20 < Sender 30 <
// Source/Resource 40 in the canonical seed at
// supabase/migrations/202601301100_scope_registry_ssot.sql:267-298). FE
// surfaces resolve scope rank through `useResourceList('scope_type_registry')`
// rather than embedding inline `SCOPE_RANK` literals so the production swap is
// a single getSupabaseClient() branch flip — no module-side change required.
interface ScopeTypeRegistryRow {
  id: string;
  scope_type: string;
  description?: string;
  ladder_rank: number;
  is_enabled?: boolean;
}

// Synthesizes a `SettingsResolution` from a flag's `targeting.scopes` array so
// the shared `<LadderViz>` primitive renders the resolved Global → Tenant →
// Client → Sender path without bespoke per-flag visualization. Mirrors how
// `resolveSettings` in `data-source.ts` shapes its ladder_path. Receives the
// canonical ladder rank map (sourced from `scope_type_registry.ladder_rank`)
// so override-precedence ordering is row-driven, not literal-driven.
function buildLadderResolution(
  flag: FeatureFlag,
  scopeRankByType: Record<string, number>,
  completePct: number,
): SettingsResolution {
  const scopes = flag.targeting?.scopes ?? [];
  // W34c — order derives from canonical `scope_type_registry.ladder_rank`
  // (passed in via `scopeRankByType`). No inline `['global','tenant',...]`
  // literal; if the registry is empty we render an empty ladder rather than
  // synthesizing one. Sorted ascending so the rendered ladder reads
  // top-to-bottom in scope-rank order (Global → Tenant → Client → Sender).
  const order = (Object.keys(scopeRankByType) as Array<FeatureFlagScopeOverride['scope_type']>)
    .slice()
    .sort((a, b) => (scopeRankByType[a] ?? 0) - (scopeRankByType[b] ?? 0));

  // LadderViz reads `step.rank` to render the override-ladder row in
  // resolved-from order (highest specificity first). The canonical seed uses
  // step=10 increments (Global 0 < Tenant 10 < Client 20 < Sender 30), so we
  // surface that directly — no synthetic rank inversion.
  const ladder_path: SettingsResolutionStep[] = order.map((scopeType) => {
    const row = scopes.find((s) => s.scope_type === scopeType);
    return {
      rank: scopeRankByType[scopeType] ?? 0,
      scope_type: scopeType as ScopeType,
      scope_id: row?.scope_id ?? null,
      has_value: !!row,
      value: row
        ? row.enabled
          ? row.rollout_pct >= completePct
            ? 'on'
            : row.rollout_pct > 0
              ? `${row.rollout_pct}% rollout`
              : 'on'
          : 'off'
        : undefined,
    };
  });

  // Winning scope = the most-specific (highest ladder_rank) scope that has an
  // entry in `targeting.scopes`. Sort descending by canonical ladder_rank.
  const winning = [...scopes].sort(
    (a, b) => (scopeRankByType[b.scope_type] ?? 0) - (scopeRankByType[a.scope_type] ?? 0),
  )[0];

  return {
    category: `feature_flags.${flag.key}`,
    value: flag.status,
    resolved_from: (winning?.scope_type ?? 'global') as ScopeType,
    ladder_path,
    settings_resolution_id: `srlv_ff_${flag.id}`,
    override_of: null,
  };
}

// ---------- Status pill with mini rollout bar ----------

function StatusPill({ flag }: { flag: FeatureFlag }) {
  const { t } = useI18n();
  if (flag.kill_switch) {
    return (
      <span
        className="chip chip--danger chip--xs"
        data-testid={`ff-status-pill-${flag.id}`}
        title={t('platformFeatureFlags.statusPill.killSwitchEngagedFlag')}
      >
        <Icon name="warn" size={10} />
        <span style={{ marginLeft: 4 }}>{t('platformFeatureFlags.statusPill.killed')}</span>
      </span>
    );
  }
  // W71-Platform (Cycle F-R-11) closure — rollout-mode gate resolves
  // through canonical `feature_flag_status.metadata.is_rollout` instead
  // of an inline `'percentage'` literal compare. AGENTS.md §2 (ZERO
  // HARDCODING) + §6 (row-driven by configuration).
  if (lookupRow('feature_flag_status', flag.status ?? '')?.metadata?.is_rollout === true) {
    const pct = Math.max(0, Math.min(100, flag.rollout_percentage));
    return (
      <span
        className="chip chip--info chip--xs"
        data-testid={`ff-status-pill-${flag.id}`}
        style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}
      >
        <span>{`${pct}%`}</span>
        <span
          aria-hidden="true"
          style={{
            display: 'inline-block',
            width: 32,
            height: 4,
            borderRadius: 2,
            background: 'var(--paper-3)',
            position: 'relative',
            overflow: 'hidden',
          }}
        >
          <span
            style={{
              display: 'block',
              width: `${pct}%`,
              height: '100%',
              background: 'currentColor',
            }}
          />
        </span>
      </span>
    );
  }
  return (
    <span
      className={`chip chip--${statusKind(flag.status, flag.kill_switch)} chip--xs`}
      data-testid={`ff-status-pill-${flag.id}`}
    >
      {statusLabel(flag.status)}
    </span>
  );
}

// ---------- Editor drawer body ----------

function editorTabs(t: Translate) {
  return [
    { key: 'profile', label: t('platformFeatureFlags.editorDrawerBody.tabProfile') },
    { key: 'targeting', label: t('platformFeatureFlags.editorDrawerBody.tabTargeting') },
    { key: 'rollout', label: t('platformFeatureFlags.editorDrawerBody.tabRollout') },
    { key: 'history', label: t('platformFeatureFlags.editorDrawerBody.tabHistory') },
    { key: 'kill_switch', label: t('platformFeatureFlags.editorDrawerBody.tabKillSwitch') },
  ] as const;
}

type TabKey = ReturnType<typeof editorTabs>[number]['key'];

interface EditorDrawerProps {
  flag: FeatureFlag;
  onClose: () => void;
  completePct: number;
}

function EditorDrawerBody({ flag, onClose, completePct }: EditorDrawerProps) {
  const { t } = useI18n();
  const canWrite = useCapability(CAP.FEATURE_FLAGS_WRITE);
  const { scope } = useIdentity();
  const [tab, setTab] = useState<TabKey>('profile');
  // CLAIM-PLATFORM-FF / Phase C6 — canonical write hooks. Each persist
  // routes the appropriate mutation through the swap-seam.
  const updateMutation = useUpdateFeatureFlag();
  const setRolloutMutation = useSetRollout();
  const engageKillMutation = useEngageKillSwitch();
  const releaseKillMutation = useReleaseKillSwitch();

  // CLAIM-OBJECTIVES-LADDER (Phase G3) — `scope_type_registry.ladder_rank` is
  // the SSOT for override-precedence ordering (Global < Tenant < Client <
  // Sender). Reads via the canonical seam so the production swap is a single
  // getSupabaseClient() flip.
  const scopeRegistryQuery = useResourceList<ScopeTypeRegistryRow>('scope_type_registry');
  const scopeRankByType = useMemo<Record<string, number>>(() => {
    const rows = scopeRegistryQuery.data?.rows ?? [];
    return rows.reduce<Record<string, number>>((acc, row) => {
      acc[row.scope_type] = row.ladder_rank;
      return acc;
    }, {});
  }, [scopeRegistryQuery.data]);
  const scopeLabelByType = useMemo<Record<string, string>>(() => {
    const rows = scopeRegistryQuery.data?.rows ?? [];
    return rows.reduce<Record<string, string>>((acc, row) => {
      // Title-case the scope_type for display (e.g. "tenant" → "Tenant"). The
      // canonical seed `description` field is human-prose; the compact label
      // shown next to ScopePill is derived from `scope_type` directly so it
      // stays stable even if descriptions change.
      acc[row.scope_type] =
        row.scope_type.charAt(0).toUpperCase() + row.scope_type.slice(1);
      return acc;
    }, {});
  }, [scopeRegistryQuery.data]);

  // Per-scope overrides — start from the canonical seed and let the operator
  // toggle/slide. Mirrors LaunchDarkly's per-environment toggle UI.
  const initialScopes: FeatureFlagScopeOverride[] = useMemo(
    () => flag.targeting?.scopes ?? [],
    [flag.targeting?.scopes],
  );
  const [scopes, setScopes] = useState<FeatureFlagScopeOverride[]>(initialScopes);
  const [rollout, setRollout] = useState<number>(flag.rollout_percentage ?? 0);
  const [killEngaged, setKillEngaged] = useState<boolean>(flag.kill_switch);

  // Synthesize the ladder for the LadderViz from the LIVE editor state, not
  // the stale seed — that way operator edits flow into the visual immediately.
  const ladderResolution = useMemo(
    () => buildLadderResolution(
      { ...flag, targeting: { ...flag.targeting, scopes } },
      scopeRankByType,
      completePct,
    ),
    [flag, scopes, scopeRankByType, completePct],
  );

  // Impact estimate — lightweight heuristic so the operator gets feedback as
  // they slide the rollout bar. In production this would back onto the canonical
  // `request_settings_change_v1` dry-run preview path.
  // W-Cycle-E (P2 #7) — chip tone + label resolve through the canonical
  // `scope_type` lookup metadata (`impact_tone` + `impact_label`), driven by
  // the broadest enabled tier (lowest `scopeRankByType`). No inline ternary
  // ladder over hardcoded global/tenant/client/sender literals.
  const impactEstimate = useMemo(() => {
    if (killEngaged) return { kind: 'danger' as ChipKind, label: t('platformFeatureFlags.editorDrawerBody.killEngaged0Sessions') };
    const enabled = scopes.filter((s) => s.enabled);
    if (enabled.length === 0) return { kind: 'neutral' as ChipKind, label: t('platformFeatureFlags.editorDrawerBody.n0SessionsAffected') };
    // Pick the broadest enabled tier — lowest ladder_rank wins, mirroring the
    // canonical override-ladder semantics (the registry orders Global=0 first).
    const broadest = enabled
      .slice()
      .sort((a, b) => (scopeRankByType[a.scope_type] ?? 0) - (scopeRankByType[b.scope_type] ?? 0))[0];
    const meta = (lookupRow('scope_type', broadest!.scope_type)?.metadata ?? {}) as {
      impact_tone?: ChipKind;
      impact_label?: string;
    };
    return {
      kind: (meta.impact_tone ?? 'neutral') as ChipKind,
      label: `~${rollout}% of ${meta.impact_label ?? `${broadest!.scope_type} sessions`}`,
    };
  }, [killEngaged, rollout, scopes, scopeRankByType, t]);

  const profileRows: KvRow[] = useMemo(
    () => [
      { key: 'key', label: t('platformFeatureFlags.editorDrawerBody.key'), value: flag.key, mono: true },
      { key: 'label', label: t('platformFeatureFlags.editorDrawerBody.label'), value: flag.label },
      { key: 'description', label: t('platformFeatureFlags.editorDrawerBody.description'), value: flag.description ?? '' },
      {
        key: 'status',
        label: t('platformFeatureFlags.editorDrawerBody.status'),
        value: flag.status,
        lookup: 'feature_flag_status',
      },
      {
        key: 'scope_type',
        label: t('platformFeatureFlags.editorDrawerBody.scope'),
        value: flag.scope_type,
        lookup: 'feature_flag_scope',
      },
      { key: 'scope_id', label: t('platformFeatureFlags.editorDrawerBody.scopeId'), value: flag.scope_id, mono: true },
      {
        key: 'kill_switch',
        label: t('platformFeatureFlags.editorDrawerBody.killSwitch'),
        value: flag.kill_switch ? 'engaged' : 'off',
      },
      {
        key: 'last_updated_at',
        label: t('platformFeatureFlags.editorDrawerBody.updated'),
        value: flag.last_updated_at ?? '',
      },
    ],
    [flag, t],
  );

  // Persist routes to the canonical RPC for each editor action. The label
  // tags the toast so operators see which RPC fired (cutover observability).
  const persist = (label: 'update_targeting' | 'set_rollout') => {
    const onSuccess = () => {
      pushToast(`${label === 'update_targeting' ? 'update_feature_flag_v1' : 'set_rollout_v1'} · ${flag.key}`, 'good');
      onClose();
    };
    const onError = (err: Error) => pushToast(err.message, 'danger');
    if (label === 'update_targeting') {
      updateMutation.mutate(
        { feature_flag_id: flag.id, targeting: { scopes } },
        { onSuccess, onError },
      );
    } else {
      setRolloutMutation.mutate(
        { feature_flag_id: flag.id, rollout_percentage: rollout },
        { onSuccess, onError },
      );
    }
  };

  return (
    <div data-testid={`ff-editor-${flag.id}`}>
      {/* Header card */}
      <div className="card" style={{ padding: 12, marginBottom: 14 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
          <span
            className="mono"
            style={{
              fontFamily: 'var(--font-display)',
              fontSize: 16,
              fontWeight: 600,
              letterSpacing: '-0.015em',
            }}
          >
            {flag.key}
          </span>
          <StatusPill flag={flag} />
          <ScopePill scopeType={flag.scope_type} scopeId={flag.scope_id} />
          {(flag.owners ?? []).slice(0, 2).map((o) => (
            <Chip key={o} label={o} size="xs" />
          ))}
          <div style={{ flex: 1 }} />
          <span className="mono" style={{ fontSize: 11, color: 'var(--ink-3)' }}>
            {flag.id}
          </span>
        </div>
        <p className="state__hint" style={{ marginTop: 6 }}>
          {flag.description ?? '—'}
        </p>
      </div>

      {/* Tab strip */}
      <div className="dt-toolbar" data-testid="ff-editor-tabs">
        {editorTabs(t).map((entry) => (
          <button
            key={entry.key}
            type="button"
            className={`dt-tb-view-tab ${tab === entry.key ? 'is-active' : ''}`}
            onClick={() => setTab(entry.key)}
            data-testid={`ff-tab-${entry.key}`}
          >
            {entry.label}
          </button>
        ))}
      </div>

      {tab === 'profile' ? (
        <div data-testid="ff-tab-profile-pane">
          <KvGrid rows={profileRows} />
        </div>
      ) : null}

      {tab === 'targeting' ? (
        <div data-testid="ff-tab-targeting-pane">
          <p className="state__hint" style={{ marginTop: 0 }}>
            {t('platformFeatureFlags.editorDrawerBody.perScopeOverridesLaunchdarkly')}
          </p>
          <LadderViz resolution={ladderResolution} />

          <div className="section-eyebrow" style={{ marginTop: 14 }}>
            {t('platformFeatureFlags.editorDrawerBody.perScopeToggles')}
          </div>
          <div style={{ display: 'grid', gap: 8 }} data-testid="ff-targeting-scopes">
            {/* W34c — targeting order derives from canonical
                `scope_type_registry.ladder_rank` (Object.keys(scopeRankByType)
                sorted ascending). No inline `['global','tenant','client','sender']`
                literal. */}
            {(Object.keys(scopeRankByType) as Array<FeatureFlagScopeOverride['scope_type']>)
              .slice()
              .sort((a, b) => (scopeRankByType[a] ?? 0) - (scopeRankByType[b] ?? 0))
              .map((scopeType) => {
              const existing = scopes.find((s) => s.scope_type === scopeType);
              const enabled = existing?.enabled ?? false;
              const pct = existing?.rollout_pct ?? 0;
              // No hardcoded tenant/client/sender placeholders. When no
              // existing scope row applies, derive from the active identity
              // scope (seed mode populates from seed.current_scope; live mode
              // from IdentityProvider). Empty string when the level is not
              // present in the active scope chain.
              const scopeId = existing?.scope_id ?? resolveScopeId(scopeType, scope);
              return (
                <div
                  key={scopeType}
                  className="card"
                  style={{ padding: 10, display: 'flex', alignItems: 'center', gap: 10 }}
                  data-testid={`ff-targeting-scope-${scopeType}`}
                >
                  <ScopePill scopeType={scopeType} scopeId={scopeId} />
                  <span className="mono" style={{ fontSize: 11, color: 'var(--ink-3)' }}>
                    {scopeLabelByType[scopeType] ?? scopeType}
                  </span>
                  <div style={{ flex: 1 }} />
                  <label
                    style={{
                      display: 'inline-flex',
                      alignItems: 'center',
                      gap: 4,
                      fontSize: 12,
                    }}
                  >
                    <input
                      type="checkbox"
                      checked={enabled}
                      disabled={!canWrite}
                      data-testid={`ff-targeting-toggle-${scopeType}`}
                      onChange={(e) => {
                        const next = e.target.checked;
                        setScopes((cur) => {
                          const without = cur.filter((s) => s.scope_type !== scopeType);
                          return [
                            ...without,
                            {
                              scope_type: scopeType,
                              scope_id: scopeId,
                              enabled: next,
                              rollout_pct: next ? pct : 0,
                            },
                          ];
                        });
                      }}
                    />
                    {t('platformFeatureFlags.editorDrawerBody.enabled')}
                  </label>
                  <input
                    type="range"
                    min={0}
                    max={100}
                    step={5}
                    value={pct}
                    disabled={!canWrite || !enabled}
                    aria-label={fill(t('platformFeatureFlags.editorDrawerBody.rolloutPercentage'), { value: String(scopeLabelByType[scopeType] ?? scopeType) })}
                    data-testid={`ff-targeting-slider-${scopeType}`}
                    onChange={(e) => {
                      const next = Number(e.target.value);
                      setScopes((cur) => {
                        const without = cur.filter((s) => s.scope_type !== scopeType);
                        return [
                          ...without,
                          {
                            scope_type: scopeType,
                            scope_id: scopeId,
                            enabled: true,
                            rollout_pct: next,
                          },
                        ];
                      });
                    }}
                    style={{ width: 120 }}
                  />
                  <span
                    className="mono"
                    style={{ fontSize: 11, minWidth: 36, textAlign: 'right' }}
                  >{`${pct}%`}</span>
                </div>
              );
            })}
          </div>

          <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8, marginTop: 14 }}>
            <Button label={t('platformFeatureFlags.editorDrawerBody.cancel')} kind="ghost" onClick={onClose} />
            <Button
              label={t('platformFeatureFlags.editorDrawerBody.saveTargeting')}
              iconName="check"
              kind="primary"
              capability={CAP.FEATURE_FLAGS_WRITE}
              onClick={() => persist('update_targeting')}
            />
          </div>
        </div>
      ) : null}

      {tab === 'rollout' ? (
        <div data-testid="ff-tab-rollout-pane">
          <p className="state__hint" style={{ marginTop: 0 }}>
            {t('platformFeatureFlags.editorDrawerBody.globalRolloutPercentageApplied')}
          </p>
          <div
            className="card"
            style={{
              padding: 14,
              display: 'flex',
              flexDirection: 'column',
              gap: 10,
            }}
          >
            <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
              <span
                className="mono"
                style={{
                  fontFamily: 'var(--font-display)',
                  fontSize: 28,
                  fontWeight: 600,
                  letterSpacing: '-0.02em',
                }}
                data-testid="ff-rollout-value"
              >
                {`${rollout}%`}
              </span>
              <Chip label={impactEstimate.label} kind={impactEstimate.kind} size="xs" />
            </div>
            <input
              type="range"
              min={0}
              max={100}
              step={1}
              value={rollout}
              disabled={!canWrite || killEngaged}
              aria-label={t('platformFeatureFlags.editorDrawerBody.globalRolloutPercentage')}
              data-testid="ff-rollout-slider"
              onChange={(e) => setRollout(Number(e.target.value))}
              style={{ width: '100%' }}
            />
            <div
              style={{
                display: 'flex',
                justifyContent: 'space-between',
                fontSize: 10,
                color: 'var(--ink-3)',
              }}
              className="mono"
            >
              <span>0%</span>
              <span>25%</span>
              <span>50%</span>
              <span>75%</span>
              <span>100%</span>
            </div>
          </div>

          <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8, marginTop: 14 }}>
            <Button label={t('platformFeatureFlags.editorDrawerBody.cancel')} kind="ghost" onClick={onClose} />
            <Button
              label={t('platformFeatureFlags.editorDrawerBody.applyRollout')}
              iconName="check"
              kind="primary"
              capability={CAP.FEATURE_FLAGS_WRITE}
              onClick={() => persist('set_rollout')}
            />
          </div>
        </div>
      ) : null}

      {tab === 'history' ? (
        <div data-testid="ff-tab-history-pane">
          <p className="state__hint" style={{ marginTop: 0 }}>
            {t('platformFeatureFlags.editorDrawerBody.flagMutationHistory')} <code>{t('platformFeatureFlags.editorDrawerBody.insightsDecisions')}</code>.
          </p>
          <div className="card" style={{ padding: 0 }}>
            <div
              className="dt-toolbar"
              style={{ borderBottom: '1px solid var(--line)', padding: '8px 10px' }}
            >
              <span className="eyebrow">{t('platformFeatureFlags.editorDrawerBody.recentActivity')}</span>
              <span className="dt-tb-spacer" />
              <a
                href={`/insights/decisions?resource_id=${encodeURIComponent(flag.id)}`}
                className="chip chip--xs mono"
                style={{ textDecoration: 'none' }}
                data-testid="ff-history-decisions-link"
              >
                {t('platformFeatureFlags.editorDrawerBody.openInDecisionLog')}
              </a>
            </div>
            <div style={{ padding: 10, display: 'grid', gap: 8 }}>
              <div
                style={{
                  display: 'grid',
                  gridTemplateColumns: '120px 1fr 1fr',
                  gap: 8,
                  alignItems: 'baseline',
                }}
              >
                <span className="mono" style={{ fontSize: 11, color: 'var(--ink-3)' }}>
                  {flag.last_updated_at?.slice(0, 16).replace('T', ' ') ?? '—'}
                </span>
                <span style={{ fontSize: 12 }}>
                  {t('platformFeatureFlags.editorDrawerBody.statusChanged')} <strong className="mono">{flag.status}</strong>
                </span>
                <span className="mono" style={{ fontSize: 11, color: 'var(--ink-3)' }}>
                  {flag.last_updated_by_user_id ?? '—'}
                </span>
              </div>
              {flag.kill_switch ? (
                <div
                  style={{
                    display: 'grid',
                    gridTemplateColumns: '120px 1fr 1fr',
                    gap: 8,
                    alignItems: 'baseline',
                  }}
                >
                  <span className="mono" style={{ fontSize: 11, color: 'var(--ink-3)' }}>
                    {flag.last_updated_at?.slice(0, 16).replace('T', ' ') ?? '—'}
                  </span>
                  <span style={{ fontSize: 12, color: 'var(--ink-1)' }}>
                    {t('platformFeatureFlags.editorDrawerBody.killSwitchEngaged')}
                  </span>
                  <span className="mono" style={{ fontSize: 11, color: 'var(--ink-3)' }}>
                    {flag.last_updated_by_user_id ?? '—'}
                  </span>
                </div>
              ) : null}
              <div
                style={{
                  display: 'grid',
                  gridTemplateColumns: '120px 1fr 1fr',
                  gap: 8,
                  alignItems: 'baseline',
                }}
              >
                <span className="mono" style={{ fontSize: 11, color: 'var(--ink-3)' }}>
                  {t('platformFeatureFlags.editorDrawerBody.created')}
                </span>
                <span style={{ fontSize: 12 }}>
                  {fill(t('platformFeatureFlags.editorDrawerBody.flagCreatedDefaultRollout'), { rollout_percentage: String(flag.rollout_percentage) })}
                </span>
                <span className="mono" style={{ fontSize: 11, color: 'var(--ink-3)' }}>
                  {flag.last_updated_by_user_id ?? '—'}
                </span>
              </div>
            </div>
          </div>
        </div>
      ) : null}

      {tab === 'kill_switch' ? (
        <div data-testid="ff-tab-kill_switch-pane">
          <p className="state__hint" style={{ marginTop: 0 }}>
            {t('platformFeatureFlags.editorDrawerBody.engagingTheKillSwitch')}
          </p>
          <div
            className="card"
            style={{
              padding: 16,
              borderColor: killEngaged ? 'var(--accent-soft)' : 'var(--line)',
              background: killEngaged ? 'var(--accent-soft)' : 'var(--paper-2)',
              display: 'flex',
              flexDirection: 'column',
              gap: 10,
            }}
          >
            <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
              <Dot kind={killEngaged ? 'danger' : 'good'} />
              <span style={{ fontSize: 14, fontWeight: 600 }}>
                {killEngaged ? t('platformFeatureFlags.editorDrawerBody.killSwitchEngaged') : t('platformFeatureFlags.editorDrawerBody.killSwitchOff')}
              </span>
            </div>
            <p className="state__hint" style={{ margin: 0 }}>
              {killEngaged
                ? t('platformFeatureFlags.editorDrawerBody.thisFlagIsCurrently')
                : t('platformFeatureFlags.editorDrawerBody.engageTheKillSwitch')}
            </p>
            <div style={{ display: 'flex', gap: 8 }}>
              {killEngaged ? (
                <Button
                  label={t('platformFeatureFlags.editorDrawerBody.releaseKillSwitch')}
                  iconName="refresh"
                  kind="primary"
                  capability={CAP.FEATURE_FLAGS_WRITE}
                  onClick={() => {
                    setKillEngaged(false);
                    releaseKillMutation.mutate(
                      { feature_flag_id: flag.id },
                      {
                        onSuccess: () => pushToast(
                          `release_kill_switch_v1 · ${flag.key}`,
                          'good',
                        ),
                        onError: (err: Error) => pushToast(err.message, 'danger'),
                      },
                    );
                  }}
                />
              ) : (
                <Button
                  label={t('platformFeatureFlags.editorDrawerBody.engageKillSwitch')}
                  iconName="warn"
                  kind="danger"
                  capability={CAP.FEATURE_FLAGS_WRITE}
                  onClick={() => {
                    setKillEngaged(true);
                    engageKillMutation.mutate(
                      { feature_flag_id: flag.id },
                      {
                        onSuccess: () => pushToast(
                          `engage_kill_switch_v1 · ${flag.key}`,
                          'warn',
                        ),
                        onError: (err: Error) => pushToast(err.message, 'danger'),
                      },
                    );
                  }}
                />
              )}
            </div>
          </div>
        </div>
      ) : null}
    </div>
  );
}

// ---------- New flag form ----------

function NewFlagForm({ onClose }: { onClose: () => void }) {
  const { t } = useI18n();
  const [key, setKey] = useState('');
  const [label, setLabel] = useState('');
  const [description, setDescription] = useState('');
  const [status, setStatus] = useState<FeatureFlag['status']>('off');
  // CLAIM-PLATFORM-FF / Phase C6 — canonical create RPC.
  const createMutation = useCreateFeatureFlag();
  const submit = () => {
    createMutation.mutate(
      {
        flag_key: key || 'new_flag',
        flag_label: label,
        description,
        initial_status: status,
        scope_type: 'global',
      },
      {
        onSuccess: () => {
          pushToast(`create_feature_flag_v1 · ${key || 'new_flag'}`, 'good');
          onClose();
        },
        onError: (err: Error) => pushToast(err.message, 'danger'),
      },
    );
  };
  return (
    <div data-testid="ff-new-form">
      <p className="state__hint" style={{ marginTop: 0 }}>
        {t('platformFeatureFlags.newFlagForm.createsANewFlag')} <code>{t('platformFeatureFlags.newFlagForm.featureFlags')}</code>{' '}
        {t('platformFeatureFlags.newFlagForm.tableAtTheGlobalScope')}
      </p>
      <div className="field">
        <label className="field__label">{t('platformFeatureFlags.newFlagForm.flagKey')}</label>
        <input
          type="text"
          placeholder={t('platformFeatureFlags.newFlagForm.checkoutSkipSignature')}
          value={key}
          data-testid="ff-new-key"
          onChange={(e) => setKey(e.target.value)}
        />
      </div>
      <div className="field">
        <label className="field__label">{t('platformFeatureFlags.newFlagForm.label')}</label>
        <input
          type="text"
          placeholder={t('platformFeatureFlags.newFlagForm.checkoutSkipSignature2')}
          value={label}
          data-testid="ff-new-label"
          onChange={(e) => setLabel(e.target.value)}
        />
      </div>
      <div className="field">
        <label className="field__label">{t('platformFeatureFlags.newFlagForm.description')}</label>
        <textarea
          rows={3}
          placeholder={t('platformFeatureFlags.newFlagForm.whatDoesThisFlag')}
          value={description}
          data-testid="ff-new-description"
          onChange={(e) => setDescription(e.target.value)}
          style={{ width: '100%' }}
        />
      </div>
      <div className="field">
        <label className="field__label">{t('platformFeatureFlags.newFlagForm.initialStatus')}</label>
        <select
          className="field"
          value={status}
          data-testid="ff-new-status"
          onChange={(e) => setStatus(e.target.value as FeatureFlag['status'])}
        >
          <option value="off">{t('platformFeatureFlags.newFlagForm.off')}</option>
          <option value="on">{t('platformFeatureFlags.newFlagForm.on')}</option>
          <option value="percentage">{t('platformFeatureFlags.newFlagForm.percentageRollout')}</option>
        </select>
      </div>
      <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8, marginTop: 12 }}>
        <Button label={t('platformFeatureFlags.newFlagForm.cancel')} kind="ghost" onClick={onClose} />
        <Button
          label={t('platformFeatureFlags.newFlagForm.createFlag')}
          iconName="plus"
          kind="primary"
          capability={CAP.FEATURE_FLAGS_WRITE}
          onClick={submit}
        />
      </div>
    </div>
  );
}

// ---------- Bulk toggle confirm ----------

function BulkToggleConfirm({
  flags,
  onClose,
}: {
  flags: FeatureFlag[];
  onClose: () => void;
}) {
  const { t } = useI18n();
  const [target, setTarget] = useState<'on' | 'off'>('off');
  // CLAIM-PLATFORM-FF / Phase C6 — canonical bulk-toggle RPC. The B1 RPC
  // accepts an array of flag ids + target enabled state and returns a
  // per-flag result envelope (so partial failures surface to the operator).
  const bulkMutation = useBulkToggleFeatureFlags();
  const submit = () => {
    bulkMutation.mutate(
      {
        feature_flag_ids: flags.map((f) => f.id),
        target_status: target,
      },
      {
        onSuccess: () => {
          pushToast(
            `bulk_toggle_feature_flags_v1 · ${flags.length} flags → ${target}`,
            'good',
          );
          onClose();
        },
        onError: (err: Error) => pushToast(err.message, 'danger'),
      },
    );
  };
  return (
    <div data-testid="ff-bulk-form">
      <p className="state__hint" style={{ marginTop: 0 }}>
        {t('platformFeatureFlags.bulkToggleConfirm.bulkTogglesTheSelected')}
      </p>
      <div className="field">
        <label className="field__label">{t('platformFeatureFlags.bulkToggleConfirm.targetStatus')}</label>
        <select
          className="field"
          value={target}
          data-testid="ff-bulk-target"
          onChange={(e) => setTarget(e.target.value as 'on' | 'off')}
        >
          <option value="off">{t('platformFeatureFlags.bulkToggleConfirm.off')}</option>
          <option value="on">{t('platformFeatureFlags.bulkToggleConfirm.on')}</option>
        </select>
      </div>
      <div style={{ marginTop: 8 }}>
        <div className="eyebrow" style={{ fontSize: 10.5 }}>{fill(t('platformFeatureFlags.bulkToggleConfirm.targets'), { length: String(flags.length) })}</div>
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4, marginTop: 4 }}>
          {flags.slice(0, 24).map((f) => (
            <Chip key={f.id} label={f.key} size="xs" />
          ))}
          {flags.length > 24 ? <Chip label={fill(t('platformFeatureFlags.bulkToggleConfirm.more'), { value: String(flags.length - 24) })} size="xs" /> : null}
        </div>
      </div>
      <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8, marginTop: 12 }}>
        <Button label={t('platformFeatureFlags.bulkToggleConfirm.cancel')} kind="ghost" onClick={onClose} />
        <Button
          label={fill(t('platformFeatureFlags.bulkToggleConfirm.toggleFlags'), { length: String(flags.length) })}
          iconName="check"
          kind="primary"
          capability={CAP.FEATURE_FLAGS_WRITE}
          onClick={submit}
        />
      </div>
    </div>
  );
}

// ---------- Page module ----------

export function FeatureFlagsModule() {
  const { t } = useI18n();
  const canRead = useCapability(CAP.FEATURE_FLAGS_READ);
  // W11-3 — read seam pinned to `feature_flag_summary`, the paired projection
  // view (public.v_feature_flag_summary, supabase/migrations/202604300100).
  // The view projects feature_flags.name → key, derived (enabled,
  // rollout_percentage) → status ∈ {on, off, percentage}, and exposes
  // FE-shaped fields (label/targeting/kill_switch/owners/last_updated_at)
  // server-side so this module never reads non-canonical columns from the
  // SSOT `feature_flags` table directly. Mutations route through dedicated
  // create/update/toggle/bulk RPCs (see queries.ts).
  const flagsQuery = useResourceList<FeatureFlag>('feature_flag_summary');
  const drawer = useDrawer();
  const modal = useModal();

  // AGENTS.md §2/§3: Rollout completion percentage threshold resolves
  // strictly from canonical `feature_flags_thresholds` (W48 policy seed).
  // No inline magic numbers in the LadderViz status derivation.
  const featureFlagsPolicy = useResolveSettings('feature_flags_thresholds', undefined);
  const featureFlagsThresholds = featureFlagsPolicy.data?.value as
    | { complete_pct?: number }
    | undefined;
  const completePct = featureFlagsThresholds?.complete_pct;

  const flags = useMemo(() => flagsQuery.data?.rows ?? [], [flagsQuery.data]);

  const kpis = useMemo(() => {
    // W71-Platform (Cycle F-R-11) closure — KPI status filters resolve
    // through canonical `feature_flag_status.metadata.is_enabled|
    // is_disabled|is_rollout` instead of inline `'on'|'off'|'percentage'`
    // literal compares. AGENTS.md §2 (ZERO HARDCODING) + §6 (row-driven).
    const total = flags.length;
    const on = flags.filter(
      (f) => lookupRow('feature_flag_status', f.status ?? '')?.metadata?.is_enabled === true && !f.kill_switch,
    ).length;
    const off = flags.filter(
      (f) => lookupRow('feature_flag_status', f.status ?? '')?.metadata?.is_disabled === true && !f.kill_switch,
    ).length;
    const pct = flags.filter(
      (f) => lookupRow('feature_flag_status', f.status ?? '')?.metadata?.is_rollout === true && !f.kill_switch,
    ).length;
    const killed = flags.filter((f) => f.kill_switch).length;
    return { total, on, off, pct, killed };
  }, [flags]);

  const openEditor = (flag: FeatureFlag) => {
    drawer.open({
      title: flag.label,
      size: 'lg',
      // Page-level guard above ensures completePct is non-null at render time.
      body: (
        <EditorDrawerBody
          flag={flag}
          onClose={() => drawer.close()}
          completePct={completePct as number}
        />
      ),
    });
  };

  const openNewFlag = () => {
    modal.open({
      title: t('platformFeatureFlags.featureFlagsModule.newFeatureFlag'),
      body: <NewFlagForm onClose={() => modal.close()} />,
    });
  };

  const openBulkToggle = (rows: FeatureFlag[]) => {
    if (rows.length === 0) {
      pushToast(t('platformFeatureFlags.featureFlagsModule.selectAtLeastOne'), 'warn');
      return;
    }
    modal.open({
      title: fill(t(rows.length === 1 ? 'platformFeatureFlags.featureFlagsModule.bulkToggleFlagOne' : 'platformFeatureFlags.featureFlagsModule.bulkToggleFlagOther'), { length: String(rows.length) }),
      body: <BulkToggleConfirm flags={rows} onClose={() => modal.close()} />,
    });
  };

  const COLUMNS: DataTableColumn<FeatureFlag>[] = [
    {
      key: 'key',
      label: t('platformFeatureFlags.featureFlagsModule.flagKey'),
      mono: true,
      sortable: true,
      filterable: true,
    },
    { key: 'label', label: t('platformFeatureFlags.featureFlagsModule.label'), sortable: true, filterable: true },
    {
      key: 'status',
      label: t('platformFeatureFlags.featureFlagsModule.status'),
      sortable: true,
      filterable: true,
      lookup: 'feature_flag_status',
      render: (_raw, row) => <StatusPill flag={row} />,
    },
    {
      key: 'targeting',
      label: t('platformFeatureFlags.featureFlagsModule.targeting'),
      filterable: false,
      render: (_raw, row) => (
        <Chip
          label={row.targeting?.summary ?? '—'}
          kind="neutral"
          size="xs"
          title={(row.targeting?.scopes ?? [])
            .map((s) => `${s.scope_type}=${s.enabled ? `${s.rollout_pct}%` : 'off'}`)
            .join(' · ')}
        />
      ),
    },
    {
      key: 'owners',
      label: t('platformFeatureFlags.featureFlagsModule.owners'),
      render: (_raw, row) => {
        const owners = row.owners ?? [];
        if (owners.length === 0)
          return (
            <span className="mono" style={{ color: 'var(--ink-3)', fontSize: 11 }}>
              —
            </span>
          );
        return (
          <span style={{ display: 'inline-flex', gap: 4, flexWrap: 'wrap' }}>
            {owners.slice(0, 2).map((o) => (
              <Chip key={o} label={o.split('@')[0] ?? o} size="xs" />
            ))}
            {owners.length > 2 ? <Chip label={`+${owners.length - 2}`} size="xs" /> : null}
          </span>
        );
      },
    },
    { key: 'last_updated_at', label: t('platformFeatureFlags.featureFlagsModule.updated'), format: 'datetime', sortable: true },
    {
      key: 'kill_switch',
      label: t('platformFeatureFlags.featureFlagsModule.kill'),
      align: 'center',
      render: (raw) =>
        raw ? (
          <span
            className="chip chip--danger chip--xs"
            title={t('platformFeatureFlags.featureFlagsModule.killSwitchEngaged')}
            data-testid="ff-kill-icon"
            style={{ display: 'inline-flex', alignItems: 'center', gap: 2 }}
          >
            <Icon name="warn" size={10} />
          </span>
        ) : (
          <span className="mono" style={{ color: 'var(--ink-3)', fontSize: 11 }}>
            —
          </span>
        ),
    },
  ];

  const ROW_ACTIONS: DataTableAction<FeatureFlag>[] = [
    {
      label: t('platformFeatureFlags.featureFlagsModule.edit'),
      icon: 'edit',
      kind: 'primary',
      capability: CAP.FEATURE_FLAGS_WRITE,
      onClick: openEditor,
    },
  ];

  const BULK_ACTIONS: DataTableBulkAction<FeatureFlag>[] = [
    {
      label: t('platformFeatureFlags.featureFlagsModule.bulkToggle'),
      icon: 'refresh',
      kind: 'primary',
      capability: CAP.FEATURE_FLAGS_WRITE,
      onClick: openBulkToggle,
    },
  ];

  if (!canRead) {
    return (
      <div className="page">
        <PageHeader
          moduleKey="feature-flags"
          eyebrow={t('platformFeatureFlags.featureFlagsModule.platform')}
          titleAccent={t('platformFeatureFlags.featureFlagsModule.titleAccent')}
          titlePlain={t('platformFeatureFlags.featureFlagsModule.titlePlain')}
          pills={
            [
              <span key="reg" className="chip chip--xs mono">
                {t('platformFeatureFlags.featureFlagsModule.featureFlagAccessFeature')}
              </span>,
              <span key="parity" className="chip chip--xs">
                {t('platformFeatureFlags.featureFlagsModule.launchdarklyUnleashGrowthbookParity')}
              </span>,
            ] as ReactNode[]
          }
        />
        <StateView
          kind="denied"
          capability={CAP.FEATURE_FLAGS_READ}
          hint={t('platformFeatureFlags.featureFlagsModule.youDoNotHave')}
        />
      </div>
    );
  }

  if (completePct == null) {
    return (
      <div className="page">
        <PageHeader
          moduleKey="feature-flags"
          eyebrow={t('platformFeatureFlags.featureFlagsModule.platform')}
          titleAccent={t('platformFeatureFlags.featureFlagsModule.titleAccent')}
          titlePlain={t('platformFeatureFlags.featureFlagsModule.titlePlain')}
        />
        <StateView
          kind="error"
          title={t('platformFeatureFlags.featureFlagsModule.canonicalFeatureFlagsThresholds')}
          hint={t('platformFeatureFlags.featureFlagsModule.theFeatureFlagsThresholds')}
        />
      </div>
    );
  }

  return (
    <div className="page">
      <PageHeader
        moduleKey="feature-flags"
        eyebrow={t('platformFeatureFlags.featureFlagsModule.platform')}
        titleAccent={t('platformFeatureFlags.featureFlagsModule.titleAccent')}
        titlePlain={t('platformFeatureFlags.featureFlagsModule.titlePlain')}
        pills={
          [
            <span key="reg" className="chip chip--xs mono">
              {t('platformFeatureFlags.featureFlagsModule.featureFlagAccessFeature')}
            </span>,
            <span key="parity" className="chip chip--xs">
              {t('platformFeatureFlags.featureFlagsModule.launchdarklyUnleashGrowthbookParity')}
            </span>,
          ] as ReactNode[]
        }
        actions={[
          <Button
            key="bulk"
            label={t('platformFeatureFlags.featureFlagsModule.bulkToggle')}
            iconName="refresh"
            kind="ghost"
            capability={CAP.FEATURE_FLAGS_WRITE}
            onClick={() => openBulkToggle(flags)}
          />,
          <Button
            key="new"
            label={t('platformFeatureFlags.featureFlagsModule.newFlag')}
            iconName="plus"
            kind="primary"
            capability={CAP.FEATURE_FLAGS_WRITE}
            onClick={openNewFlag}
          />,
        ]}
      />

      {/* KPI strip */}
      <div
        className="kpi-strip"
        data-testid="ff-kpi-strip"
        style={{
          display: 'grid',
          gridTemplateColumns: 'repeat(5, minmax(0, 1fr))',
          gap: 8,
          padding: '8px 0 12px',
        }}
      >
        <KPICard label={t('platformFeatureFlags.featureFlagsModule.totalFlags')} value={kpis.total} tone="neutral" />
        <KPICard label={t('platformFeatureFlags.featureFlagsModule.on')} value={kpis.on} tone="good" />
        <KPICard label={t('platformFeatureFlags.featureFlagsModule.off')} value={kpis.off} tone="neutral" />
        <KPICard label={t('platformFeatureFlags.featureFlagsModule.rollout')} value={kpis.pct} tone="info" />
        <KPICard label={t('platformFeatureFlags.featureFlagsModule.killSwitched')} value={kpis.killed} tone={kpis.killed ? 'danger' : 'neutral'} />
      </div>

      {flagsQuery.isLoading ? (
        <StateView kind="loading" />
      ) : (
        <DataTable<FeatureFlag>
          columns={COLUMNS}
          rows={flags}
          viewKey="feature_flags"
          entityKind="feature_flags"
          onRowClick={openEditor}
          rowActions={ROW_ACTIONS}
          bulkActions={BULK_ACTIONS}
        />
      )}

      {drawer.node}
      {modal.node}
    </div>
  );
}
