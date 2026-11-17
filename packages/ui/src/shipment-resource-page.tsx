import "server-only";

import type {
  UiShipmentPodAsset,
  UiShipmentTimeline,
  UiShipmentTimelineEvent,
} from "@masarx/api";
import { createUiServerClient } from "@masarx/api/server";
import { getPublicConfig } from "@masarx/config";
import { Badge } from "./badge";
import { ContextNotice } from "./context-notice";
import { Button } from "./button";
import { hasCapability, resolveCapabilitySet } from "./capabilities";
import { createUiTranslator } from "./i18n";
import { formatDateTime } from "./pickup-operations-utils";
import { ResourcePage } from "./resource-page";
import { Section } from "./section";
import { TrackingSearchForm } from "./tracking-search-form";
import { findRegistryResource } from "./ui-registry-utils";
import { resolveSafeAppBasePath, resolveSafeHref } from "./url-guard";
import { formatUiError } from "./utils";
import { resolveShipmentOperatorHandoffHref, resolveTrackingOperatorHandoff, type TrackingOperatorHandoff } from "./tracking-config";

type ShipmentResourcePageProps = {
  appKey: "console" | "portal";
  appBasePath: string;
  searchParams: Record<string, string | string[] | undefined>;
  testIdPrefix: string;
  operatorHandoff?: TrackingOperatorHandoff | null;
  operatorHandoffDestination?: boolean;
};

type TimelineTone = "neutral" | "accent" | "success" | "warning" | "danger" | "info";

function firstValue(value: string | string[] | undefined) {
  if (Array.isArray(value)) return value[0];
  return value;
}

function stringValue(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed ? trimmed : null;
}

function displayValue(value: unknown): string | null {
  if (typeof value === "string") return stringValue(value);
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  return null;
}

function recordValue(value: unknown): Record<string, unknown> | null {
  if (!value || Array.isArray(value) || typeof value !== "object") return null;
  return value as Record<string, unknown>;
}

function humanizeLabel(value: string | null) {
  if (!value) return "Unknown";
  return value
    .replace(/_/g, " ")
    .replace(/\b\w/g, (char) => char.toUpperCase());
}

function resolveTimelineSourceLabel(source: string | null) {
  switch (source) {
    case "shipment_action":
      return "Shipment action";
    case "decision_log":
      return "Decision";
    case "domain_event":
      return "Domain event";
    case "outbound_communication":
      return "Outbound communication";
    default:
      return humanizeLabel(source);
  }
}

function resolveTimelineTone(status: string | null): TimelineTone {
  const normalized = status?.trim().toLowerCase() ?? "";
  if (!normalized) return "neutral";
  if (
    normalized === "completed" ||
    normalized === "succeeded" ||
    normalized === "resolved" ||
    normalized === "success"
  ) {
    return "success";
  }
  if (
    normalized === "failed" ||
    normalized === "permanently_failed" ||
    normalized === "cancelled" ||
    normalized === "denied"
  ) {
    return "danger";
  }
  if (normalized === "pending" || normalized === "processing" || normalized === "in_progress") {
    return "warning";
  }
  return "info";
}

function buildTimelineFacts(event: UiShipmentTimelineEvent, t: ReturnType<typeof createUiTranslator>) {
  const facts: Array<{ label: string; value: string }> = [];
  const metadata = recordValue(event.metadata);

  const appendFact = (label: string, value: unknown) => {
    const resolved = displayValue(value);
    if (!resolved) return;
    facts.push({ label, value: resolved });
  };

  appendFact(t("changedBy"), event.actor);

  switch (event.event_source) {
    case "shipment_action":
      appendFact(t("category"), metadata?.action_category);
      appendFact(t("status"), metadata?.canonical_status);
      appendFact(t("investigation"), metadata?.investigation_status);
      break;
    case "decision_log":
      appendFact(t("decision"), metadata?.decision_point);
      appendFact(t("reason"), metadata?.decision_reason);
      appendFact(t("policy"), metadata?.settings_resolution_id);
      break;
    case "domain_event":
      appendFact(t("workflow"), metadata?.workflow_run_id);
      appendFact(t("processedAt"), metadata?.processed_at);
      appendFact(t("error"), metadata?.error_reason);
      break;
    case "outbound_communication":
      appendFact(t("target"), metadata?.target_type);
      appendFact(t("method"), metadata?.method);
      appendFact(t("response"), metadata?.response_status_code);
      appendFact(t("latency"), metadata?.latency_ms);
      break;
    default:
      break;
  }

  return facts.slice(0, 4);
}

function renderShipmentTimelineSection(params: {
  appBasePath: string;
  canViewTrace: boolean;
  locale?: string | null;
  timeline: UiShipmentTimeline | null;
  timelineError: string | null;
  timeZone?: string | null;
  testIdPrefix: string;
  selected?: boolean;
}) {
  const { appBasePath, canViewTrace, locale, timeline, timelineError, timeZone, testIdPrefix } =
    params;
  const t = createUiTranslator("ui.shipmentPresentation");
  const events = Array.isArray(timeline?.timeline_events) ? timeline.timeline_events : [];

  return (
    <Section
      title={t("timelineTitle")}
      description={t("timelineDescription")}
      collapsible={!params.selected}
      collapseKey="shipments.timeline"
      testId={`${testIdPrefix}-shipment-timeline`}
    >
      {timelineError ? (
        <div className="space-y-2 text-sm text-ui-muted">
          <p>{t("timelineUnavailable")}</p>
          <p className="text-xs text-ui-muted/70">{timelineError}</p>
        </div>
      ) : events.length === 0 ? (
        <p className="text-sm text-ui-muted">{t("timelineEmpty")}</p>
      ) : (
        <ol className="space-y-3">
          {events.map((event, index) => {
            const sourceLabel = resolveTimelineSourceLabel(stringValue(event.event_source));
            const correlationId = stringValue(event.correlation_id);
            const traceHref = correlationId
              ? `${appBasePath}/observability/trace/${encodeURIComponent(correlationId)}`
              : null;
            const facts = buildTimelineFacts(event, t);
            const summary = stringValue(event.summary);
            const eventType = humanizeLabel(stringValue(event.event_type));
            const eventTimeLabel =
              formatDateTime(event.event_time, locale, timeZone) ?? stringValue(event.event_time);

            return (
              <li
                key={`${event.event_id}-${index}`}
                className="rounded-xl border border-ui-border/60 bg-ui-paper/70 p-4"
                data-testid={`${testIdPrefix}-shipment-timeline-event-${index}`}
              >
                <div className="flex flex-wrap items-start justify-between gap-3">
                  <div className="space-y-2">
                    <div className="flex flex-wrap items-center gap-2">
                      <Badge tone="neutral">{sourceLabel}</Badge>
                      <Badge tone="accent">{eventType}</Badge>
                      {stringValue(event.status) ? (
                        <Badge tone={resolveTimelineTone(stringValue(event.status))}>
                          {humanizeLabel(stringValue(event.status))}
                        </Badge>
                      ) : null}
                    </div>
                    {summary ? (
                      <p className="text-sm text-ui-ink">{summary}</p>
                    ) : null}
                    {facts.length > 0 ? (
                      <dl className="grid gap-2 text-xs text-ui-muted sm:grid-cols-2">
                        {facts.map((fact) => (
                          <div key={`${event.event_id}-${fact.label}`} className="space-y-1">
                            <dt className="uppercase tracking-wide text-ui-muted/70">
                              {fact.label}
                            </dt>
                            <dd className="text-ui-ink">{fact.value}</dd>
                          </div>
                        ))}
                      </dl>
                    ) : null}
                  </div>
                  <div className="space-y-2 text-right text-xs text-ui-muted">
                    {eventTimeLabel ? <div>{eventTimeLabel}</div> : null}
                    {canViewTrace && correlationId && traceHref ? (
                      <a
                        className="inline-flex min-h-6 items-center text-ui-ink underline underline-offset-4 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ui-accent"
                        href={traceHref}
                        data-testid={`${testIdPrefix}-shipment-timeline-trace-${index}`}
                      >
                        {t("openActivityHistory")}
                        <span className="sr-only">{t("activityReference", { reference: correlationId })}</span>
                      </a>
                    ) : null}
                  </div>
                </div>
              </li>
            );
          })}
        </ol>
      )}
    </Section>
  );
}

function resolvePodAssetLabel(asset: UiShipmentPodAsset) {
  if (stringValue(asset.label)) return stringValue(asset.label) as string;
  const assetKind = stringValue(asset.asset_kind);
  switch (assetKind) {
    case "signature":
      return "Recipient signature";
    case "photo":
      return "Proof photo";
    default:
      return "Proof attachment";
  }
}

function buildShipmentPodAssetDownloadHref(params: {
  appBasePath: string;
  shipmentId: string;
  artifactId: string;
}) {
  return `${params.appBasePath}/api/resource-download?resource=shipment_pod_asset&id=${encodeURIComponent(params.artifactId)}&shipment_id=${encodeURIComponent(params.shipmentId)}`;
}

function renderShipmentPodAssetSection(params: {
  appBasePath: string;
  assets: UiShipmentPodAsset[];
  assetsError: string | null;
  locale?: string | null;
  timeZone?: string | null;
  testIdPrefix: string;
}) {
  const { appBasePath, assets, assetsError, locale, timeZone, testIdPrefix } = params;

  return (
    <Section
      title="Proof of delivery"
      description="Authorized proof artifacts captured for this shipment handover."
      collapsible
      collapseKey="shipments.pod_assets"
      testId={`${testIdPrefix}-shipment-pod-assets`}
    >
      {assetsError ? (
        <div className="space-y-2 text-sm text-ui-muted">
          <p>Proof-of-delivery assets are unavailable right now.</p>
          <p className="text-xs text-ui-muted/70">{assetsError}</p>
        </div>
      ) : assets.length === 0 ? (
        <p className="text-sm text-ui-muted">No POD assets recorded yet.</p>
      ) : (
        <ol className="space-y-3">
          {assets.map((asset, index) => {
            const artifactId = stringValue(asset.artifact_id);
            const shipmentId = stringValue(asset.shipment_id);
            if (!artifactId || !shipmentId) return null;
            const href = buildShipmentPodAssetDownloadHref({
              appBasePath,
              shipmentId,
              artifactId,
            });
            const createdAtLabel =
              formatDateTime(asset.created_at, locale, timeZone) ?? stringValue(asset.created_at);

            return (
              <li
                key={`${artifactId}-${index}`}
                className="rounded-xl border border-ui-border/60 bg-ui-paper/70 p-4"
                data-testid={`${testIdPrefix}-shipment-pod-asset-${index}`}
              >
                <div className="flex flex-wrap items-start justify-between gap-3">
                  <div className="space-y-2">
                    <div className="flex flex-wrap items-center gap-2">
                      <Badge tone="neutral">{resolvePodAssetLabel(asset)}</Badge>
                      {stringValue(asset.asset_kind) ? (
                        <Badge tone="accent">{humanizeLabel(stringValue(asset.asset_kind))}</Badge>
                      ) : null}
                    </div>
                    {stringValue(asset.file_name) ? (
                      <p className="text-sm text-ui-ink">{stringValue(asset.file_name)}</p>
                    ) : null}
                    {stringValue(asset.mime_type) ? (
                      <p className="text-xs text-ui-muted">{stringValue(asset.mime_type)}</p>
                    ) : null}
                  </div>
                  <div className="space-y-2 text-right text-xs text-ui-muted">
                    {createdAtLabel ? <div>{createdAtLabel}</div> : null}
                    <a
                      className="inline-flex text-ui-ink underline underline-offset-4"
                      href={href}
                      data-testid={`${testIdPrefix}-shipment-pod-asset-link-${index}`}
                    >
                      Download asset
                    </a>
                  </div>
                </div>
              </li>
            );
          })}
        </ol>
      )}
    </Section>
  );
}

export async function ShipmentResourcePage({
  appKey,
  appBasePath,
  searchParams,
  testIdPrefix,
  operatorHandoff,
  operatorHandoffDestination = false,
}: ShipmentResourcePageProps) {
  const ui = createUiServerClient();
  let timelineSelected = false;
  if (operatorHandoffDestination) {
    const me = await ui.me().catch(() => null);
    const t = createUiTranslator("ui.tracking.operatorHandoff");
    const unavailable = () => (
      <div data-testid={`${testIdPrefix}-blocked`}>
        <ContextNotice title={t("unavailable")} action={t("retry")}
          testId={`${testIdPrefix}-handoff-unavailable`} />
      </div>
    );
    if (appKey !== "console" || !me?.user?.id) return unavailable();
    try {
      const registry = await ui.readRegistry();
      const resource = findRegistryResource(registry, "shipments");
      if (!resource?.capability_read ||
          !hasCapability(resolveCapabilitySet(me.capabilities ?? []), resource.capability_read)) return unavailable();
      const config = await ui.trackingRegistry();
      const handoff = resolveTrackingOperatorHandoff(config.operator_handoff);
      if (config.resource_key !== "shipments" || !handoff) return unavailable();
      const focus = searchParams[handoff.identifierParam];
      const tab = handoff.tabParam ? searchParams[handoff.tabParam] : undefined;
      if (typeof focus !== "string" || !focus.trim() ||
          (tab !== undefined && tab !== handoff.tab)) return unavailable();
      const sourceFilter = resource.filters?.find((filter) =>
        filter.column === handoff.identifierSource && !filter.resolver?.trim());
      if (!sourceFilter && (handoff.identifierSource === "rules" ||
          resource.filters?.some((filter) => filter.key === handoff.identifierSource))) return unavailable();
      const filters = sourceFilter
        ? { op: "and", rules: [{ key: sourceFilter.key, op: "eq", value: focus.trim() }] }
        : { [handoff.identifierSource]: focus.trim() };
      const result = await ui.listResource("shipments", filters, 2);
      const row = result.items?.[0];
      if (result.items?.length !== 1 || (result.total ?? 0) > 1 || !row ||
          !stringValue(row.id) || row[handoff.identifierSource] !== focus.trim()) return unavailable();
      searchParams = { id: String(row.id), detail_open: "1", identifier: focus.trim() };
      timelineSelected = tab === "timeline";
    } catch {
      return unavailable();
    }
  }
  const detailId = firstValue(searchParams.id);
  const detailOpen = Boolean(detailId && firstValue(searchParams.detail_open) !== "0");
  const [meResult, registryResult, timelineResult, podAssetsResult] = await Promise.allSettled([
    ui.me(),
    ui.readRegistry(),
    detailOpen && detailId ? ui.getShipmentTimeline(detailId) : Promise.resolve(null),
    detailOpen && detailId ? ui.getShipmentPodAssets(detailId) : Promise.resolve([]),
  ]);
  const me = meResult.status === "fulfilled" ? meResult.value : null;
  const handoffT = createUiTranslator("ui.tracking.operatorHandoff");
  const tSearch = createUiTranslator("ui.shipmentResource.search");
  const t = createUiTranslator("ui.shipmentPresentation");
  const registry = registryResult.status === "fulfilled" ? registryResult.value : null;
  const timeline = timelineResult.status === "fulfilled" ? timelineResult.value : null;
  const podAssets = podAssetsResult.status === "fulfilled" ? podAssetsResult.value : [];
  const timelineError =
    detailId && timelineResult.status === "rejected"
      ? formatUiError(
          timelineResult.reason,
          t("timelineUnavailable")
        )
      : null;
  const podAssetsError =
    detailId && podAssetsResult.status === "rejected"
      ? formatUiError(
          podAssetsResult.reason,
          "Proof-of-delivery assets could not be loaded."
        )
      : null;
  const shipmentsResource = findRegistryResource(registry, "shipments");
  const capabilitySet = resolveCapabilitySet(me?.capabilities ?? []);
  const canCreate =
    Boolean(me?.org?.id) &&
    Boolean(shipmentsResource?.capability_write) &&
    hasCapability(capabilitySet, shipmentsResource?.capability_write ?? null);
  const canViewTrace = hasCapability(capabilitySet, "audit_log.read");
  const canSearchCorrelation = canViewTrace || hasCapability(capabilitySet, "requests.read");
  const identifier = stringValue(firstValue(searchParams.identifier));
  const safeBasePath = resolveSafeAppBasePath(appBasePath);
  const resourceBaseHref =
    safeBasePath !== null
      ? resolveSafeHref(safeBasePath, "/resources/shipments") ?? "/resources/shipments"
      : "/resources/shipments";
  const searchActionHref = resourceBaseHref;

  const headerActions = canCreate ? (
    <Button asChild size="sm">
      <a
        href={`${resourceBaseHref}/new?return_to=${encodeURIComponent(resourceBaseHref)}`}
        data-testid={`${testIdPrefix}-create-action`}
      >
        {t("create")}
      </a>
    </Button>
  ) : null;

  return (
    <div className="space-y-6">
      <Section
        title={tSearch("title")}
        description={canSearchCorrelation
          ? tSearch("descriptionWithCorrelation")
          : tSearch("description")}
        collapsible
        collapseKey="shipments.search"
        testId={`${testIdPrefix}-shipment-search`}
      >
        <TrackingSearchForm
          actionHref={searchActionHref}
          defaultValue={identifier}
          paramKey="identifier"
          label={canSearchCorrelation ? t("identifier") : tSearch("identifier")}
          placeholder={canSearchCorrelation
            ? tSearch("placeholderWithCorrelation")
            : tSearch("placeholder")}
          searchLabel={tSearch("submit")}
          clearLabel={tSearch("clear")}
          emptySearchMessage={tSearch("empty")}
          resourceKey="shipments"
          filterKey="identifier"
          testIdPrefix={`${testIdPrefix}-shipment-search`}
        />
      </Section>
      <ResourcePage
        appKey={appKey}
        resourceKey="shipments"
        searchParams={searchParams}
        appBasePath={appBasePath}
        testIdPrefix={testIdPrefix}
        headerActions={headerActions}
        renderDetailFooter={({ detail, detailError }) => {
          if (!detail || detailError || !detailId || !detailOpen) return null;
          const handoffHref = appKey === "portal" && me?.user?.id && detail.id === detailId && operatorHandoff
            ? resolveShipmentOperatorHandoffHref(operatorHandoff, detail,
                process.env.CONSOLE_BASE_URL?.trim() || process.env.WORKSPACE_CONSOLE_BASE_URL?.trim() || process.env.VITE_CONSOLE_BASE_URL)
            : null;
          const arabic = getPublicConfig().locale.toLowerCase().startsWith("ar");
          return (
            <>
              {handoffHref && operatorHandoff ? (
                <Section title={handoffT("title")} description={(arabic ? operatorHandoff.descriptionAr : operatorHandoff.description) ?? handoffT("description")} testId={`${testIdPrefix}-operator-handoff`}>
                  <a href={handoffHref} className="inline-flex min-h-11 items-center gap-2 break-all rounded-md px-3 py-2 text-sm text-ui-ink underline underline-offset-4 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ui-accent"
                    data-testid={`${testIdPrefix}-operator-handoff-link`}>
                    {(arabic ? operatorHandoff.labelAr : operatorHandoff.label) ?? handoffT("label")}
                    <span className="sr-only">{handoffT("reference", { reference: String(detail[operatorHandoff.identifierSource]) })}</span>
                  </a>
                </Section>
              ) : null}
              {renderShipmentTimelineSection({
                appBasePath: safeBasePath ?? "",
                canViewTrace,
                locale: me?.locale ?? null,
                timeline,
                timelineError,
                timeZone: me?.timezone ?? null,
                testIdPrefix,
                selected: timelineSelected,
              })}
              {renderShipmentPodAssetSection({
                appBasePath: safeBasePath ?? "",
                assets: Array.isArray(podAssets) ? podAssets : [],
                assetsError: podAssetsError,
                locale: me?.locale ?? null,
                timeZone: me?.timezone ?? null,
                testIdPrefix,
              })}
            </>
          );
        }}
      />
    </div>
  );
}
