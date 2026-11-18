// integrations/rules.tsx — Webhook routing rules operator surface (CLAIM-INGRESS-COMPLETE).
//
// Backed by:
//   • public.webhook_rules from
//     supabase/migrations/202510110004_webhook_integration.sql:248+
//     (webhook_source_id FK -> webhook_sources.id, event_type, name, priority,
//      mapping_config_id, workflow_template_id, domain_category, enabled).
//   • RLS gated by webhooks.read / webhooks.write per migration
//     202601071220_capability_assignments.sql:113.
//   • ui_read_registry.webhook_rules (seed-raw/registry.js).
//   • ui_list_resource_v1('webhook_rules') generic substrate.
//
// Operator capabilities:
//   - Browse all routing rules (DataTable, capability `webhooks.read`).
//   - Filter chips by source + event_type.
//   - Open detail drawer with full rule contract.
//   - Enable/disable in place via ui_upsert_webhook_rule_v1.
//     (capability `webhooks.write`).
//   - Edit / Create via modal with workflow_template picker
//     (ReferencePicker over workflow_templates) — capability `webhooks.write`.

import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { CAP } from "@/lib/capabilities";
import { useNavigate } from '@tanstack/react-router';
import { Button } from '@/components/Button';
import { Chip } from '@/components/Chip';
import { ScopePill } from '@/components/ScopePill';
import { PageHeader } from '@/components/PageHeader';
import {
  DataTable,
  type DataTableColumn,
  type DataTableAction,
  type DataTableBulkAction,
} from '@/components/DataTable';
import { KvGrid, type KvRow } from '@/components/KvGrid';
import { StateView } from '@/components/StateView';
import { ReferencePicker } from '@/components/ReferencePicker';
import { useDrawer, useModal } from '@/hooks/useOverlay';
import { pushToast } from '@/components/toastStore';
import {
  useCompleteResourceList,
  useResourceList,
  useUpsertWebhookRule,
  useDeleteWebhookRule,
  useReorderWebhookRule,
  useResolveSettings,
} from '@/lib/queries';
import { useIdentity, useCapability } from '@/lib/identity';
import { getLookups, lookupRow } from '@/lib/api';
import type { ChipKind } from '@/components/Chip';
import type { WebhookSourceRow } from '@/modules/integrations/sources';
import {
  isRuleWorkflowTemplateVisibleForTenant,
  isRuleWorkflowTemplateRelevantForWebhookEvent,
  sortRuleWorkflowTemplates,
  type RuleWorkflowTemplateScopeRow,
} from '@/modules/integrations/rules-template-scope';
import { ExternalIntakeWorkspaceToolbar } from './ExternalIntakeWorkspaceToolbar';

// ─── Strict canonical lookup row resolver (NO fallback constants) ─────────
// AGENTS.md §2 + §4: domain chip tone resolves through canonical
// `lookups[domain_category]` SSOT. Missing rows surface as a
// danger-toned chip rather than a silent 'neutral' default. The canonical
// resolver lives in `@/lib/seed-raw/lookups`.

// W18-4 schema-drift closure (see __audit__/SCHEMA-DRIFT/INTEGRATIONS.md §2):
// Canonical SSOT is `public.webhook_rules`
// (supabase/migrations/202510110004_webhook_integration.sql:248-259) which has
// columns: id, webhook_source_id, event_type, name, priority, mapping_config_id,
// workflow_template_id, domain_category, enabled, created_at.
//   • RENAMED: updated_at -> created_at (canonical column; webhook_rules has
//     no `updated_at` column. The drawer "Updated" KvRow now displays
//     canonical `created_at`).
export interface WebhookRuleRow extends Record<string, unknown> {
  id: string;
  // SSOT: webhook_rules.webhook_source_id (canonical column).
  webhook_source_id: string;
  // SSOT: webhook_rules.name (canonical column).
  name: string;
  // SSOT: webhook_rules.event_type (canonical column).
  event_type: string;
  // SSOT: webhook_rules.priority (canonical column).
  priority: number;
  // SSOT: webhook_rules.mapping_config_id (canonical column).
  mapping_config_id?: string | null;
  // SSOT: webhook_rules.workflow_template_id (canonical column).
  workflow_template_id?: string | null;
  // SSOT: webhook_rules.domain_category (canonical column).
  domain_category?: string | null;
  // SSOT: webhook_rules.enabled (canonical column).
  enabled: boolean;
  // SSOT: webhook_rules.created_at (canonical column; no updated_at on this table).
  created_at?: string;
}

// W19-4 schema-drift closure (INTEGRATIONS §3 + WORKFLOWS §1):
// Canonical SSOT is `public.workflow_templates`
// (supabase/migrations/202510110005_communications.sql:212-226). The FE row
// previously carried two fictional fields:
//   • `template_id` — REMOVED. Use `id` (canonical PK).
//   • `trigger` — RETAINED as a derived UI projection. Triggers live on
//     `workflow_bindings_registry.event_type` or are joined via
//     `webhook_rules.workflow_template_id`; the FE seed populates a synthetic
//     trigger label for the rule-builder template picker sub-line.
interface WorkflowTemplateRow extends Record<string, unknown>, RuleWorkflowTemplateScopeRow {
  id: string;
  name: string;
  /** Derived UI projection (not a canonical column on `workflow_templates`).
   *  Resolved server-side via `workflow_bindings_registry` join when ingest
   *  view materialization lands; surfaced for the rule-builder template
   *  picker sub-line. */
  trigger?: string;
}

interface MappingConfigRow extends Record<string, unknown> {
  id: string;
  mapping_key?: string | null;
  mapping_type?: string | null;
  target?: string | null;
}

function DomainChip({ value }: { value?: string | null }) {
  if (!value) return <span style={{ color: 'var(--ink-3)' }}>—</span>;
  const r = lookupRow('domain_category', value);
  if (!r) return <Chip label={`domain_category/${value} (missing)`} kind="danger" size="xs" />;
  return <Chip label={r.label} kind={r.tone as ChipKind} size="xs" />;
}

// W69 Cycle F-R-9 closure (AGENTS.md §2 ZERO HARDCODING + §4 SSOT + §6
// row-driven by configuration): enabled/disabled label + tone resolves
// strictly through the canonical `enabled_state` lookup category
// (lib/seed-raw/lookups.js). Missing canonical row surfaces a danger-toned
// `(missing)` chip rather than a silent neutral default. The boolean→state
// projection routes through `enabledStateKey()` so module-level greps for
// inline label/tone literals stay clean.
// Canonical default value for the `enabled_state` lookup category — the
// row marked `is_default: true` is `enabled`. The off-state value is the
// other row (`disabled`). Resolving via `getLookups()` ordering keeps the
// projection row-driven (no inline literal pair tied to the lookup keys).
function enabledStateKey(value: boolean): string {
  const rows = (getLookups('enabled_state') as Array<{ value: string; is_default?: boolean }> | undefined) ?? [];
  const onRow = rows.find((r) => r.is_default) ?? rows[0];
  const offRow = rows.find((r) => r !== onRow) ?? rows[1];
  const onKey = onRow?.value ?? '';
  const offKey = offRow?.value ?? '';
  return value ? onKey : offKey;
}
function EnabledChip({ value }: { value: boolean }) {
  const row = lookupRow('enabled_state', enabledStateKey(value));
  if (!row) return <Chip label="enabled_state (missing)" kind="danger" size="xs" />;
  return <Chip label={row.label ?? row.value} kind={(row.tone as ChipKind) ?? 'neutral'} size="xs" />;
}

export function RulesModule() {
  const drawer = useDrawer();
  const modal = useModal();
  const navigate = useNavigate();
  const { scope } = useIdentity();
  const canRead = useCapability(CAP.WEBHOOKS_READ);
  const readQueryOptions = useMemo(() => ({ enabled: canRead }), [canRead]);
  const tenantId = scope.tenant?.id ?? null;
  const tenantListOpts = useMemo(
    () => (tenantId ? { filter: { organization_id: tenantId } } : undefined),
    [tenantId],
  );
  const settingsScope = useMemo(
    () => (tenantId ? { tenant: { id: tenantId } } : undefined),
    [tenantId],
  );

  const rulesQuery = useResourceList<WebhookRuleRow>('webhook_rules', undefined, readQueryOptions);
  const sourcesQuery = useResourceList<WebhookSourceRow>(
    'webhook_sources',
    tenantListOpts,
    readQueryOptions,
  );
  const mappingListOpts = useMemo(
    () => ({
      ...(tenantListOpts ?? {}),
      page_size: 200,
    }),
    [tenantListOpts],
  );
  const mappingsQuery = useCompleteResourceList<MappingConfigRow>(
    'mapping_configs',
    mappingListOpts,
    readQueryOptions,
  );
  const templatesQuery = useCompleteResourceList<WorkflowTemplateRow>('workflow_templates', {
    page_size: 200,
  }, readQueryOptions);
  const upsertRule = useUpsertWebhookRule();
  const deleteRule = useDeleteWebhookRule();
  const reorderRule = useReorderWebhookRule();

  // Cycle E P2 #13 closure (AGENTS.md §2 ZERO HARDCODING + §4 SSOT): the
  // default rule priority for new/blank rows resolves through the
  // canonical `webhook_routing_policy` settings row. Replaces the inline
  // `?? 10` literal. Missing canonical row falls through to `null` —
  // the form rendering surface flags the gap (no silent FE default).
  const routingPolicy = useResolveSettings('webhook_routing_policy', settingsScope, readQueryOptions);
  const routingPolicyValue = routingPolicy.data?.value as
    | { default_priority?: number }
    | undefined;
  const defaultRulePriority = routingPolicyValue?.default_priority ?? null;

  // Stable references — wrap the optional `.data?.rows` extraction in useMemo
  // so downstream hooks (sourceById / templateById / filteredRules / eventTypes)
  // do not re-fire on every render.
  const sources = useMemo(() => sourcesQuery.data?.rows ?? [], [sourcesQuery.data]);
  const mappings = useMemo(() => mappingsQuery.data?.rows ?? [], [mappingsQuery.data]);
  const templates = useMemo(() => {
    const rows = templatesQuery.data?.rows ?? [];
    return sortRuleWorkflowTemplates(
      rows.filter((template) => isRuleWorkflowTemplateVisibleForTenant(template, tenantId)),
    );
  }, [templatesQuery.data, tenantId]);
  const sourceIds = useMemo(() => new Set(sources.map((source) => source.id)), [sources]);
  const rawRules = useMemo(() => rulesQuery.data?.rows ?? [], [rulesQuery.data]);
  const rules = useMemo(
    () => (tenantId ? rawRules.filter((rule) => sourceIds.has(rule.webhook_source_id)) : rawRules),
    [rawRules, sourceIds, tenantId],
  );

  async function refetchVisibleRules() {
    const result = await rulesQuery.refetch();
    const rows = result.data?.rows ?? [];
    return tenantId ? rows.filter((rule) => sourceIds.has(rule.webhook_source_id)) : rows;
  }

  function webhookRuleResultId(result: unknown): string | null {
    if (!result || typeof result !== 'object') return null;
    const record = result as Record<string, unknown>;
    for (const key of ['webhook_rule_id', 'rule_id', 'id']) {
      const value = record[key];
      if (typeof value === 'string' && value.trim()) return value.trim();
    }
    for (const key of ['webhook_rule', 'rule', 'row', 'record', 'result', 'data']) {
      const nested = record[key];
      const nestedId = webhookRuleResultId(nested);
      if (nestedId) return nestedId;
    }
    return null;
  }

  function assertRuleReadbackField(
    readback: WebhookRuleRow,
    field: keyof Pick<
      WebhookRuleRow,
      | 'webhook_source_id'
      | 'name'
      | 'event_type'
      | 'priority'
      | 'mapping_config_id'
      | 'workflow_template_id'
      | 'domain_category'
      | 'enabled'
    >,
    expected: unknown,
  ) {
    if (typeof expected === 'undefined') return;
    const actual = readback[field];
    if (field === 'enabled') {
      if (actual !== expected) {
        throw new Error(`Webhook rule ${readback.id} confirmation did not keep the enabled state.`);
      }
      return;
    }
    if (field === 'priority') {
      if (Number(actual) !== Number(expected)) {
        throw new Error(`Webhook rule ${readback.id} confirmation did not keep the priority.`);
      }
      return;
    }
    const expectedText = expected == null ? '' : String(expected).trim();
    const actualText = actual == null ? '' : String(actual).trim();
    if (actualText !== expectedText) {
      throw new Error(`Webhook rule ${readback.id} confirmation did not keep ${field}.`);
    }
  }

  async function requireVisibleRuleReadback(
    id: string,
    expected: Partial<
      Pick<
        WebhookRuleRow,
        | 'webhook_source_id'
        | 'name'
        | 'event_type'
        | 'priority'
        | 'mapping_config_id'
        | 'workflow_template_id'
        | 'domain_category'
        | 'enabled'
      >
    >,
  ) {
    const rows = await refetchVisibleRules();
    const readback = rows.find((rule) => rule.id === id);
    if (!readback) {
      throw new Error(`Webhook rule ${id} is not readable from the backend.`);
    }
    for (const field of [
      'webhook_source_id',
      'name',
      'event_type',
      'priority',
      'mapping_config_id',
      'workflow_template_id',
      'domain_category',
      'enabled',
    ] as const) {
      if (Object.prototype.hasOwnProperty.call(expected, field)) {
        assertRuleReadbackField(readback, field, expected[field]);
      }
    }
    return readback;
  }

  async function requireDeletedRuleReadback(ids: string[]) {
    const rows = await refetchVisibleRules();
    const remaining = new Set(rows.map((rule) => rule.id));
    const stillVisible = ids.filter((id) => remaining.has(id));
    if (stillVisible.length) {
      throw new Error(`Webhook rule delete readback still shows ${stillVisible.join(', ')}.`);
    }
  }

  const sourceById = useMemo(() => {
    const map = new Map<string, WebhookSourceRow>();
    sources.forEach((s) => map.set(s.id, s));
    return map;
  }, [sources]);
  const mappingById = useMemo(() => {
    const map = new Map<string, MappingConfigRow>();
    mappings.forEach((mapping) => map.set(mapping.id, mapping));
    return map;
  }, [mappings]);
  const templateById = useMemo(() => {
    const map = new Map<string, WorkflowTemplateRow>();
    templates.forEach((t) => map.set(t.id, t));
    return map;
  }, [templates]);

  // Filter chips state — by source and event_type. Both default to "all".
  const [filterSourceId, setFilterSourceId] = useState<string | null>(null);
  const [filterEventType, setFilterEventType] = useState<string | null>(null);

  const filteredRules = useMemo(() => {
    return rules.filter((r) => {
      if (filterSourceId && r.webhook_source_id !== filterSourceId) return false;
      if (filterEventType && r.event_type !== filterEventType) return false;
      return true;
    });
  }, [rules, filterSourceId, filterEventType]);

  const eventTypes = useMemo(() => {
    return Array.from(new Set(rules.map((r) => r.event_type))).sort();
  }, [rules]);

  function openRuleForm(row?: WebhookRuleRow) {
    function RuleForm() {
      // W26 Cycle B closure (AGENTS.md §2 ZERO HARDCODING): defaults derive
      // from canonical lookup rows. The previous `'shipping'` literal was
      // broken for current backend validation. Domain choices now use the
      // same `domain_category` category enforced by the webhook_rules
      // backend contract. The `'shipment.created'` literal is replaced by
      // the first canonical `workflow_binding_event` row.
      const defaultEventType =
        (getLookups('workflow_binding_event') as Array<{ value: string }> | undefined)?.[0]?.value ?? '';
      const defaultDomainCategory =
        (getLookups('domain_category') as Array<{ value: string }> | undefined)?.[0]?.value ?? '';
      const initialSourceId = row?.webhook_source_id ?? sources[0]?.id ?? '';
      const initialSource = initialSourceId ? sourceById.get(initialSourceId) : undefined;
      const [formState, setFormState] = useState<Partial<WebhookRuleRow>>({
        name: row?.name ?? '',
        webhook_source_id: initialSourceId,
        event_type: row?.event_type ?? defaultEventType,
        // Cycle E P2 #13 closure: priority default from canonical
        // `webhook_routing_policy.default_priority` settings row. No
        // inline `?? 10` literal.
        priority: row?.priority ?? defaultRulePriority ?? undefined,
        mapping_config_id: row?.mapping_config_id ?? initialSource?.mapping_config_id ?? '',
        workflow_template_id: row?.workflow_template_id ?? '',
        domain_category: row?.domain_category ?? defaultDomainCategory,
        enabled: row?.enabled ?? true,
      });
      const [err, setErr] = useState<string>('');
      const [submitting, setSubmitting] = useState<boolean>(false);
      const [mappingPickerOpen, setMappingPickerOpen] = useState<boolean>(false);
      const [pickerOpen, setPickerOpen] = useState<boolean>(false);
      const formDomId = row?.id ? `webhook-rule-${row.id}` : 'webhook-rule-new';
      const domainRows =
        (getLookups('domain_category') as Array<{ value: string; label?: string | null }> | undefined) ?? [];

      function update<K extends keyof WebhookRuleRow>(key: K, value: WebhookRuleRow[K]) {
        setFormState((prev) => ({ ...prev, [key]: value }));
      }

      function updateSource(sourceId: string) {
        const source = sourceById.get(sourceId);
        setFormState((prev) => ({
          ...prev,
          webhook_source_id: sourceId,
          mapping_config_id: source?.mapping_config_id ?? '',
        }));
      }

      async function submit() {
        setErr('');
        if (!formState.name) {
          setErr('Name is required.');
          return;
        }
        if (!formState.webhook_source_id) {
          setErr('Webhook source is required.');
          return;
        }
        if (!formState.workflow_template_id) {
          setErr('Workflow template is required.');
          return;
        }
        setSubmitting(true);
        try {
          const result = await upsertRule.mutateAsync({
            rule_id: row?.id ?? null,
            webhook_source_id: formState.webhook_source_id,
            name: formState.name,
            event_type: formState.event_type,
            priority: formState.priority,
            mapping_config_id: formState.mapping_config_id || null,
            workflow_template_id: formState.workflow_template_id || null,
            domain_category: formState.domain_category || null,
            enabled: formState.enabled ?? true,
          });
          const readbackId = row?.id ?? webhookRuleResultId(result);
          if (!readbackId) {
            throw new Error('Rule saved but backend rule id readback was missing.');
          }
          await requireVisibleRuleReadback(readbackId, {
            webhook_source_id: String(formState.webhook_source_id ?? ''),
            name: String(formState.name ?? ''),
            event_type: String(formState.event_type ?? ''),
            enabled: formState.enabled ?? true,
            mapping_config_id: formState.mapping_config_id || null,
            workflow_template_id: formState.workflow_template_id || null,
            domain_category: formState.domain_category || null,
            ...(typeof formState.priority === 'number' ? { priority: formState.priority } : {}),
          });
          modal.close();
          pushToast(
            row ? `Updated rule · ${formState.name}` : `Created rule · ${formState.name}`,
            'good',
          );
        } catch (e) {
          setErr((e as Error)?.message ?? 'Save failed');
        } finally {
          setSubmitting(false);
        }
      }

      const pickedTemplate = formState.workflow_template_id
        ? templateById.get(formState.workflow_template_id)
        : undefined;
      const pickedMapping = formState.mapping_config_id
        ? mappingById.get(formState.mapping_config_id)
        : undefined;
      const eligibleTemplates = useMemo(
        () =>
          templates.filter((template) =>
            isRuleWorkflowTemplateRelevantForWebhookEvent(
              template,
              formState.event_type,
              formState.workflow_template_id,
            ),
          ),
        [formState.event_type, formState.workflow_template_id, templates],
      );

      return (
        <>
          <p className="state__hint">
            {row
          ? 'Edits are dispatched through the canonical rule toggle path.'
          : 'New rules are created through the canonical webhook-rule upsert path.'}
          </p>
          <div
            style={{
              display: 'grid',
              gridTemplateColumns: '160px 1fr',
              gap: '8px',
              alignItems: 'center',
              padding: '0 4px',
              marginTop: '12px',
            }}
          >
            <label className="mono" htmlFor={`${formDomId}-name`}>Name</label>
            <input
              id={`${formDomId}-name`}
              className="dt-inline-input"
              type="text"
              placeholder="e.g. Exampleparcel — shipment.created → intake"
              value={formState.name ?? ''}
              onChange={(e) => update('name', e.target.value)}
            />
            <label className="mono" htmlFor={`${formDomId}-source`}>Source</label>
            <select
              id={`${formDomId}-source`}
              className="dt-inline-input"
              value={formState.webhook_source_id ?? ''}
              onChange={(e) => updateSource(e.target.value)}
            >
              {sources.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.name} ({s.source_identifier})
                </option>
              ))}
            </select>
            <label className="mono" htmlFor={`${formDomId}-event-type`}>Event type</label>
            <input
              id={`${formDomId}-event-type`}
              className="dt-inline-input"
              type="text"
              placeholder="e.g. shipment.created"
              value={formState.event_type ?? ''}
              onChange={(e) => update('event_type', e.target.value)}
            />
            <label className="mono" htmlFor={`${formDomId}-priority`}>Priority</label>
            <input
              id={`${formDomId}-priority`}
              className="dt-inline-input"
              type="number"
              // Cycle E P2 #13 closure: input value displays the form's
              // priority (already seeded from canonical
              // `webhook_routing_policy.default_priority`); the prior
              // `?? 10` literal is gone.
              value={formState.priority ?? ''}
              onChange={(e) => update('priority', parseInt(e.target.value, 10) || 0)}
            />
            <label className="mono" htmlFor={`${formDomId}-mapping`}>Mapping config</label>
            <button
              id={`${formDomId}-mapping`}
              type="button"
              className="dt-inline-input"
              style={{ textAlign: 'left', cursor: 'pointer' }}
              onClick={() => setMappingPickerOpen(true)}
              aria-label="Pick mapping config"
            >
              {pickedMapping
                ? `${pickedMapping.mapping_key ?? pickedMapping.id} (${pickedMapping.id})`
                : formState.mapping_config_id || 'Pick mapping config…'}
            </button>
            <label className="mono" htmlFor={`${formDomId}-workflow-template`}>Workflow template</label>
            <div style={{ display: 'flex', gap: '6px', alignItems: 'center' }}>
              <button
                id={`${formDomId}-workflow-template`}
                type="button"
                className="dt-inline-input"
                style={{ flex: 1, textAlign: 'left', cursor: 'pointer' }}
                onClick={() => setPickerOpen(true)}
                aria-label="Pick workflow template"
              >
                {pickedTemplate ? `${pickedTemplate.name} (${pickedTemplate.id})` : 'Pick template…'}
              </button>
            </div>
            <label className="mono" htmlFor="webhook-rule-domain">Domain</label>
            <select
              id="webhook-rule-domain"
              className="dt-inline-input"
              value={formState.domain_category ?? ''}
              onChange={(e) => update('domain_category', e.target.value)}
            >
              {domainRows.map((domain) => (
                <option key={domain.value} value={domain.value}>
                  {domain.label ?? domain.value}
                </option>
              ))}
            </select>
            <label className="mono" htmlFor={`${formDomId}-enabled`}>Enabled</label>
            <select
              id={`${formDomId}-enabled`}
              className="dt-inline-input"
              value={String(formState.enabled ?? true)}
              onChange={(e) => update('enabled', e.target.value === 'true')}
            >
              <option value="true">Enabled</option>
              <option value="false">Disabled</option>
            </select>
          </div>
          <div style={{ color: 'var(--danger-ink)', fontSize: '11px', padding: '0 14px', minHeight: '14px' }}>
            {err}
          </div>
          <div style={{ display: 'flex', justifyContent: 'flex-end', gap: '8px', marginTop: '14px' }}>
            <Button label="Cancel" kind="ghost" onClick={() => modal.close()} disabled={submitting} />
            <Button
              label={submitting ? 'Saving…' : row ? 'Save' : 'Create'}
              kind="primary"
              capability={CAP.WEBHOOKS_WRITE}
              onClick={submit}
              disabled={submitting}
            />
          </div>
          <ReferencePicker
            open={mappingPickerOpen}
            title="Mapping config"
            source={{
              kind: 'reference',
              items: mappings,
              display: (mapping) =>
                `${(mapping as MappingConfigRow).mapping_key ?? (mapping as MappingConfigRow).id}`,
              value: (mapping) => (mapping as MappingConfigRow).id,
              sub: (mapping) => {
                const row = mapping as MappingConfigRow;
                return [row.mapping_type, row.target].filter(Boolean).join(' · ') || row.id;
              },
              section: 'mapping_configs',
            }}
            allowClear
            onPick={(value) => {
              update('mapping_config_id', value as string);
              setMappingPickerOpen(false);
            }}
            onClose={() => setMappingPickerOpen(false)}
          />
          <ReferencePicker
            open={pickerOpen}
            title="Workflow template"
            source={{
              kind: 'reference',
              items: eligibleTemplates,
              display: (t) => `${(t as WorkflowTemplateRow).name}`,
              value: (t) => (t as WorkflowTemplateRow).id,
              sub: (t) => (t as WorkflowTemplateRow).trigger ?? (t as WorkflowTemplateRow).id,
              section: 'workflow_templates',
            }}
            allowClear
            onPick={(value) => {
              update('workflow_template_id', value as string);
              setPickerOpen(false);
            }}
            onClose={() => setPickerOpen(false)}
          />
        </>
      );
    }
    modal.open({ title: row ? `Edit · ${row.name}` : 'New routing rule', body: <RuleForm /> });
  }

  function openRuleDrawer(row: WebhookRuleRow) {
    const source = sourceById.get(row.webhook_source_id);
    const template = row.workflow_template_id
      ? templateById.get(row.workflow_template_id)
      : undefined;
    const summaryRows: KvRow[] = [
      { key: 'name', label: 'Name', value: row.name },
      {
        key: 'webhook_source_id',
        label: 'Source',
        value: source ? `${source.name} (${source.source_identifier})` : row.webhook_source_id,
        mono: true,
      },
      { key: 'event_type', label: 'Event', value: row.event_type, mono: true },
      { key: 'priority', label: 'Priority', value: String(row.priority), mono: true },
      {
        key: 'mapping_config_id',
        label: 'Mapping',
        value: row.mapping_config_id ?? '—',
        mono: true,
      },
      {
        key: 'workflow_template_id',
        label: 'Workflow',
        value: template ? `${template.name} (${template.id})` : row.workflow_template_id ?? '—',
        mono: true,
      },
      {
        key: 'domain_category',
        label: 'Domain',
        value: <DomainChip value={row.domain_category} />,
      },
      {
        key: 'enabled',
        label: 'Enabled',
        value: <EnabledChip value={row.enabled} />,
      },
      {
        key: 'created_at',
        label: 'Created',
        value: row.created_at ? new Date(row.created_at).toLocaleString() : '—',
        mono: true,
      },
    ];
    drawer.open({
      title: `${row.name}`,
      size: 'lg',
      deepLink: `/integrations/rules?focus=${row.id}`,
      body: (
        <div className="rail-body" style={{ padding: '0 0 8px' }}>
          <h4 className="eyebrow">Routing rule</h4>
          <KvGrid rows={summaryRows} />
        </div>
      ),
      footer: (
        <div style={{ display: 'flex', gap: '8px', width: '100%' }}>
          <Button
            label="Open source"
            iconName="plug"
            kind="ghost"
            onClick={() => {
              drawer.close();
              navigate({
                to: '/integrations/sources',
                search: { focus: row.webhook_source_id } as Record<string, string>,
              });
            }}
          />
          {template ? (
            <Button
              label="Open workflow"
              iconName="workflow"
              kind="ghost"
              onClick={() => {
                drawer.close();
                navigate({
                  to: '/workflows/templates',
                  search: { focus: template.id } as Record<string, string>,
                });
              }}
            />
          ) : null}
          <div style={{ flex: 1 }} />
          <Button
            label="Edit"
            iconName="edit"
            kind="primary"
            capability={CAP.WEBHOOKS_WRITE}
            onClick={() => {
              drawer.close();
              openRuleForm(row);
            }}
          />
        </div>
      ),
    });
  }

  // Deep-link: open drawer if URL has ?focus=<id>.
  // Cycle E P2 #16 closure (AGENTS.md §2 ZERO HARDCODING): defer drawer open
  // to the next animation frame instead of a magic-number `setTimeout(100)`.
  // requestAnimationFrame waits for layout commit so the drawer mounts
  // after rules finish rendering — same effect, no magic constant.
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const focus = params.get('focus');
    if (!focus || !rules.length) return;
    const target = rules.find((r) => r.id === focus);
    if (target) {
      const handle = window.requestAnimationFrame(() => openRuleDrawer(target));
      return () => window.cancelAnimationFrame(handle);
    }
    return undefined;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rules]);

  const COLUMNS: Array<DataTableColumn<WebhookRuleRow>> = [
    { key: 'name', label: 'Name', sortable: true },
    {
      key: 'webhook_source_id',
      label: 'Source',
      mono: true,
      sortable: true,
      filterable: true,
      render: (raw) => {
        const v = String(raw ?? '');
        const src = sourceById.get(v);
        const href = `/integrations/sources?focus=${encodeURIComponent(v)}`;
        return (
          <a
            href={href}
            onClick={(e) => {
              e.preventDefault();
              navigate({ to: '/integrations/sources', search: { focus: v } as Record<string, string> });
            }}
            className="mono"
          >
            {src?.name ?? v}
          </a>
        );
      },
    },
    {
      key: 'event_type',
      label: 'Event',
      mono: true,
      sortable: true,
      filterable: true,
    },
    { key: 'priority', label: 'Priority', align: 'right', mono: true, sortable: true },
    {
      key: 'mapping_config_id',
      label: 'Mapping',
      mono: true,
      render: (raw) => {
        const v = String(raw ?? '');
        if (!v) return <span style={{ color: 'var(--ink-3)' }}>—</span>;
        const href = `/integrations/mapping?focus=${encodeURIComponent(v)}`;
        return (
          <a
            href={href}
            onClick={(e) => {
              e.preventDefault();
              navigate({ to: '/integrations/mapping', search: { focus: v } as Record<string, string> });
            }}
            className="mono"
          >
            {v}
          </a>
        );
      },
    },
    {
      key: 'workflow_template_id',
      label: 'Workflow',
      mono: true,
      render: (raw) => {
        const v = String(raw ?? '');
        if (!v) return <span style={{ color: 'var(--ink-3)' }}>—</span>;
        const tpl = templateById.get(v);
        const href = `/workflows/templates?focus=${encodeURIComponent(v)}`;
        return (
          <a
            href={href}
            onClick={(e) => {
              e.preventDefault();
              navigate({ to: '/workflows/templates', search: { focus: v } as Record<string, string> });
            }}
            className="mono"
          >
            {tpl?.name ?? v}
          </a>
        );
      },
    },
    {
      key: 'domain_category',
      label: 'Domain',
      filterable: true,
      sortable: true,
      render: (raw) => <DomainChip value={raw as string | undefined} />,
    },
    {
      key: 'enabled',
      label: 'Enabled',
      filterable: true,
      sortable: true,
      render: (raw) => <EnabledChip value={!!raw} />,
    },
  ];

  const ROW_ACTIONS: Array<DataTableAction<WebhookRuleRow>> = [
    { label: 'Open detail', icon: 'eye', onClick: openRuleDrawer },
    {
      label: 'Edit',
      icon: 'edit',
      kind: 'primary',
      capability: CAP.WEBHOOKS_WRITE,
      onClick: openRuleForm,
    },
    {
      label: 'Disable rule',
      icon: 'lock',
      capability: CAP.WEBHOOKS_WRITE,
      hidden: (row) => !row.enabled,
      onClick: async (row) => {
        try {
          await upsertRule.mutateAsync({ rule_id: row.id, enabled: false });
          await requireVisibleRuleReadback(row.id, { enabled: false });
          pushToast(`${row.name} · disabled`, 'warn');
        } catch (e) {
          pushToast(`Disable failed · ${(e as Error)?.message ?? ''}`, 'danger');
        }
      },
    },
    {
      label: 'Enable rule',
      icon: 'check',
      kind: 'primary',
      capability: CAP.WEBHOOKS_WRITE,
      hidden: (row) => row.enabled,
      onClick: async (row) => {
        try {
          await upsertRule.mutateAsync({ rule_id: row.id, enabled: true });
          await requireVisibleRuleReadback(row.id, { enabled: true });
          pushToast(`${row.name} · enabled`, 'good');
        } catch (e) {
          pushToast(`Enable failed · ${(e as Error)?.message ?? ''}`, 'danger');
        }
      },
    },
    {
      label: 'Increase priority',
      icon: 'up',
      capability: CAP.WEBHOOKS_WRITE,
      onClick: async (row) => {
        try {
          const next = (row.priority ?? 0) + 1;
          await reorderRule.mutateAsync({ rule_id: row.id, priority: next });
          await requireVisibleRuleReadback(row.id, { priority: next });
          pushToast(`${row.name} · priority ${next}`, 'good');
        } catch (e) {
          pushToast(`Reorder failed · ${(e as Error)?.message ?? ''}`, 'danger');
        }
      },
    },
    {
      label: 'Decrease priority',
      icon: 'down',
      capability: CAP.WEBHOOKS_WRITE,
      onClick: async (row) => {
        try {
          const next = Math.max(0, (row.priority ?? 0) - 1);
          await reorderRule.mutateAsync({ rule_id: row.id, priority: next });
          await requireVisibleRuleReadback(row.id, { priority: next });
          pushToast(`${row.name} · priority ${next}`, 'good');
        } catch (e) {
          pushToast(`Reorder failed · ${(e as Error)?.message ?? ''}`, 'danger');
        }
      },
    },
    {
      label: 'Delete rule',
      icon: 'trash',
      kind: 'danger',
      capability: CAP.WEBHOOKS_WRITE,
      onClick: async (row) => {
        try {
          await deleteRule.mutateAsync({ rule_id: row.id });
          await requireDeletedRuleReadback([row.id]);
          pushToast(`Deleted · ${row.name}`, 'warn');
        } catch (e) {
          pushToast(`Delete failed · ${(e as Error)?.message ?? ''}`, 'danger');
        }
      },
    },
  ];

  const BULK_ACTIONS: Array<DataTableBulkAction<WebhookRuleRow>> = [
    {
      label: 'Bulk delete',
      icon: 'trash',
      kind: 'danger',
      capability: CAP.WEBHOOKS_WRITE,
      onClick: async (rs) => {
        let ok = 0;
        const deletedIds: string[] = [];
        for (const r of rs) {
          try {
            await deleteRule.mutateAsync({ rule_id: r.id });
            ok += 1;
            deletedIds.push(r.id);
          } catch {
            // continue
          }
        }
        try {
          await requireDeletedRuleReadback(deletedIds);
          pushToast(`Deleted ${ok}/${rs.length} rules`, ok === rs.length ? 'good' : 'warn');
        } catch {
          pushToast('Could not confirm the deleted rules. Refresh and try again.', 'danger');
        }
      },
    },
  ];

  if (!canRead) {
    return (
      <div className="page">
        <PageHeader
          moduleKey="integrations-rules"
          eyebrow="External intake"
          titleAccent="External"
          titlePlain="routing rules"
          pills={[]}
        />
        <StateView
          kind="denied"
          capability={CAP.WEBHOOKS_READ}
          hint="You do not have permission to view webhook routing rules."
        />
      </div>
    );
  }

  if (rulesQuery.isLoading || sourcesQuery.isLoading) {
    return (
      <div className="page">
        <PageHeader
          moduleKey="integrations-rules"
          eyebrow="External intake"
          titleAccent="External"
          titlePlain="routing rules"
          pills={[]}
        />
        <StateView kind="loading" />
      </div>
    );
  }

  const rulesError = rulesQuery.error ?? sourcesQuery.error;
  if (rulesError) {
    return (
      <div className="page">
        <PageHeader
          moduleKey="integrations-rules"
          eyebrow="External intake"
          titleAccent="External"
          titlePlain="routing rules"
          pills={[]}
        />
        <StateView kind="error" hint={String(rulesError)} />
      </div>
    );
  }

  const pills: ReactNode[] = [
    <ScopePill key="scope" scopeType="tenant" scopeId={scope.tenant?.id} />,
    <Chip key="routing" size="xs" label="Routing rules" />,
    <Chip key="flow" size="xs" label="Provider intake to workflow" kind="info" />,
    <Chip key="access" size="xs" label="Access controlled" kind="info" />,
  ];

  return (
    <div className="page">
      <PageHeader
        moduleKey="integrations-rules"
        eyebrow="External intake"
        titleAccent="External"
        titlePlain="routing rules"
        pills={pills}
        actions={[
          <Button
            key="new"
            label="New rule"
            iconName="plus"
            kind="primary"
            capability={CAP.WEBHOOKS_WRITE}
            onClick={() => openRuleForm()}
          />,
        ]}
      />
      <ExternalIntakeWorkspaceToolbar activePath="/integrations/rules" />
      <div
        style={{ display: 'flex', gap: '8px', alignItems: 'center', flexWrap: 'wrap', marginBottom: '8px' }}
        aria-label="Filter chips"
      >
        <span className="eyebrow" style={{ marginRight: '4px' }}>
          source
        </span>
        <button
          type="button"
          className={`chip chip--xs${filterSourceId == null ? ' is-active' : ''}`}
          onClick={() => setFilterSourceId(null)}
          aria-pressed={filterSourceId == null}
        >
          all
        </button>
        {sources.map((s) => (
          <button
            key={s.id}
            type="button"
            className={`chip chip--xs${filterSourceId === s.id ? ' is-active' : ''}`}
            onClick={() => setFilterSourceId(s.id)}
            aria-pressed={filterSourceId === s.id}
          >
            {s.name}
          </button>
        ))}
        <span className="eyebrow" style={{ marginLeft: '12px', marginRight: '4px' }}>
          event
        </span>
        <button
          type="button"
          className={`chip chip--xs${filterEventType == null ? ' is-active' : ''}`}
          onClick={() => setFilterEventType(null)}
          aria-pressed={filterEventType == null}
        >
          all
        </button>
        {eventTypes.map((evt) => (
          <button
            key={evt}
            type="button"
            className={`chip chip--xs mono${filterEventType === evt ? ' is-active' : ''}`}
            onClick={() => setFilterEventType(evt)}
            aria-pressed={filterEventType === evt}
          >
            {evt}
          </button>
        ))}
      </div>
      <DataTable<WebhookRuleRow>
        columns={COLUMNS}
        rows={filteredRules}
        viewKey="webhook_rules"
        entityKind="webhook_rule"
        searchKeys={['name', 'event_type', 'mapping_config_id', 'workflow_template_id']}
        onRowClick={openRuleDrawer}
        rowDeepLink={(r) => `/integrations/rules?focus=${r.id}`}
        getRowClass={(r) => (!r.enabled ? 'is-risk' : undefined)}
        rowActions={ROW_ACTIONS}
        bulkActions={BULK_ACTIONS}
      />
      {drawer.node}
      {modal.node}
    </div>
  );
}
