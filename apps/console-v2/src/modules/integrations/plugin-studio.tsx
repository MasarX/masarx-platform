// integrations/plugin-studio.tsx — 4-stage authoring loop for integration plugins.
//
// CLAIM-INTEGRATIONS-WORKFLOWS-WIRING (Wave 12 W12-2 — INTEGRATIONS P0 #3
// closure): the `integration-plugin-studio` edge function exposes 4 endpoints
// (parse → infer → preview → save) which the operator walks through to onboard
// a new integration plugin from a curl command, OpenAPI document, or webhook
// sample payload.
//
// Backed by:
//   - supabase/functions/integration-plugin-studio/index.ts (edge fn SSOT)
//   - api.plugin_studio_parse_v1 / infer / preview / save (data-source seam)
//   - capability gates: integration_plugins.write (Parse/Infer/Save buttons),
//     mappings.write (Preview/Save for tabular/webhook artifacts),
//     integration_plugins.write (Save when artifact=integration_plugin)
//
// Each stage's output feeds the next stage's input, so the `normalized_contract`
// flows through unchanged once produced; `mapping_config` accumulates edits
// from the operator between Infer and Preview; `review` (diagnostics + save
// modes) gates the Save button — blocking diagnostics make Save fail-closed.

import { useEffect, useMemo, useState } from 'react';
import { useNavigate } from '@tanstack/react-router';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { PageHeader } from '@/components/PageHeader';
import { Button } from '@/components/Button';
import { Chip } from '@/components/Chip';
import { StateView } from '@/components/StateView';
import { pushToast } from '@/components/toastStore';
import * as api from '@/lib/api';
import { useCapability, useIdentity } from '@/lib/identity';
import { CAP } from '@/lib/capabilities';
import {
  redactIntegrationSourceTextForDisplay,
} from './secret-redaction';
import { fill, useI18n } from '@/lib/i18n';

type Stage = 'idle' | 'parsing' | 'parsed' | 'inferring' | 'inferred' | 'previewing' | 'previewed' | 'saving' | 'saved' | 'error';

interface StudioSourceTypeRow {
  value: string;
  label?: string;
  rank?: number;
  metadata?: { sample?: string; payload_mode?: string };
}

interface StudioPluginKindRow {
  value: string;
  label?: string;
  rank?: number;
  is_default?: boolean;
  metadata?: { hint?: string };
}

interface SavedPluginResource {
  pluginId: string | null;
  pluginVersionId: string | null;
  reportId: string | null;
  workflowMode: string | null;
  workflowIntent: string | null;
  workflowTemplateName: string | null;
}

interface SavedPluginCatalogReadback {
  pluginId: string | null;
  pluginVersionId: string | null;
  pluginVisible: boolean;
  directoryVisible: boolean;
  versionVisible: boolean;
  pluginStatus: string | null;
  directoryStatus: string | null;
  versionStatus: string | null;
  requestedAt: string;
  error?: string | null;
}

function studioText(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function studioRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function savedPluginResourceFromSaveResult(
  saveResult: api.PluginStudioSaveResult | null,
): SavedPluginResource {
  const result = studioRecord(saveResult?.result);
  const report = studioRecord(saveResult?.report);
  const resultPayload = studioRecord(report.result_payload);
  const workflowBinding = Object.keys(studioRecord(result.workflow_binding)).length
    ? studioRecord(result.workflow_binding)
    : studioRecord(resultPayload.workflow_binding);
  return {
    pluginId: studioText(result.plugin_id),
    pluginVersionId: studioText(result.plugin_version_id) ?? studioText(result.version_id),
    reportId:
      studioText(report.mapping_operation_report_id)
      ?? studioText(report.operation_report_id)
      ?? studioText(report.report_id)
      ?? studioText(report.id),
    workflowMode: studioText(workflowBinding.mode),
    workflowIntent: studioText(workflowBinding.intent),
    workflowTemplateName: studioText(workflowBinding.template_name),
  };
}

function normalizeLookupOrder<T extends { value: string; label?: string; rank?: number }>(rows: T[]): T[] {
  return [...rows]
    .filter((row) => row.value)
    .sort((a, b) => (a.rank ?? 999) - (b.rank ?? 999) || (a.label ?? a.value).localeCompare(b.label ?? b.value));
}
// Cycle E P1 #12 closure (AGENTS.md §2 ZERO HARDCODING + §4 SSOT): the
// source-type taxonomy (curl/openapi/webhook_sample/manual) and the
// per-row sample payload now resolve through the canonical
// `plugin_studio_source_type` lookup category (see lookups.js). The
// `SourceType` literal-union is collapsed to `string` so seed updates
// flow through one SSOT.
type SourceType = string;
// Cycle E2 P2 closure (AGENTS.md §2 ZERO HARDCODING + §4 SSOT): the
// studio plugin-kind taxonomy (api outbound / webhook inbound) resolves
// through the canonical `plugin_studio_plugin_kind` lookup category
// (see lookups.js). The previous literal-union type is collapsed to
// `string` so seed updates flow through one SSOT.
type PluginKind = string;

export function PluginStudioModule() {
  const { t } = useI18n();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const identity = useIdentity();
  const canRead = useCapability(CAP.INTEGRATION_PLUGINS_READ);
  const activeOrganizationId = identity.currentTenantId()?.trim() || undefined;
  const seedDiagnosticsEnabled = api.isConsoleSeedModeEnabled();
  const liveBackendUnavailable = !seedDiagnosticsEnabled && !api.hasConsoleLiveBackend();
  const liveLookupEnabled = api.hasConsoleLiveBackend();
  const sourceTypeLookupQuery = useQuery({
    queryKey: ['lookup', 'plugin_studio_source_type', 'live'],
    queryFn: () => api.getLookupsLive('plugin_studio_source_type'),
    enabled: liveLookupEnabled,
  });
  const pluginKindLookupQuery = useQuery({
    queryKey: ['lookup', 'plugin_studio_plugin_kind', 'live'],
    queryFn: () => api.getLookupsLive('plugin_studio_plugin_kind'),
    enabled: liveLookupEnabled,
  });
  // Canonical source-type rows resolved from the lookup SSOT. Each row
  // carries `metadata.sample` (canonical sample payload string per source)
  // and `metadata.payload_mode` (`wrap_curl` | `parse_json`) consumed by
  // buildSourcePayload below. Cycle F-R Integrations P1-1 closure
  // (AGENTS.md §2 ZERO HARDCODING + §4 SSOT): the literal
  // `sourceType === 'curl'` branch is replaced by the canonical
  // payload_mode lookup so seed updates flow through one SSOT.
  const sourceTypeRows = useMemo<StudioSourceTypeRow[]>(() => {
    const liveRows = normalizeLookupOrder((sourceTypeLookupQuery.data ?? []) as StudioSourceTypeRow[]);
    if (liveRows.length > 0) return liveRows;
    return normalizeLookupOrder((api.getLookups('plugin_studio_source_type') ?? []) as StudioSourceTypeRow[]);
  }, [sourceTypeLookupQuery.data]);
  const defaultSourceType = sourceTypeRows[0]?.value ?? '';
  const defaultSample =
    (sourceTypeRows.find((r) => r.value === defaultSourceType)?.metadata?.sample) ?? '';
  const [sourceType, setSourceType] = useState<SourceType>(defaultSourceType);
  const [sourceText, setSourceText] = useState<string>(defaultSample);
  // pluginKind taxonomy — the studio's semantic 'api' (outbound) vs
  // 'webhook' (inbound) selection — resolves through the canonical
  // `plugin_studio_plugin_kind` lookup category (see lookups.js). The
  // edge-fn contract still requires one of these values; the default
  // selection comes from the `is_default: true` row (no inline 'api'
  // literal). Distinct from the canonical `integration_plugin_kind`
  // (carrier/marketplace/crm/...) which is a different domain enum.
  const pluginKindRows = useMemo<StudioPluginKindRow[]>(() => {
    const liveRows = normalizeLookupOrder((pluginKindLookupQuery.data ?? []) as StudioPluginKindRow[]);
    if (liveRows.length > 0) return liveRows;
    return normalizeLookupOrder((api.getLookups('plugin_studio_plugin_kind') ?? []) as StudioPluginKindRow[]);
  }, [pluginKindLookupQuery.data]);
  const defaultPluginKind =
    pluginKindRows.find((r) => r.is_default)?.value ?? '';
  const [pluginKind, setPluginKind] = useState<PluginKind>(defaultPluginKind);
  const [pluginName, setPluginName] = useState<string>('');

  const [stage, setStage] = useState<Stage>('idle');
  const [errMsg, setErrMsg] = useState<string | null>(null);

  const [contract, setContract] = useState<api.PluginStudioNormalizedContract | null>(null);
  const [mappingSuggestion, setMappingSuggestion] = useState<Record<string, unknown> | null>(null);
  const [outboundSuggestions, setOutboundSuggestions] = useState<Array<Record<string, unknown>>>([]);
  const [review, setReview] = useState<api.PluginStudioReview | null>(null);
  const [saveModes, setSaveModes] = useState<api.PluginStudioPreviewResult['save_modes'] | null>(null);
  const [saveResult, setSaveResult] = useState<api.PluginStudioSaveResult | null>(null);
  const [catalogReadback, setCatalogReadback] = useState<SavedPluginCatalogReadback | null>(null);

  useEffect(() => {
    if (!sourceType && defaultSourceType) {
      setSourceType(defaultSourceType);
    }
    if (!sourceText && defaultSample) {
      setSourceText(defaultSample);
    }
  }, [defaultSample, defaultSourceType, sourceText, sourceType]);

  useEffect(() => {
    if (!pluginKind && defaultPluginKind) {
      setPluginKind(defaultPluginKind);
    }
  }, [defaultPluginKind, pluginKind]);

  const artifact: api.PluginStudioArtifact = 'integration_plugin';
  const blockingCount = review?.review_summary?.blocking_count ?? 0;
  const recommendedSaveMode = saveModes?.recommended ?? null;
  const savedResource = useMemo(
    () => savedPluginResourceFromSaveResult(saveResult),
    [saveResult],
  );

  function buildSourcePayload(): unknown {
    // Cycle F-R Integrations P1-1 closure (AGENTS.md §2 ZERO HARDCODING +
    // §4 SSOT): wrap/parse behavior reads from the canonical
    // `plugin_studio_source_type[<sourceType>].metadata.payload_mode`
    // (`wrap_curl` | `parse_json`) instead of a literal
    // `sourceType === 'curl'` branch. Missing metadata fails loud so seed
    // gaps surface immediately rather than silently producing the raw text.
    const sourceTypeRow = sourceTypeRows.find((r) => r.value === sourceType);
    const payloadMode = sourceTypeRow?.metadata?.payload_mode;
    if (payloadMode === 'wrap_curl') {
      return { curl: sourceText };
    }
    if (payloadMode === 'parse_json') {
      try {
        return JSON.parse(sourceText);
      } catch {
        // Fall through — the edge fn surfaces a structured parse error.
        return sourceText;
      }
    }
    // Fail-loud: missing canonical payload_mode → surface raw text so the
    // edge fn returns a structured error and operators see the seed gap.
    return sourceText;
  }

  function resetDownstream() {
    setReview(null);
    setSaveModes(null);
    setSaveResult(null);
    setCatalogReadback(null);
  }

  function ensureStudioBackend(action: string): boolean {
    if (!liveBackendUnavailable) return true;
    pushToast(fill(t('integrationsPluginStudio.pluginStudioModule.blockedLiveBackendIs'), { action: String(action) }), 'danger');
    return false;
  }

  async function refreshSavedPluginCatalog(resource: SavedPluginResource = savedResource) {
    const resources = [
      'integration_plugins',
      'integration_plugin_directory',
      'integration_plugin_versions',
      'integration_plugin_validation_runs',
      'integration_plugin_approval_events',
      'mapping_operation_reports',
    ];
    await Promise.all(
      resources.map((resource) =>
        queryClient.invalidateQueries({ queryKey: ['list', resource] }),
      ),
    );
    const requestedAt = new Date().toISOString();
    if (!resource.pluginId) {
      setCatalogReadback({
        pluginId: null,
        pluginVersionId: resource.pluginVersionId,
        pluginVisible: false,
        directoryVisible: false,
        versionVisible: false,
        pluginStatus: null,
        directoryStatus: null,
        versionStatus: null,
        requestedAt,
        error: 'Saved plugin id missing from save result',
      });
      return;
    }
    setCatalogReadback({
      pluginId: resource.pluginId,
      pluginVersionId: resource.pluginVersionId,
      pluginVisible: false,
      directoryVisible: false,
      versionVisible: false,
      pluginStatus: null,
      directoryStatus: null,
      versionStatus: null,
      requestedAt,
      error: null,
    });
    const [pluginResult, directoryResult, versionsResult] = await Promise.allSettled([
      api.ui_get_resource_v1<Record<string, unknown>>('integration_plugins', resource.pluginId),
      api.ui_get_resource_v1<Record<string, unknown>>('integration_plugin_directory', resource.pluginId),
      api.ui_list_resource_v1<Record<string, unknown>>('integration_plugin_versions', {
        filter: { plugin_id: resource.pluginId },
        page_size: 50,
      }),
    ]);
    const plugin =
      pluginResult.status === 'fulfilled' ? pluginResult.value : null;
    const directory =
      directoryResult.status === 'fulfilled' ? directoryResult.value : null;
    const versions =
      versionsResult.status === 'fulfilled' ? versionsResult.value.rows ?? [] : [];
    const version = resource.pluginVersionId
      ? versions.find((row) => row.id === resource.pluginVersionId) ?? null
      : null;
    const error =
      [pluginResult, directoryResult, versionsResult]
        .filter((result): result is PromiseRejectedResult => result.status === 'rejected')
        .map((result) => result.reason instanceof Error ? result.reason.message : String(result.reason))
        .join(' | ') || null;
    setCatalogReadback({
      pluginId: resource.pluginId,
      pluginVersionId: resource.pluginVersionId,
      pluginVisible: Boolean(plugin),
      directoryVisible: Boolean(directory),
      versionVisible: Boolean(version),
      pluginStatus: studioText(plugin?.status),
      directoryStatus:
        studioText(directory?.latest_version_status)
        ?? studioText(directory?.active_version_status),
      versionStatus: studioText(version?.status),
      requestedAt,
      error,
    });
  }

  async function openSavedPluginCatalog() {
    await refreshSavedPluginCatalog();
    if (savedResource.pluginId) {
      navigate({
        to: '/integrations/catalog',
        search: { focus: savedResource.pluginId } as Record<string, string>,
      });
      return;
    }
    navigate({ to: '/integrations/catalog' });
  }

  async function runParse() {
    if (!ensureStudioBackend('Parse')) return;
    const sourcePayload = buildSourcePayload();
    const safeSourceText = redactIntegrationSourceTextForDisplay(sourceText);
    setStage('parsing');
    setErrMsg(null);
    setContract(null);
    setMappingSuggestion(null);
    setOutboundSuggestions([]);
    resetDownstream();
    try {
      const res = await api.plugin_studio_parse_v1({
        source_type: sourceType,
        source_payload: sourcePayload,
        plugin_kind: pluginKind,
        plugin_name: pluginName || undefined,
        organization_id: activeOrganizationId,
      });
      if (safeSourceText !== sourceText) setSourceText(safeSourceText);
      setContract(res.normalized_contract);
      setMappingSuggestion(res.mapping_suggestion);
      setStage('parsed');
      pushToast(fill(t('integrationsPluginStudio.pluginStudioModule.parsedContract'), { plugin_kind: String(res.normalized_contract.plugin_kind) }), 'good');
    } catch (err) {
      if (safeSourceText !== sourceText) setSourceText(safeSourceText);
      const message = (err as Error)?.message ?? 'parse failed';
      setErrMsg(message);
      setStage('error');
      pushToast(fill(t('integrationsPluginStudio.pluginStudioModule.parseFailed'), { message: String(message) }), 'danger');
    }
  }

  async function runInfer() {
    if (!ensureStudioBackend('Infer')) return;
    if (!contract) {
      pushToast(t('integrationsPluginStudio.pluginStudioModule.runParseFirst'), 'warn');
      return;
    }
    setStage('inferring');
    setErrMsg(null);
    resetDownstream();
    try {
      const res = await api.plugin_studio_infer_v1({
        source_type: sourceType,
        source_payload: buildSourcePayload(),
        normalized_contract: contract,
        plugin_kind: contract.plugin_kind,
        organization_id: activeOrganizationId,
      });
      setContract(res.normalized_contract);
      setMappingSuggestion(res.mapping_suggestion);
      setOutboundSuggestions(res.outbound_suggestions);
      setStage('inferred');
      const fieldCount = Array.isArray((res.mapping_suggestion as { fields?: unknown[] }).fields)
        ? ((res.mapping_suggestion as { fields: unknown[] }).fields.length)
        : 0;
      pushToast(fill(t(fieldCount === 1 ? 'integrationsPluginStudio.pluginStudioModule.inferredMappingFieldOne' : 'integrationsPluginStudio.pluginStudioModule.inferredMappingFieldOther'), { fieldCount: String(fieldCount) }), 'good');
    } catch (err) {
      const message = (err as Error)?.message ?? 'infer failed';
      setErrMsg(message);
      setStage('error');
      pushToast(fill(t('integrationsPluginStudio.pluginStudioModule.inferFailed'), { message: String(message) }), 'danger');
    }
  }

  async function runPreview() {
    if (!ensureStudioBackend('Preview')) return;
    if (!contract || !mappingSuggestion) {
      pushToast(t('integrationsPluginStudio.pluginStudioModule.runParseInferFirst'), 'warn');
      return;
    }
    setStage('previewing');
    setErrMsg(null);
    setSaveResult(null);
    try {
      const res = await api.plugin_studio_preview_v1({
        artifact,
        normalized_contract: contract,
        mapping_config: mappingSuggestion,
        plugin_kind: contract.plugin_kind,
        outbound_operations: outboundSuggestions,
        organization_id: activeOrganizationId,
      });
      setReview(res.review);
      setSaveModes(res.save_modes);
      setStage('previewed');
      const blocking = res.review.review_summary.blocking_count;
      const tone = blocking > 0 ? 'warn' : 'good';
      pushToast(
        fill(t(res.review.review_summary.coercion_count === 1 ? 'integrationsPluginStudio.pluginStudioModule.previewBlockingWarningCoercionOne' : 'integrationsPluginStudio.pluginStudioModule.previewBlockingWarningCoercionOther'), { blocking: String(blocking), warning_count: String(res.review.review_summary.warning_count), coercion_count: String(res.review.review_summary.coercion_count) }),
        tone,
      );
    } catch (err) {
      const message = (err as Error)?.message ?? 'preview failed';
      setErrMsg(message);
      setStage('error');
      pushToast(fill(t('integrationsPluginStudio.pluginStudioModule.previewFailed'), { message: String(message) }), 'danger');
    }
  }

  async function runSave() {
    if (!ensureStudioBackend('Save')) return;
    if (!contract || !mappingSuggestion || !review) {
      pushToast(t('integrationsPluginStudio.pluginStudioModule.completeParseInferPreview'), 'warn');
      return;
    }
    if (blockingCount > 0) {
      pushToast(fill(t(blockingCount === 1 ? 'integrationsPluginStudio.pluginStudioModule.cannotSaveBlockingReviewOne' : 'integrationsPluginStudio.pluginStudioModule.cannotSaveBlockingReviewOther'), { blockingCount: String(blockingCount) }), 'danger');
      return;
    }
    if (!recommendedSaveMode) {
      pushToast(t('integrationsPluginStudio.pluginStudioModule.noEligibleSaveMode'), 'danger');
      return;
    }
    setStage('saving');
    setErrMsg(null);
    try {
      const res = await api.plugin_studio_save_v1({
        artifact,
        save_mode: recommendedSaveMode,
        normalized_contract: contract,
        mapping_config: mappingSuggestion,
        plugin_kind: contract.plugin_kind,
        outbound_operations: outboundSuggestions,
        plugin_name: pluginName || undefined,
        source_type: sourceType,
        source_payload: buildSourcePayload(),
        organization_id: activeOrganizationId,
      });
      const saved = savedPluginResourceFromSaveResult(res);
      setSaveResult(res);
      setStage('saved');
      void refreshSavedPluginCatalog(saved);
      pushToast(fill(t('integrationsPluginStudio.pluginStudioModule.savedMode'), { save_mode: String(res.save_mode) }), 'good');
    } catch (err) {
      const message = (err as Error)?.message ?? 'save failed';
      setErrMsg(message);
      setStage('error');
      pushToast(fill(t('integrationsPluginStudio.pluginStudioModule.saveFailed'), { message: String(message) }), 'danger');
    }
  }

  const stageChips = useMemo(() => {
    const order: Array<{ key: string; label: string; reached: boolean; current: boolean }> = [
      { key: 'parse', label: '1 · Parse', reached: !!contract, current: stage === 'parsing' },
      { key: 'infer', label: '2 · Infer', reached: !!outboundSuggestions.length || (!!mappingSuggestion && stage !== 'parsed' && stage !== 'parsing'), current: stage === 'inferring' },
      { key: 'preview', label: '3 · Preview', reached: !!review, current: stage === 'previewing' },
      { key: 'save', label: '4 · Save', reached: !!saveResult, current: stage === 'saving' },
    ];
    return order;
  }, [contract, mappingSuggestion, outboundSuggestions, review, saveResult, stage]);

  if (!canRead) {
    return (
      <div className="page">
        <PageHeader
          moduleKey="int-plugin-studio"
          eyebrow={t('integrationsPluginStudio.pluginStudioModule.integrations')}
          titleAccent={t('integrationsPluginStudio.pluginStudioModule.titleAccent')}
          titlePlain={t('integrationsPluginStudio.pluginStudioModule.titlePlain')}
          pills={[
            <span key="src" className="chip chip--xs mono">
              {t('integrationsPluginStudio.pluginStudioModule.integrationPluginStudioParse')}
            </span>,
          ]}
        />
        <StateView
          kind="denied"
          capability={CAP.INTEGRATION_PLUGINS_READ}
          hint={t('integrationsPluginStudio.pluginStudioModule.youDoNotHave')}
        />
      </div>
    );
  }

  return (
    <div className="page">
      <PageHeader
        moduleKey="int-plugin-studio"
        eyebrow={t('integrationsPluginStudio.pluginStudioModule.integrations')}
        titleAccent={t('integrationsPluginStudio.pluginStudioModule.titleAccent')}
        titlePlain={t('integrationsPluginStudio.pluginStudioModule.titlePlain')}
        pills={[
          <span key="src" className="chip chip--xs">
            {t('integrationsPluginStudio.pluginStudioModule.guidedIntegrationSetup')}
          </span>,
          <span key="mode" className="chip chip--xs">
            {seedDiagnosticsEnabled ? t('integrationsPluginStudio.pluginStudioModule.reviewChecks') : t('integrationsPluginStudio.pluginStudioModule.hostedConfirmation')}
          </span>,
        ]}
      />

      <div
        style={{
          display: 'flex',
          gap: '8px',
          padding: '12px 16px',
          borderBottom: '1px solid var(--line)',
          flexWrap: 'wrap',
          alignItems: 'center',
        }}
        data-testid="plugin-studio-stage-chips"
      >
        {stageChips.map((chip) => (
          <Chip
            key={chip.key}
            label={chip.label}
            kind={chip.current ? 'info' : chip.reached ? 'good' : 'neutral'}
            size="xs"
          />
        ))}
        {errMsg ? (
          <span className="mono" style={{ fontSize: '11px', color: 'var(--danger)' }} data-testid="plugin-studio-error">
            {errMsg}
          </span>
        ) : null}
      </div>
      {liveBackendUnavailable ? (
        <div style={{ padding: '12px 16px', borderBottom: '1px solid var(--line)' }}>
          <StateView
            kind="error"
            title={t('integrationsPluginStudio.pluginStudioModule.hostedConfirmationRequired')}
            hint={t('integrationsPluginStudio.pluginStudioModule.connectTheHostedIntegration')}
          />
        </div>
      ) : null}

      <div
        style={{
          flex: 1,
          display: 'grid',
          gridTemplateColumns: '1fr 1fr',
          minHeight: 0,
          overflow: 'hidden',
        }}
      >
        {/* LEFT — source editor + actions */}
        <div
          style={{
            padding: '16px',
            display: 'flex',
            flexDirection: 'column',
            gap: '10px',
            borderRight: '1px solid var(--line)',
            overflow: 'auto',
          }}
        >
          <label className="eyebrow" htmlFor="plugin-studio-source-type">
            {t('integrationsPluginStudio.pluginStudioModule.sourceType')}
          </label>
          <select
            id="plugin-studio-source-type"
            className="field"
            value={sourceType}
            onChange={(e) => {
              const next = e.target.value as SourceType;
              setSourceType(next);
              // Cycle E P1 #12 closure: sample payload reads from the
              // canonical `plugin_studio_source_type[next].metadata.sample`
              // row. No inline SAMPLE_BY_SOURCE Record.
              const nextSample =
                sourceTypeRows.find((r) => r.value === next)?.metadata?.sample ?? '';
              setSourceText(nextSample);
              setStage('idle');
              setContract(null);
              setMappingSuggestion(null);
              setOutboundSuggestions([]);
              resetDownstream();
            }}
          >
            {sourceTypeRows.map((s) => (
              <option key={s.value} value={s.value}>
                {s.label ?? s.value}
              </option>
            ))}
          </select>

          <label className="eyebrow" htmlFor="plugin-studio-kind">
            {t('integrationsPluginStudio.pluginStudioModule.pluginKind')}
          </label>
          <select
            id="plugin-studio-kind"
            className="field"
            value={pluginKind}
            onChange={(e) => setPluginKind(e.target.value)}
          >
            {pluginKindRows.map((k) => (
              <option key={k.value} value={k.value}>
                {/* Cycle E2 P2 closure: option label resolves through the
                    canonical row's label + optional metadata.hint (no inline
                    'api (outbound HTTP)' / 'webhook (inbound)' literals). */}
                {k.label ?? k.value}
                {k.metadata?.hint ? ` (${k.metadata.hint})` : ''}
              </option>
            ))}
          </select>

          <label className="eyebrow" htmlFor="plugin-studio-name">
            {t('integrationsPluginStudio.pluginStudioModule.pluginNameOptional')}
          </label>
          <input
            id="plugin-studio-name"
            className="field"
            placeholder={t('integrationsPluginStudio.pluginStudioModule.eGExamplecourierKsa')}
            value={pluginName}
            onChange={(e) => setPluginName(e.target.value)}
          />

          <label className="eyebrow" htmlFor="plugin-studio-source">
            {t('integrationsPluginStudio.pluginStudioModule.sourcePayload')}
          </label>
          <textarea
            id="plugin-studio-source"
            rows={14}
            className="wf-code-block wf-code-block--editable"
            style={{
              width: '100%',
              fontFamily: 'var(--font-mono)',
              fontSize: '11.5px',
            }}
            value={sourceText}
            onChange={(e) => setSourceText(e.target.value)}
          />

          <div style={{ display: 'flex', gap: '8px', flexWrap: 'wrap' }}>
            <Button
              label={stage === 'parsing' ? t('integrationsPluginStudio.pluginStudioModule.parsing') : t('integrationsPluginStudio.pluginStudioModule.parse')}
              iconName="play"
              kind="primary"
              capability={CAP.INTEGRATION_PLUGINS_WRITE}
              onClick={() => void runParse()}
              disabled={liveBackendUnavailable || stage === 'parsing' || stage === 'inferring' || stage === 'previewing' || stage === 'saving'}
            />
            <Button
              label={stage === 'inferring' ? t('integrationsPluginStudio.pluginStudioModule.inferring') : t('integrationsPluginStudio.pluginStudioModule.inferMapping')}
              iconName="git"
              kind={contract ? 'primary' : 'ghost'}
              capability={CAP.INTEGRATION_PLUGINS_WRITE}
              onClick={() => void runInfer()}
              disabled={liveBackendUnavailable || !contract || stage === 'parsing' || stage === 'inferring' || stage === 'previewing' || stage === 'saving'}
            />
            <Button
              label={stage === 'previewing' ? t('integrationsPluginStudio.pluginStudioModule.previewing') : t('integrationsPluginStudio.pluginStudioModule.preview')}
              iconName="eye"
              kind={mappingSuggestion ? 'primary' : 'ghost'}
              capability={CAP.INTEGRATION_PLUGINS_WRITE}
              onClick={() => void runPreview()}
              disabled={liveBackendUnavailable || !mappingSuggestion || stage === 'parsing' || stage === 'inferring' || stage === 'previewing' || stage === 'saving'}
            />
            <Button
              label={stage === 'saving' ? t('integrationsPluginStudio.pluginStudioModule.saving') : recommendedSaveMode ? fill(t('integrationsPluginStudio.pluginStudioModule.saveWithMode'), { mode: recommendedSaveMode }) : t('integrationsPluginStudio.pluginStudioModule.save')}
              iconName="check"
              kind="primary"
              capability={CAP.INTEGRATION_PLUGINS_WRITE}
              onClick={() => void runSave()}
              disabled={
                !review
                || liveBackendUnavailable
                || blockingCount > 0
                || !recommendedSaveMode
                || stage === 'parsing'
                || stage === 'inferring'
                || stage === 'previewing'
                || stage === 'saving'
              }
            />
          </div>
        </div>

        {/* RIGHT — staged outputs */}
        <div
          style={{
            padding: '16px',
            overflow: 'auto',
            display: 'flex',
            flexDirection: 'column',
            gap: '12px',
          }}
        >
          <section aria-label={t('integrationsPluginStudio.pluginStudioModule.normalizedContract')} data-testid="plugin-studio-contract">
            <div className="eyebrow">{t('integrationsPluginStudio.pluginStudioModule.normalizedContract')}</div>
            {contract ? (
              <StateView
                kind="empty"
                title={t('integrationsPluginStudio.pluginStudioModule.contractPrepared')}
                hint={t('integrationsPluginStudio.pluginStudioModule.theIntegrationContractWas')}
              />
            ) : (
              <StateView kind="empty" title={t('integrationsPluginStudio.pluginStudioModule.noContractYet')} hint={t('integrationsPluginStudio.pluginStudioModule.clickParseToNormalize')} />
            )}
          </section>

          <section aria-label={t('integrationsPluginStudio.pluginStudioModule.mappingSuggestion')} data-testid="plugin-studio-mapping">
            <div className="eyebrow">{t('integrationsPluginStudio.pluginStudioModule.mappingSuggestion')}</div>
            {mappingSuggestion ? (
              <StateView
                kind="empty"
                title={t('integrationsPluginStudio.pluginStudioModule.mappingSuggestionPrepared')}
                hint={t('integrationsPluginStudio.pluginStudioModule.theSuggestedMappingWas')}
              />
            ) : (
              <StateView kind="empty" title={t('integrationsPluginStudio.pluginStudioModule.noMappingYet')} hint={t('integrationsPluginStudio.pluginStudioModule.clickInferMappingAfter')} />
            )}
            {outboundSuggestions.length ? (
              <>
                <div className="eyebrow" style={{ marginTop: '8px' }}>
                  {fill(t('integrationsPluginStudio.pluginStudioModule.outboundOperations'), { length: String(outboundSuggestions.length) })}
                </div>
                <StateView
                  kind="empty"
                  title={t('integrationsPluginStudio.pluginStudioModule.outboundSuggestionsPrepared')}
                  hint={t('integrationsPluginStudio.pluginStudioModule.outboundOperationSuggestionsAre')}
                />
              </>
            ) : null}
          </section>

          <section aria-label={t('integrationsPluginStudio.pluginStudioModule.previewReview')} data-testid="plugin-studio-review">
            <div className="eyebrow">{t('integrationsPluginStudio.pluginStudioModule.previewReview')}</div>
            {review ? (
              <>
                <div style={{ display: 'flex', gap: '8px', flexWrap: 'wrap', padding: '4px 0' }}>
                  <Chip
                    label={fill(t('integrationsPluginStudio.pluginStudioModule.blocking'), { blocking_count: String(review.review_summary.blocking_count) })}
                    kind={review.review_summary.blocking_count > 0 ? 'danger' : 'good'}
                    size="xs"
                  />
                  <Chip
                    label={fill(t('integrationsPluginStudio.pluginStudioModule.warning'), { warning_count: String(review.review_summary.warning_count) })}
                    kind={review.review_summary.warning_count > 0 ? 'warn' : 'neutral'}
                    size="xs"
                  />
                  <Chip
                    label={fill(t(review.review_summary.coercion_count === 1 ? 'integrationsPluginStudio.pluginStudioModule.coercionOne' : 'integrationsPluginStudio.pluginStudioModule.coercionOther'), { coercion_count: String(review.review_summary.coercion_count) })}
                    kind={review.review_summary.coercion_count > 0 ? 'info' : 'neutral'}
                    size="xs"
                  />
                  {recommendedSaveMode ? (
                    <Chip label={fill(t('integrationsPluginStudio.pluginStudioModule.saveMode'), { recommendedSaveMode: String(recommendedSaveMode) })} kind="info" size="xs" />
                  ) : (
                    <Chip label={t('integrationsPluginStudio.pluginStudioModule.noSaveMode')} kind="danger" size="xs" />
                  )}
                </div>
                {review.diagnostics.length ? (
                  <StateView
                    kind="error"
                    title={t('integrationsPluginStudio.pluginStudioModule.reviewItemsFound')}
                    hint={t('integrationsPluginStudio.pluginStudioModule.resolveTheBlockingAnd')}
                  />
                ) : (
                  <div className="state__hint">{t('integrationsPluginStudio.pluginStudioModule.noReviewItemsPreview')}</div>
                )}
              </>
            ) : (
              <StateView kind="empty" title={t('integrationsPluginStudio.pluginStudioModule.noPreviewYet')} hint={t('integrationsPluginStudio.pluginStudioModule.clickPreviewAfterInfer')} />
            )}
          </section>

          <section aria-label={t('integrationsPluginStudio.pluginStudioModule.saveResult')} data-testid="plugin-studio-save-result">
            <div className="eyebrow">{t('integrationsPluginStudio.pluginStudioModule.saveResult')}</div>
            {saveResult ? (
              <>
                <div
                  className="card"
                  style={{
                    display: 'grid',
                    gap: '8px',
                    margin: '6px 0 8px',
                    padding: '10px 12px',
                  }}
                  data-testid="plugin-studio-save-readback"
                >
                  <div style={{ display: 'flex', alignItems: 'center', gap: '8px', flexWrap: 'wrap' }}>
                    <Chip label={fill(t('integrationsPluginStudio.pluginStudioModule.saved'), { save_mode: String(saveResult.save_mode) })} kind="good" size="xs" />
                    {savedResource.pluginId ? (
                      <Chip label={t('integrationsPluginStudio.pluginStudioModule.pluginSaved')} kind="good" size="xs" />
                    ) : null}
                    {savedResource.pluginVersionId ? (
                      <Chip label={t('integrationsPluginStudio.pluginStudioModule.versionSaved')} kind="good" size="xs" />
                    ) : null}
                    {savedResource.reportId ? (
                      <Chip label={t('integrationsPluginStudio.pluginStudioModule.reviewSaved')} kind="good" size="xs" />
                    ) : null}
                    {savedResource.workflowIntent ? (
                      <Chip label={t('integrationsPluginStudio.pluginStudioModule.workflowPrepared')} kind="info" size="xs" />
                    ) : null}
                    {savedResource.workflowTemplateName ? (
                      <Chip label={t('integrationsPluginStudio.pluginStudioModule.templateReady')} kind="info" size="xs" />
                    ) : null}
                    {savedResource.workflowMode ? (
                      <Chip label={t('integrationsPluginStudio.pluginStudioModule.bindingReady')} kind="info" size="xs" />
                    ) : null}
                  </div>
                  <div style={{ display: 'flex', gap: '8px', flexWrap: 'wrap' }}>
                    <Button
                      label={t('integrationsPluginStudio.pluginStudioModule.openSavedPlugin')}
                      iconName="grid"
                      kind="primary"
                      capability={CAP.INTEGRATION_PLUGINS_READ}
                      onClick={() => void openSavedPluginCatalog()}
                    />
                    <Button
                      label={t('integrationsPluginStudio.pluginStudioModule.refreshCatalogConfirmation')}
                      iconName="refresh"
                      kind="ghost"
                      capability={CAP.INTEGRATION_PLUGINS_READ}
                      onClick={() => void refreshSavedPluginCatalog()}
                    />
                  </div>
                  {catalogReadback ? (
                    <div
                      data-testid="plugin-studio-catalog-readback"
                      aria-label={t('integrationsPluginStudio.pluginStudioModule.catalogConfirmation')}
                      className="state__hint"
                      style={{ display: 'grid', gap: '4px', fontSize: '11px', color: 'var(--ink-3)' }}
                    >
                      <div style={{ display: 'flex', gap: '6px', flexWrap: 'wrap', alignItems: 'center' }}>
                        <Chip
                          label={
                            catalogReadback.pluginVisible
                              && catalogReadback.directoryVisible
                              && (!catalogReadback.pluginVersionId || catalogReadback.versionVisible)
                              ? t('integrationsPluginStudio.pluginStudioModule.catalogConfirmed')
                              : t('integrationsPluginStudio.pluginStudioModule.catalogConfirmationPending')
                          }
                          kind={
                            catalogReadback.pluginVisible
                              && catalogReadback.directoryVisible
                              && (!catalogReadback.pluginVersionId || catalogReadback.versionVisible)
                              ? 'good'
                              : 'warn'
                          }
                          size="xs"
                        />
                        <span>{fill(t('integrationsPluginStudio.pluginStudioModule.plugin'), { value: String(catalogReadback.pluginVisible ? t('integrationsPluginStudio.pluginStudioModule.available') : t('integrationsPluginStudio.pluginStudioModule.updating')) })}</span>
                        <span>{fill(t('integrationsPluginStudio.pluginStudioModule.version'), { value: String(catalogReadback.versionVisible ? t('integrationsPluginStudio.pluginStudioModule.available') : t('integrationsPluginStudio.pluginStudioModule.updating')) })}</span>
                        <span>{fill(t('integrationsPluginStudio.pluginStudioModule.directory'), { value: String(catalogReadback.directoryVisible ? t('integrationsPluginStudio.pluginStudioModule.available') : t('integrationsPluginStudio.pluginStudioModule.updating')) })}</span>
                      </div>
                      {catalogReadback.error ? (
                        <span style={{ color: 'var(--danger)' }}>{catalogReadback.error}</span>
                      ) : null}
                    </div>
                  ) : null}
                </div>
                <StateView
                  kind="empty"
                  title={t('integrationsPluginStudio.pluginStudioModule.saveConfirmationRecorded')}
                  hint={t('integrationsPluginStudio.pluginStudioModule.thePluginReviewAnd')}
                />
              </>
            ) : (
              <StateView kind="empty" title={t('integrationsPluginStudio.pluginStudioModule.notSavedYet')} hint={t('integrationsPluginStudio.pluginStudioModule.clickSaveAfterA')} />
            )}
          </section>
        </div>
      </div>
    </div>
  );
}
