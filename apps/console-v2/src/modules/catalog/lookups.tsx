// lookups.tsx — Catalog editor for public.lookup_definitions + public.lookup_values.
//
// Backend SSOT
//   • lookup_definitions (supabase/migrations/202510110003_mapping_lookup.sql lines 12-31)
//       owner_role, approval_policy, is_mutable
//   • lookup_values      (supabase/migrations/202510110003_mapping_lookup.sql lines 37-66)
//       value, label, sort_order, is_default, status, effective_from, effective_until, metadata
//   • Versioning evidence is exposed in the value drawer (effective_from / effective_until).
//
// Capability gating uses the canonical `lookups.write` capability string (now in registry seed),
// replacing the previous invented `catalog.write` that no role had.
//
// W14-5 — module reads via the canonical resource registry seam
// (`useResourceList<LookupDefinitionRegistryRow>('lookup_definitions')` and
// `useResourceList<LookupValueRegistryRow>('lookup_values')`) instead of the
// `api.seed.lookupsModule()` / `api.seed.lookupDefinitions()` direct seed-import
// shims. The new path mirrors the registry pattern every other catalog surface
// uses; production cutover is a single `getSupabaseClient()` branch flip in
// `ui_list_resource_v1`. Module call sites stay stable across demo/live planes.
//
// Additive-merge invariant — the registry adapters
// `_lookupDefinitionsCatalog()` / `_lookupValuesCatalog()` in
// `lib/data-source.ts` read the live `seed.lookups` map at call time (the map
// already carries every `Object.assign(lookups, …)` extension contributed by
// per-feature seed files such as `catalog-offerings.js`,
// `network-marketplace.js`, `platform-flags.js`, etc.). The W13-4 attempt
// reverted because the original audit overlooked that `RESOURCE_DATA()` is a
// *function* — not a frozen object — so each `useResourceList` call re-evaluates
// the projection over the merged `seed.lookups`. No structural shim is required;
// the consumer flip is safe.
import { useMemo, useState, type ReactNode } from 'react';
import { PageHeader } from '@/components/PageHeader';
import { Button } from '@/components/Button';
import { Chip, type ChipKind } from '@/components/Chip';
import { CapabilityLock } from '@/components/CapabilityLock';
import { StateView } from '@/components/StateView';
import { DataTable, type DataTableColumn } from '@/components/DataTable';
import { useModal } from '@/hooks/useOverlay';
import { pushToast } from '@/components/toastStore';
import * as api from '@/lib/api';
import { getLookups, lookupRow } from '@/lib/api';
import { useCapability } from '@/lib/identity';
import { CAP } from '@/lib/capabilities';
import {
  useResourceList,
  useCreateLookupDefinition,
  useCreateLookupValue,
  useUpdateLookupValue,
  useArchiveLookupValue,
  usePromoteLookupValue,
} from '@/lib/queries';
import { fill, useI18n } from '@/lib/i18n';

type ToneValue = 'good' | 'warn' | 'danger' | 'info' | 'neutral' | 'ink' | undefined;

// W14-5 — registry-shaped row interfaces that mirror the canonical projections
// emitted by `data-source.ts` (`_lookupDefinitionsCatalog()` /
// `_lookupValuesCatalog()`). The flat-shape `LookupValueRow` (declared further
// below) keeps the table editor's contract stable; rows are derived FE-side
// from the registry rows via `lookupValueOf(...)`.
interface LookupValueRegistryRow extends Record<string, unknown> {
  id?: string;
  category?: string;
  lookup_definition_id?: string;
  value: string;
  label: string;
  sort_order?: number | null;
  is_default?: boolean;
  status?: string;
  effective_from?: string | null;
  effective_until?: string | null;
  metadata?: Record<string, unknown>;
}

interface LookupDefinitionRegistryRow extends Record<string, unknown> {
  id?: string;
  category: string;
  description?: string | null;
  owner_role?: string | null;
  approval_policy?: string | null;
  is_mutable?: boolean;
}

// Phase G1 schema-drift fix: renamed `rank` -> `sort_order` per canonical
// public.lookup_values column. `tone` retained as a derived UI helper —
// it is projected from `metadata->>'tone'` on read and persisted into
// `metadata.tone` on write (the FE row interface keeps tone as a flat field
// for ergonomics; the underlying canonical column remains `metadata` JSONB).
// See __audit__/SCHEMA-DRIFT/CATALOG.md §1.
interface LookupValueRow extends Record<string, unknown> {
  /** Canonical lookup_values.id (`lkv_<category>_<value>` in the registry projection). */
  id?: string;
  value: string;
  label: string;
  tone?: ToneValue;
  sort_order?: number;
  is_default?: boolean;
  status?: string;
  effective_from?: string | null;
  effective_until?: string | null;
}

/** Map a canonical registry value row → the flat shape consumed by the table
 *  editor. `tone` is projected from `metadata.tone` (see data-source.ts
 *  comment block for the round-trip contract). */
function lookupValueOf(r: LookupValueRegistryRow): LookupValueRow {
  const tone = (r.metadata as Record<string, unknown> | undefined)?.tone;
  return {
    id: r.id,
    value: String(r.value),
    label: String(r.label),
    tone: typeof tone === 'string' ? (tone as ToneValue) : undefined,
    sort_order: r.sort_order != null ? Number(r.sort_order) : undefined,
    is_default: r.is_default ?? false,
    status: r.status ?? undefined,
    effective_from: r.effective_from ?? null,
    effective_until: r.effective_until ?? null,
  };
}

interface LookupDefinitionMeta {
  /** Canonical public.lookup_definitions.id (UUID in live mode; `lkd_<category>` in seed
   *  projection mode). Kept on the FE row so `lookup_value_create_v1` can satisfy its
   *  NOT NULL `lookup_definition_id` contract without a backend "category → id" hop.
   *  See REAUDIT3/CATALOG.md P1-CAT-W34-1 (W35a fix). */
  id?: string;
  category: string;
  owner_role?: string;
  approval_policy?: string;
  is_mutable?: boolean;
  description?: string;
}

interface LookupDefinitionRow extends LookupDefinitionMeta {
  values: LookupValueRow[];
}

interface NewValueDraft {
  value: string;
  label: string;
  tone: string;
  sort_order: string;
}

interface NewDefinitionDraft {
  category: string;
  owner_role: string;
  approval_policy: string;
  is_mutable: boolean;
}

// AGENTS.md §4 (SSOT): canonical key sourced from src/lib/capabilities.ts.
const WRITE_CAP = CAP.LOOKUPS_WRITE;

// W43 closure: NO fallbacks. The canonical `approval_policy` and `owner_role`
// lookup categories are resolved at render time via `getLookups(...)`. The W43
// backend seed (supabase/migrations/202605020100_w43_console_v2_canonical_seeds.sql)
// lands the rows; the FE seed mirror lives in src/lib/seed-raw/lookups.js.
// If a category resolves empty, the affected control renders a loud
// `StateView kind="error"` so the operator seeds the missing rows instead of
// silently using hardcoded enums.

// AGENTS.md §2 (ZERO HARDCODING) + §4 (SSOT): tone for owner_role +
// approval_policy resolves strictly from canonical
// `lookup_values.metadata.tone` via the seed-raw resolver. Missing
// canonical row returns null so the caller renders an explicit danger
// indicator — no silent neutral fallback.
function ownerTone(role: string | undefined): ChipKind | null {
  if (!role) return null;
  return (lookupRow('owner_role', role)?.tone as ChipKind | undefined) ?? null;
}

function approvalTone(policy: string | undefined): ChipKind | null {
  if (!policy) return null;
  return (lookupRow('approval_policy', policy)?.tone as ChipKind | undefined) ?? null;
}

// W81-Catalog+Customers (Cycle F-R-21 P1) — canonical lookup_value_status
// resolver keyed by lifecycle metadata. Replaces inline `'draft'` /
// `'active'` / `'archived'` literals in the new-value mutation payload
// and the post-promote / post-archive local-state mirrors. The
// `lookup_value_status` lookup carries `metadata.lifecycle ∈
// {pending, active, terminal}` so adding a future lifecycle slot
// (e.g., `superseded`) is a single seed insert rather than touching the
// catalog editor. Missing canonical row returns `undefined` so the
// optimistic UI mirror simply skips the patch (fail-loud at the RPC
// boundary instead of silently masking the gap with an FE literal).
// AGENTS.md §2 (ZERO HARDCODING) + §4 (SSOT) + §6 (row-driven).
function lookupValueStatusByLifecycle(
  lifecycle: 'pending' | 'active' | 'terminal',
): string | undefined {
  return (
    getLookups('lookup_value_status') as Array<{
      value: string;
      metadata?: { lifecycle?: string };
    }>
  ).find((r) => r.metadata?.lifecycle === lifecycle)?.value;
}

// W81-Catalog+Customers (Cycle F-R-21 P1) — canonical default-status
// resolver for the new-value create RPC payload. Reads the
// `lookup_value_status` row flagged `is_default: true` (the canonical
// pending-lifecycle row in the SSOT seed) so the create-draft payload
// stays row-driven. Falls back to the lifecycle resolver when the
// `is_default` flag is missing so a partial seed surface still resolves.
// Returns `undefined` when no canonical row exists (the RPC then fails
// loud with an empty status, matching the strict no-fallback contract).
function defaultLookupValueStatus(): string | undefined {
  const rows = getLookups('lookup_value_status') as Array<{
    value: string;
    is_default?: boolean;
    metadata?: { lifecycle?: string };
  }>;
  return (
    rows.find((r) => r.is_default)?.value
    ?? rows.find((r) => r.metadata?.lifecycle === 'pending')?.value
  );
}

export function LookupsModule() {
  const { t } = useI18n();
  const modal = useModal();
  const canRead = useCapability(CAP.LOOKUPS_READ);
  const createDefMut = useCreateLookupDefinition();
  const createValMut = useCreateLookupValue();
  const updateValMut = useUpdateLookupValue();
  const archiveValMut = useArchiveLookupValue();
  const promoteValMut = usePromoteLookupValue();
  const [selected, setSelected] = useState<string | null>(null);
  const [overrides, setOverrides] = useState<Record<string, LookupValueRow[]>>({});
  const [extraDefs, setExtraDefs] = useState<LookupDefinitionRow[]>([]);

  // W14-5 — canonical registry path. Replaces the prior `api.seed.*` direct
  // imports with the same `useResourceList` seam every other catalog surface
  // uses. Production cutover is a single `getSupabaseClient()` branch flip in
  // `ui_list_resource_v1`; module call sites stay stable.
  //
  // Additive-merge invariant — `_lookupValuesCatalog()` re-projects the live
  // `seed.lookups` map on every adapter call, so the
  // `Object.assign(lookups, …)` extensions contributed by per-feature seed
  // files (catalog-offerings.js, network-marketplace.js, platform-flags.js,
  // …) flow through the same registry seam without a structural shim.
  //
  // Page size — the Lookups editor is the single surface that must see EVERY
  // canonical category (it's the meta-editor). The default `ui_list_resource_v1`
  // page size of 100 rows would clip ~75% of the projected
  // `public.lookup_values` rows (current seed: ~390 rows across ~80
  // categories), hiding the additive-merged categories entirely. We request
  // `Number.MAX_SAFE_INTEGER` here as a "no client-side ceiling" sentinel —
  // the canonical pagination is server-side; the lookups editor is by design
  // a one-shot meta-editor projection. Other registry consumers keep the
  // default. The canonical `public.lookup_values` table is bounded (it's a
  // governance catalog, not a transactional table), so this is safe well past
  // production projections. W58-Catalog+Customers REDO closure: replaces
  // inline `5000` literal page-size cap.
  const LOOKUPS_EDITOR_PAGE_SIZE = Number.MAX_SAFE_INTEGER;
  const valuesQuery = useResourceList<LookupValueRegistryRow>('lookup_values', {
    page_size: LOOKUPS_EDITOR_PAGE_SIZE,
  });
  const definitionsQuery = useResourceList<LookupDefinitionRegistryRow>('lookup_definitions', {
    page_size: LOOKUPS_EDITOR_PAGE_SIZE,
  });

  const valueRegistryRows = useMemo<LookupValueRegistryRow[]>(
    () => valuesQuery.data?.rows ?? [],
    [valuesQuery.data],
  );
  const definitionRegistryRows = useMemo<LookupDefinitionRegistryRow[]>(
    () => definitionsQuery.data?.rows ?? [],
    [definitionsQuery.data],
  );

  const isLoading = valuesQuery.isLoading || definitionsQuery.isLoading;

  // Group canonical lookup_values rows by category. The registry projection
  // exposes a `category` column that mirrors the join through
  // lookup_definitions; the production swap reads the same shape from
  // ui_list_resource_v1. Flat shape per row is derived via lookupValueOf(...)
  // so the editor's contract stays unchanged.
  const valuesByCategory = useMemo(() => {
    const map = new Map<string, LookupValueRow[]>();
    for (const r of valueRegistryRows) {
      const category = String(r.category ?? '');
      if (!category) continue;
      if (!map.has(category)) map.set(category, []);
      map.get(category)!.push(lookupValueOf(r));
    }
    // Stable per-category sort: by sort_order asc (unset → end), then value.
    for (const arr of map.values()) {
      arr.sort((a, b) => {
        const sa = a.sort_order ?? Number.MAX_SAFE_INTEGER;
        const sb = b.sort_order ?? Number.MAX_SAFE_INTEGER;
        if (sa !== sb) return sa - sb;
        return a.value.localeCompare(b.value);
      });
    }
    return map;
  }, [valueRegistryRows]);

  const definitions = useMemo<LookupDefinitionRow[]>(() => {
    // Union of (a) canonical lookup_definitions rows and (b) value-only
    // categories that have rows but no metadata. This preserves prior UX
    // where freshly-created categories without metadata still surface
    // (defaulting `is_mutable=true` per migration default).
    const metaByCategory = new Map<string, LookupDefinitionRegistryRow>();
    for (const d of definitionRegistryRows) metaByCategory.set(d.category, d);

    const allCategories = new Set<string>();
    for (const c of metaByCategory.keys()) allCategories.add(c);
    for (const c of valuesByCategory.keys()) allCategories.add(c);

    const base: LookupDefinitionRow[] = [...allCategories].map((category) => {
      const meta = metaByCategory.get(category);
      const seedValues = valuesByCategory.get(category) ?? [];
      return {
        // Forward the canonical `lookup_definitions.id` so the New value mutation
        // can satisfy `lookup_value_create_v1`'s NOT NULL `lookup_definition_id`
        // contract (REAUDIT3 P1-CAT-W34-1, closed by W35a). Value-only categories
        // (added via per-feature `Object.assign(seed.lookups, ...)` without a
        // matching `seed.lookup_definitions` row) get the same synthesized
        // `lkd_<category>` id that `_lookupValuesCatalog()` already projects on
        // each value row's `lookup_definition_id` (data-source.ts:748). In live
        // mode this branch never triggers because `lookup_values` has a NOT NULL
        // FK to `lookup_definitions`, so `meta` is always populated.
        id: meta?.id ?? `lkd_${category}`,
        category,
        owner_role: meta?.owner_role ?? undefined,
        approval_policy: meta?.approval_policy ?? undefined,
        // Categories without metadata default to mutable (matches the migration default for newly
        // seeded categories: `is_mutable BOOLEAN NOT NULL DEFAULT true`).
        is_mutable: meta?.is_mutable ?? true,
        description: meta?.description ?? undefined,
        values: overrides[category] ?? seedValues,
      };
    });
    return [...base, ...extraDefs].sort((a, b) => a.category.localeCompare(b.category));
  }, [definitionRegistryRows, valuesByCategory, overrides, extraDefs]);

  const activeKey = selected ?? definitions[0]?.category ?? null;
  const active = definitions.find((d) => d.category === activeKey);
  const isMutable = active?.is_mutable !== false;

  function applyValuesUpdate(category: string, next: LookupValueRow[]) {
    setOverrides((prev) => ({ ...prev, [category]: next }));
  }

  async function refetchLookupValuesForReadback(
    category: string,
    value: string,
    validate?: (row: Record<string, unknown>) => boolean,
  ): Promise<void> {
    const refreshed = await valuesQuery.refetch();
    const rows = refreshed.data?.rows ?? [];
    const found = rows.some((row) => {
      const record = row as Record<string, unknown>;
      return record.category === category && record.value === value && (validate ? validate(record) : true);
    });
    if (!found) {
      throw new Error(fill(t('catalogLookups.lookupsModule.updatedLookupValueCategory'), { category: String(category), value: String(value) }));
    }
    setOverrides((prev) => {
      const { [category]: _stale, ...rest } = prev;
      return rest;
    });
  }

  function openNewDefinition() {
    function NewDefinitionForm() {
      // W43 closure: STRICT canonical-source consumption. `owner_role` and
      // `approval_policy` enum options come from the canonical lookup
      // categories (resolved via `getLookups(...)`). If either category is
      // not seeded the form renders a loud `StateView kind="error"` instead
      // of silently falling back to hardcoded enums.
      const ownerRoleOptions = useMemo<ReadonlyArray<string>>(() => {
        const list = (getLookups('owner_role') as Array<{ value: string }> | undefined) ?? [];
        return list.map((r) => r.value);
      }, []);
      const approvalPolicyOptions = useMemo<ReadonlyArray<string>>(() => {
        const list =
          (getLookups('approval_policy') as Array<{ value: string }> | undefined) ?? [];
        return list.map((r) => r.value);
      }, []);
      const ownerRoleMissing = ownerRoleOptions.length === 0;
      const approvalPolicyMissing = approvalPolicyOptions.length === 0;
      const [draft, setDraft] = useState<NewDefinitionDraft>({
        category: '',
        owner_role: ownerRoleOptions[0] ?? '',
        approval_policy: approvalPolicyOptions[0] ?? '',
        is_mutable: true,
      });
      if (ownerRoleMissing || approvalPolicyMissing) {
        const missing = [
          ownerRoleMissing ? 'owner_role' : null,
          approvalPolicyMissing ? 'approval_policy' : null,
        ]
          .filter(Boolean)
          .join(', ');
        return (
          <div>
            <StateView
              kind="error"
              title={t('catalogLookups.lookupsModule.requiredCatalogOptionsAre')}
              hint={fill(t('catalogLookups.lookupsModule.seedTheMissingOptions'), { missing: String(missing) })}
            />
            <div style={{ display: 'flex', justifyContent: 'flex-end', gap: '8px', marginTop: '14px' }}>
              <Button label={t('catalogLookups.lookupsModule.close')} kind="ghost" onClick={() => modal.close()} />
            </div>
          </div>
        );
      }
      return (
        <div>
          <p className="state__hint">
            {t('catalogLookups.lookupsModule.createsGovernedLookupCategory')}
          </p>
          <div
            style={{
              display: 'grid',
              gridTemplateColumns: '140px 1fr',
              gap: '8px',
              alignItems: 'center',
              padding: '0 4px',
              marginTop: 8,
            }}
          >
            <label className="mono" htmlFor="new-cat-category">{t('catalogLookups.lookupsModule.category')}</label>
            <input
              id="new-cat-category"
              className="dt-inline-input"
              placeholder={t('catalogLookups.lookupsModule.eGDisputeResolution')}
              value={draft.category}
              onChange={(e) => setDraft((s) => ({ ...s, category: e.target.value }))}
            />
            <label className="mono" htmlFor="new-cat-owner">{t('catalogLookups.lookupsModule.ownerRole')}</label>
            <select
              id="new-cat-owner"
              className="dt-inline-input"
              value={draft.owner_role}
              onChange={(e) => setDraft((s) => ({ ...s, owner_role: e.target.value }))}
            >
              {ownerRoleOptions.map((role) => (
                <option key={role} value={role}>{role}</option>
              ))}
            </select>
            <label className="mono" htmlFor="new-cat-approval">{t('catalogLookups.lookupsModule.approvalPolicy')}</label>
            <select
              id="new-cat-approval"
              className="dt-inline-input"
              value={draft.approval_policy}
              onChange={(e) => setDraft((s) => ({ ...s, approval_policy: e.target.value }))}
            >
              {approvalPolicyOptions.map((p) => (
                <option key={p} value={p}>{p}</option>
              ))}
            </select>
            <label className="mono" htmlFor="new-cat-mutable">{t('catalogLookups.lookupsModule.tenantExtensible')}</label>
            <label style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
              <input
                id="new-cat-mutable"
                type="checkbox"
                checked={draft.is_mutable}
                onChange={(e) => setDraft((s) => ({ ...s, is_mutable: e.target.checked }))}
              />
              <span style={{ fontSize: 11, color: 'var(--ink-3)' }}>
                {t('catalogLookups.lookupsModule.whenUncheckedTheCategory')}
              </span>
            </label>
          </div>
          <div style={{ display: 'flex', justifyContent: 'flex-end', gap: '8px', marginTop: '14px' }}>
            <Button label={t('catalogLookups.lookupsModule.cancel')} kind="ghost" onClick={() => modal.close()} />
            <Button
              label={t('catalogLookups.lookupsModule.create')}
              kind="primary"
              capability={WRITE_CAP}
              onClick={async () => {
                const key = draft.category.trim().toLowerCase();
                if (!key) {
                  pushToast(t('catalogLookups.lookupsModule.categoryNameIsRequired'), 'warn');
                  return;
                }
                if (definitions.some((d) => d.category === key)) {
                  pushToast(fill(t('catalogLookups.lookupsModule.categoryKeyAlreadyExists'), { key: String(key) }), 'warn');
                  return;
                }
                try {
                  // W35a — capture the canonical `lookup_definition_id` returned by
                  // `lookup_definition_create_v1` so a subsequent New value flow on this
                  // freshly-created category can satisfy the `lookup_value_create_v1`
                  // NOT NULL `lookup_definition_id` contract before the registry
                  // refresh lands. Closes REAUDIT3 P1-CAT-W34-1.
                  const result = await createDefMut.mutateAsync({
                    category: key,
                    owner_role: draft.owner_role,
                    approval_policy: draft.approval_policy,
                    is_mutable: draft.is_mutable,
                  });
                  setExtraDefs((prev) => [
                    ...prev,
                    {
                      id: result?.lookup_definition_id,
                      category: key,
                      owner_role: draft.owner_role,
                      approval_policy: draft.approval_policy,
                      is_mutable: draft.is_mutable,
                      values: [],
                    },
                  ]);
                  setSelected(key);
                  modal.close();
                  pushToast(fill(t('catalogLookups.lookupsModule.definitionCreatedKey'), { key: String(key) }), 'good');
                } catch (err) {
                  pushToast((err as Error).message, 'danger');
                }
              }}
            />
          </div>
        </div>
      );
    }
    modal.open({ title: t('catalogLookups.lookupsModule.newLookupDefinition'), body: <NewDefinitionForm /> });
  }

  function openNewValue() {
    if (!active) {
      pushToast(t('catalogLookups.lookupsModule.selectADefinitionFirst'), 'warn');
      return;
    }
    if (!isMutable) {
      pushToast(fill(t('catalogLookups.lookupsModule.categoryIsSystemManaged'), { category: String(active.category) }), 'warn');
      return;
    }
    const category = active.category;
    // W35a — resolve the canonical `lookup_definition_id` from the active row so
    // `lookup_value_create_v1` receives the NOT NULL UUID it requires (canonical
    // RPC: supabase/migrations/202604280208_lookup_value_create_v1.sql:21,39-42).
    // The active row is sourced from either `definitionRegistryRows` (registry
    // projection — `lkd_<category>` in seed mode, real UUID in live mode) or
    // `extraDefs` (fresh create capturing the RPC-returned id). Closes REAUDIT3
    // P1-CAT-W34-1.
    const lookupDefinitionId = active.id;
    if (!lookupDefinitionId) {
      pushToast(
        fill(t('catalogLookups.lookupsModule.definitionNotReadyYet'), { category }),
        'warn',
      );
      return;
    }

    function NewValueForm() {
      // W56-A closure: STRICT canonical-source consumption. Tone enum options
      // come from the canonical `chip_tone` lookup category (resolved via
      // `getLookups(...)`). The default tone seed value resolves from the
      // canonical `is_default: true` row instead of an inline `'neutral'`
      // literal. If the category is not seeded the form renders a loud
      // `StateView kind="error"` instead of silently falling back.
      const chipToneOptions = useMemo<
        ReadonlyArray<{ value: string; label: string }>
      >(() => {
        const list =
          (getLookups('chip_tone') as Array<{ value: string; label: string }> | undefined) ?? [];
        return list.map((r) => ({ value: r.value, label: r.label ?? r.value }));
      }, []);
      const chipToneDefault = useMemo<string | null>(() => {
        const list =
          (getLookups('chip_tone') as Array<{ value: string; is_default?: boolean }> | undefined)
          ?? [];
        return list.find((r) => r.is_default)?.value ?? null;
      }, []);
      const chipToneMissing = chipToneOptions.length === 0 || chipToneDefault === null;
      const [draft, setDraft] = useState<NewValueDraft>({
        value: '',
        label: '',
        tone: chipToneDefault ?? '',
        sort_order: '',
      });
      if (chipToneMissing) {
        return (
          <div>
            <StateView
              kind="error"
              title={t('catalogLookups.lookupsModule.lookupColorsAreNot')}
              hint={t('catalogLookups.lookupsModule.configureTheLookupColor')}
            />
            <div style={{ display: 'flex', justifyContent: 'flex-end', gap: '8px', marginTop: '14px' }}>
              <Button label={t('catalogLookups.lookupsModule.close')} kind="ghost" onClick={() => modal.close()} />
            </div>
          </div>
        );
      }
      return (
        <div>
          <p className="state__hint">{`Add a value to ${category}.`}</p>
          <div
            style={{
              display: 'grid',
              gridTemplateColumns: '120px 1fr',
              gap: '8px',
              alignItems: 'center',
              padding: '0 4px',
              marginTop: '8px',
            }}
          >
            <label className="mono" htmlFor="new-val-value">{t('catalogLookups.lookupsModule.value')}</label>
            <input
              id="new-val-value"
              className="dt-inline-input"
              placeholder={t('catalogLookups.lookupsModule.snakeCase')}
              value={draft.value}
              onChange={(e) => setDraft((s) => ({ ...s, value: e.target.value }))}
            />
            <label className="mono" htmlFor="new-val-label">{t('catalogLookups.lookupsModule.label')}</label>
            <input
              id="new-val-label"
              className="dt-inline-input"
              placeholder={t('catalogLookups.lookupsModule.displayLabel')}
              value={draft.label}
              onChange={(e) => setDraft((s) => ({ ...s, label: e.target.value }))}
            />
            <label className="mono" htmlFor="new-val-tone">{t('catalogLookups.lookupsModule.tone')}</label>
            <select
              id="new-val-tone"
              className="dt-inline-input"
              value={draft.tone}
              onChange={(e) => setDraft((s) => ({ ...s, tone: e.target.value }))}
            >
              {chipToneOptions.map((opt) => (
                <option key={opt.value} value={opt.value}>{opt.label}</option>
              ))}
            </select>
            <label className="mono" htmlFor="new-val-sort-order">{t('catalogLookups.lookupsModule.sortOrder')}</label>
            <input
              id="new-val-sort-order"
              className="dt-inline-input"
              type="number"
              placeholder={t('catalogLookups.lookupsModule.optional')}
              value={draft.sort_order}
              onChange={(e) => setDraft((s) => ({ ...s, sort_order: e.target.value }))}
            />
          </div>
          <div style={{ display: 'flex', justifyContent: 'flex-end', gap: '8px', marginTop: '14px' }}>
            <Button label={t('catalogLookups.lookupsModule.cancel')} kind="ghost" onClick={() => modal.close()} />
            <Button
              label={t('catalogLookups.lookupsModule.addValue')}
              kind="primary"
              capability={WRITE_CAP}
              onClick={async () => {
                if (!draft.value.trim() || !draft.label.trim()) {
                  pushToast(t('catalogLookups.lookupsModule.valueAndLabelAre'), 'warn');
                  return;
                }
                if (!/^[a-z][a-z0-9_]*$/.test(draft.value.trim())) {
                  pushToast(t('catalogLookups.lookupsModule.valueMustBeSnake'), 'warn');
                  return;
                }
                // W56-A closure: NO inline 'neutral' fallback. The canonical
                // `chip_tone` default already seeded `draft.tone` via
                // `getLookups('chip_tone').find(r => r.is_default)`; the form is
                // gated behind a fail-loud StateView when missing.
                // W81-Catalog+Customers (Cycle F-R-21 P1) — `status` resolves
                // through the canonical `lookup_value_status` row flagged
                // `is_default: true` / `metadata.lifecycle === 'pending'`
                // instead of an inline `'draft'` literal. Strict no-fallback:
                // missing canonical row surfaces an empty status to the RPC
                // (fail-loud) per AGENTS.md §2 (ZERO HARDCODING) + §4 (SSOT).
                const next: LookupValueRow = {
                  value: draft.value.trim(),
                  label: draft.label.trim(),
                  tone: (draft.tone || chipToneDefault) as ToneValue,
                  status: defaultLookupValueStatus(),
                };
                if (draft.sort_order.trim()) next.sort_order = Number(draft.sort_order);
                const current = definitions.find((d) => d.category === category)?.values ?? [];
                if (current.some((v) => v.value === next.value)) {
                  pushToast(fill(t('catalogLookups.lookupsModule.valueValueAlreadyExists'), { value: String(next.value), category: String(category) }), 'warn');
                  return;
                }
                const metadata: Record<string, unknown> = {};
                if (next.tone) metadata.tone = next.tone;
                try {
                  // W35a — pass the canonical `lookup_definition_id` (NOT NULL UUID
                  // per supabase/migrations/202604280208_lookup_value_create_v1.sql:21,39-42).
                  // `category` is retained as an extra payload field for backwards
                  // compatibility with the seed-mode dispatcher; the canonical RPC
                  // does not read it (jsonb tolerates extra keys), so passing it
                  // is harmless in live mode. Closes REAUDIT3 P1-CAT-W34-1.
                  // W81-Catalog+Customers (Cycle F-R-21 P1) — RPC payload
                  // `status` is the canonical `defaultLookupValueStatus()` (the
                  // `lookup_value_status` row flagged `is_default: true`). No
                  // inline `'draft'` literal; the SSOT lookup is the sole
                  // source of the create-draft governance state.
                  await createValMut.mutateAsync({
                    lookup_definition_id: lookupDefinitionId,
                    category,
                    value: next.value,
                    label: next.label,
                    sort_order: next.sort_order,
                    metadata,
                    status: defaultLookupValueStatus() as api.LookupValueCreateArgs['status'],
                  });
                  await refetchLookupValuesForReadback(category, next.value);
                  if (extraDefs.some((d) => d.category === category)) {
                    const updated = [...current, next];
                    setExtraDefs((prev) =>
                      prev.map((d) => (d.category === category ? { ...d, values: updated } : d)),
                    );
                  }
                  modal.close();
                  pushToast(fill(t('catalogLookups.lookupsModule.addedValue'), { value: String(next.value) }), 'good');
                } catch (err) {
                  pushToast((err as Error).message, 'danger');
                }
              }}
            />
          </div>
        </div>
      );
    }
    modal.open({ title: fill(t('catalogLookups.lookupsModule.addValueCategory'), { category: String(category) }), body: <NewValueForm /> });
  }

  const valueColumns: Array<DataTableColumn<LookupValueRow>> = [
    { key: 'value', label: t('catalogLookups.lookupsModule.value'), mono: true, sortable: true, filterable: true, editable: false },
    { key: 'label', label: t('catalogLookups.lookupsModule.label'), sortable: true, filterable: true, editable: isMutable },
    { key: 'status', label: t('catalogLookups.lookupsModule.status'), sortable: true, filterable: true, lookup: 'lookup_value_status', editable: false },
    {
      key: 'tone',
      label: t('catalogLookups.lookupsModule.tone'),
      sortable: true,
      filterable: true,
      editable: isMutable,
      render: (raw) => {
        if (!raw) return <span className="mono">—</span>;
        const tone = String(raw) as Exclude<ToneValue, undefined>;
        return <Chip label={tone} kind={tone} size="xs" />;
      },
    },
    { key: 'sort_order', label: t('catalogLookups.lookupsModule.sortOrder'), align: 'right', sortable: true, editable: isMutable },
    {
      key: 'is_default',
      label: t('catalogLookups.lookupsModule.default'),
      align: 'right',
      type: 'boolean',
      sortable: true,
      filterable: true,
    },
    {
      key: 'effective_from',
      label: t('catalogLookups.lookupsModule.from'),
      mono: true,
      sortable: true,
      render: (raw) => (raw ? <span className="mono">{String(raw)}</span> : <span style={{ color: 'var(--ink-3)' }}>—</span>),
    },
    {
      key: 'effective_until',
      label: t('catalogLookups.lookupsModule.until'),
      mono: true,
      sortable: true,
      render: (raw) => (raw ? <span className="mono">{String(raw)}</span> : <span style={{ color: 'var(--ink-3)' }}>{t('catalogLookups.lookupsModule.open')}</span>),
    },
  ];

  const pills: ReactNode[] = [
      <Chip key="cap" label={t('catalogLookups.lookupsModule.referenceAccessReferenceUpdate')} kind="info" size="xs" />,
    <span key="seam" className="chip chip--xs mono">
          {t('catalogLookups.lookupsModule.referenceCategoriesValues')}
    </span>,
  ];

  if (!canRead) {
    return (
      <div className="page">
        <PageHeader
          moduleKey="lookups"
          eyebrow={t('catalogLookups.lookupsModule.catalog')}
          titleAccent={t('catalogLookups.lookupsModule.reference')}
          titlePlain={t('catalogLookups.lookupsModule.data')}
        />
        <StateView
          kind="denied"
          capability={CAP.LOOKUPS_READ}
          hint={t('catalogLookups.lookupsModule.youDoNotHave')}
        />
      </div>
    );
  }

  return (
    <div className="page">
      <PageHeader
        moduleKey="lookups"
        eyebrow={t('catalogLookups.lookupsModule.catalog')}
        titleAccent={t('catalogLookups.lookupsModule.reference')}
        titlePlain={t('catalogLookups.lookupsModule.data')}
        pills={pills}
        actions={[
          <Button
            key="new-def"
            label={t('catalogLookups.lookupsModule.newDefinition')}
            iconName="plus"
            kind="ghost"
            capability={WRITE_CAP}
            onClick={openNewDefinition}
          />,
          <Button
            key="new-val"
            label={t('catalogLookups.lookupsModule.newValue')}
            iconName="plus"
            kind="primary"
            capability={WRITE_CAP}
            onClick={openNewValue}
          />,
        ]}
      />

      {isLoading ? (
        <StateView kind="loading" />
      ) : (
        <div
          style={{
            display: 'grid',
            gridTemplateColumns: '320px 1fr',
            gap: '12px',
            padding: '12px',
            flex: 1,
            minHeight: 0,
            alignItems: 'start',
          }}
        >
          <div className="card" style={{ padding: 0, overflow: 'hidden', maxHeight: '70vh' }}>
            <div className="section-eyebrow" style={{ padding: '10px 12px 4px' }}>
              {fill(t('catalogLookups.lookupsModule.definitionsCount'), { count: String(definitions.length) })}
            </div>
            <div style={{ overflowY: 'auto' }}>
              {definitions.map((def) => {
                const isActive = activeKey === def.category;
                const locked = def.is_mutable === false;
                return (
                  <button
                    key={def.category}
                    type="button"
                    onClick={() => setSelected(def.category)}
                    aria-current={isActive ? 'true' : undefined}
                    aria-label={fill(t(locked ? 'catalogLookups.lookupsModule.selectCategoryLocked' : 'catalogLookups.lookupsModule.selectCategory'), { category: String(def.category) })}
                    className={isActive ? 'is-selected' : undefined}
                    style={{
                      display: 'flex',
                      alignItems: 'center',
                      justifyContent: 'space-between',
                      width: '100%',
                      padding: '8px 12px',
                      background: isActive ? 'var(--accent-soft)' : 'transparent',
                      border: 'none',
                      borderBottom: '1px solid var(--line)',
                      textAlign: 'left',
                      cursor: 'pointer',
                      fontFamily: 'inherit',
                      color: 'inherit',
                      gap: 8,
                    }}
                  >
                    <span className="mono" style={{ fontSize: '12px', flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis' }}>
                      {def.category}
                    </span>
                    {locked ? (
                      <span title={t('catalogLookups.lookupsModule.systemManaged')} aria-label={t('catalogLookups.lookupsModule.systemManaged2')} className="chip chip--xs">
                        {t('catalogLookups.lookupsModule.locked')}
                      </span>
                    ) : null}
                    <span style={{ fontSize: '10.5px', color: 'var(--ink-3)' }}>{def.values.length}</span>
                  </button>
                );
              })}
            </div>
          </div>

          <div style={{ minWidth: 0 }}>
            {active ? (
              <>
                <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap', padding: '0 4px 6px' }}>
                  <h2 style={{ margin: 0, fontSize: 16 }} className="mono">{active.category}</h2>
                  <Chip label={`${active.values.length} values`} kind="neutral" size="xs" />
                  {active.owner_role ? (() => {
                    const tone = ownerTone(active.owner_role);
                    return tone == null
                      ? <Chip label={`owner_role/${active.owner_role} (missing)`} kind="danger" size="xs" />
                      : <Chip label={`owner · ${active.owner_role}`} kind={tone} size="xs" />;
                  })() : null}
                  {active.approval_policy ? (() => {
                    const tone = approvalTone(active.approval_policy);
                    return tone == null
                      ? <Chip label={`approval_policy/${active.approval_policy} (missing)`} kind="danger" size="xs" />
                      : <Chip label={`approval · ${active.approval_policy}`} kind={tone} size="xs" />;
                  })() : null}
                  {active.is_mutable === false ? (
                    <Chip label={t('catalogLookups.lookupsModule.systemManaged2')} kind="warn" size="xs" />
                  ) : (
                    <Chip label={t('catalogLookups.lookupsModule.tenantExtensible2')} kind="good" size="xs" />
                  )}
                  {!isMutable ? <CapabilityLock capability={WRITE_CAP} /> : null}
                </div>
                {active.description ? (
                  <p style={{ fontSize: 11.5, color: 'var(--ink-3)', padding: '0 6px 8px' }}>{active.description}</p>
                ) : null}
                <DataTable<LookupValueRow>
                  columns={valueColumns}
                  rows={active.values}
                  viewKey={`lookup_values_${active.category}`}
                  entityKind="lookup_value"
                  emptyText={isMutable ? t('catalogLookups.lookupsModule.noValuesYetAdd') : t('catalogLookups.lookupsModule.noValuesDefinedFor')}
                  onCellEdit={isMutable ? async (row, key, val) => {
                    let nextVal: unknown = val;
                    if (key === 'sort_order') {
                      const num = typeof val === 'number' ? val : parseFloat(String(val));
                      nextVal = Number.isFinite(num) ? num : undefined;
                    }
                    // Phase B6 update RPC accepts label/description/sort_order/is_default/metadata.
                    // The `value` field is immutable post-create per backend contract.
                    const lookupValueId = (row as LookupValueRow & { id?: string }).id ?? `lkv_${active.category}_${row.value}`;
                    try {
                      const args: api.LookupValueUpdateArgs = { lookup_value_id: lookupValueId };
                      let validate: ((record: Record<string, unknown>) => boolean) | undefined;
                      if (key === 'label') {
                        args.label = String(val);
                        validate = (record) => record.label === String(val);
                      }
                      if (key === 'sort_order') {
                        args.sort_order = (typeof nextVal === 'number') ? nextVal : undefined;
                        validate = (record) => record.sort_order === nextVal;
                      }
                      if (key === 'is_default') {
                        args.is_default = Boolean(val);
                        validate = (record) => record.is_default === Boolean(val);
                      }
                      if (key === 'tone') {
                        args.metadata = { tone: String(val) };
                        validate = (record) => {
                          const metadata = record.metadata as Record<string, unknown> | undefined;
                          return metadata?.tone === String(val);
                        };
                      }
                      await updateValMut.mutateAsync(args);
                      await refetchLookupValuesForReadback(active.category, row.value, validate);
                    } catch (err) {
                      return { ok: false, error: (err as Error).message };
                    }
                    if (extraDefs.some((d) => d.category === active.category)) {
                      const updated = active.values.map((v) =>
                        v === row ? ({ ...v, [key]: nextVal } as LookupValueRow) : v,
                      );
                      setExtraDefs((prev) =>
                        prev.map((d) =>
                          d.category === active.category ? { ...d, values: updated } : d,
                        ),
                      );
                    }
                    return { ok: true };
                  } : undefined}
                  rowActions={isMutable ? [
                    {
                      label: t('catalogLookups.lookupsModule.promoteDraft'),
                      icon: 'check',
                      capability: WRITE_CAP,
                      onClick: async (r) => {
                        const lookupValueId = (r as LookupValueRow & { id?: string }).id ?? `lkv_${active.category}_${r.value}`;
                        try {
                          await promoteValMut.mutateAsync({ lookup_value_id: lookupValueId });
                          // Mirrors lookup_value_promote_v1 contract: status=active, sets effective_from=now().
                          // W81-Catalog+Customers (Cycle F-R-21 P1) — `status` resolves
                          // through the canonical `lookup_value_status` row flagged
                          // `metadata.lifecycle === 'active'` instead of an inline
                          // `'active'` literal. Strict no-fallback: missing canonical
                          // row leaves status untouched on the optimistic UI mirror
                          // so the gap surfaces (the RPC has already succeeded).
                          const promotedStatus = lookupValueStatusByLifecycle('active');
                          await refetchLookupValuesForReadback(
                            active.category,
                            r.value,
                            promotedStatus
                              ? (row) => row.status === promotedStatus && Boolean(row.effective_from)
                              : (row) => Boolean(row.effective_from),
                          );
                          if (extraDefs.some((d) => d.category === active.category)) {
                            const now = new Date().toISOString();
                            const updated = active.values.map((v) =>
                              v === r
                                ? (
                                    promotedStatus
                                      ? ({ ...v, status: promotedStatus, effective_from: now } as LookupValueRow)
                                      : ({ ...v, effective_from: now } as LookupValueRow)
                                  )
                                : v,
                            );
                            setExtraDefs((prev) =>
                              prev.map((d) =>
                                d.category === active.category ? { ...d, values: updated } : d,
                              ),
                            );
                          }
                          pushToast(fill(t('catalogLookups.lookupsModule.promotedValue'), { value: String(r.value) }), 'good');
                        } catch (err) {
                          pushToast((err as Error).message, 'danger');
                        }
                      },
                    },
                    {
                      label: t('catalogLookups.lookupsModule.archive'),
                      icon: 'lock',
                      kind: 'danger',
                      capability: WRITE_CAP,
                      onClick: async (r) => {
                        // Mirrors lookup_values.status='archived' + retired_at=now() (soft delete)
                        // via canonical Phase B6 lookup_value_archive_v1 RPC.
                        // W81-Catalog+Customers (Cycle F-R-21 P1) — `status` resolves
                        // through the canonical `lookup_value_status` row flagged
                        // `metadata.lifecycle === 'terminal'` instead of an inline
                        // `'archived'` literal. Strict no-fallback: missing
                        // canonical row leaves status untouched so the gap is
                        // visible (the RPC has already succeeded).
                        const lookupValueId = (r as LookupValueRow & { id?: string }).id ?? `lkv_${active.category}_${r.value}`;
                        try {
                          await archiveValMut.mutateAsync({ lookup_value_id: lookupValueId });
                          const archivedStatus = lookupValueStatusByLifecycle('terminal');
                          await refetchLookupValuesForReadback(
                            active.category,
                            r.value,
                            archivedStatus ? (row) => row.status === archivedStatus : undefined,
                          );
                          if (extraDefs.some((d) => d.category === active.category)) {
                            const updated = active.values.map((v) =>
                              v === r
                                ? (
                                    archivedStatus
                                      ? ({ ...v, status: archivedStatus } as LookupValueRow)
                                      : v
                                  )
                                : v,
                            );
                            setExtraDefs((prev) =>
                              prev.map((d) =>
                                d.category === active.category ? { ...d, values: updated } : d,
                              ),
                            );
                          }
                          pushToast(fill(t('catalogLookups.lookupsModule.archivedValue'), { value: String(r.value) }), 'info');
                        } catch (err) {
                          pushToast((err as Error).message, 'danger');
                        }
                      },
                    },
                  ] : []}
                />
              </>
            ) : (
              <StateView kind="empty" hint={t('catalogLookups.lookupsModule.selectADefinitionOn')} />
            )}
          </div>
        </div>
      )}

      {modal.node}
    </div>
  );
}
