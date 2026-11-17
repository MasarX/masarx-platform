import "server-only";

import type {
  UiShipmentPodAsset,
  UiShipmentTimeline,
  UiShipmentTimelineEvent,
} from "@masarx/api";
import { createUiServerClient } from "@masarx/api/server";
import { Badge } from "./badge";
import { Button } from "./button";
import { hasCapability, resolveCapabilitySet } from "./capabilities";
import { formatDateTime } from "./pickup-operations-utils";
import { ResourcePage } from "./resource-page";
import { Section } from "./section";
import { TrackingSearchForm } from "./tracking-search-form";
import { findRegistryResource } from "./ui-registry-utils";
import { resolveSafeAppBasePath, resolveSafeHref } from "./url-guard";
import { formatUiError } from "./utils";

type ShipmentResourcePageProps = {
  appKey: "console" | "portal";
  appBasePath: string;
  searchParams: Record<string, string | string[] | undefined>;
  testIdPrefix: string;
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

function buildTimelineFacts(event: UiShipmentTimelineEvent) {
  const facts: Array<{ label: string; value: string }> = [];
  const metadata = recordValue(event.metadata);

  const appendFact = (label: string, value: unknown) => {
    const resolved = displayValue(value);
    if (!resolved) return;
    facts.push({ label, value: resolved });
  };

  appendFact("Actor", event.actor);

  switch (event.event_source) {
    case "shipment_action":
      appendFact("Category", metadata?.action_category);
      appendFact("Status", metadata?.canonical_status);
      appendFact("Investigation", metadata?.investigation_status);
      break;
    case "decision_log":
      appendFact("Decision point", metadata?.decision_point);
      appendFact("Reason", metadata?.decision_reason);
      appendFact("Settings resolution", metadata?.settings_resolution_id);
      break;
    case "domain_event":
      appendFact("Workflow run", metadata?.workflow_run_id);
      appendFact("Processed at", metadata?.processed_at);
      appendFact("Error", metadata?.error_reason);
      break;
    case "outbound_communication":
      appendFact("Target", metadata?.target_type);
      appendFact("Method", metadata?.method);
      appendFact("Response", metadata?.response_status_code);
      appendFact("Latency", metadata?.latency_ms);
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
}) {
  const { appBasePath, canViewTrace, locale, timeline, timelineError, timeZone, testIdPrefix } =
    params;
  const events = Array.isArray(timeline?.timeline_events) ? timeline.timeline_events : [];

  return (
    <Section
      title="Shipment timeline"
      description="Canonical shipment actions, decisions, domain events, and outbound communications."
      collapsible
      collapseKey="shipments.timeline"
      testId={`${testIdPrefix}-shipment-timeline`}
    >
      {timelineError ? (
        <div className="space-y-2 text-sm text-ui-muted">
          <p>Shipment timeline is unavailable right now.</p>
          <p className="text-xs text-ui-muted/70">{timelineError}</p>
        </div>
      ) : events.length === 0 ? (
        <p className="text-sm text-ui-muted">No shipment timeline events recorded yet.</p>
      ) : (
        <ol className="space-y-3">
          {events.map((event, index) => {
            const sourceLabel = resolveTimelineSourceLabel(stringValue(event.event_source));
            const correlationId = stringValue(event.correlation_id);
            const traceHref = correlationId
              ? `${appBasePath}/observability/trace/${encodeURIComponent(correlationId)}`
              : null;
            const facts = buildTimelineFacts(event);
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
                    {canViewTrace && traceHref ? (
                      <a
                        className="inline-flex text-ui-ink underline underline-offset-4"
                        href={traceHref}
                        data-testid={`${testIdPrefix}-shipment-timeline-trace-${index}`}
                      >
                        Open trace
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
}: ShipmentResourcePageProps) {
  const ui = createUiServerClient();
  const detailId = firstValue(searchParams.id);
  const [meResult, registryResult, timelineResult, podAssetsResult] = await Promise.allSettled([
    ui.me(),
    ui.readRegistry(),
    detailId ? ui.getShipmentTimeline(detailId) : Promise.resolve(null),
    detailId ? ui.getShipmentPodAssets(detailId) : Promise.resolve([]),
  ]);
  const me = meResult.status === "fulfilled" ? meResult.value : null;
  const registry = registryResult.status === "fulfilled" ? registryResult.value : null;
  const timeline = timelineResult.status === "fulfilled" ? timelineResult.value : null;
  const podAssets = podAssetsResult.status === "fulfilled" ? podAssetsResult.value : [];
  const timelineError =
    detailId && timelineResult.status === "rejected"
      ? formatUiError(
          timelineResult.reason,
          "Shipment timeline could not be loaded."
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
        Create shipment
      </a>
    </Button>
  ) : null;

  return (
    <div className="space-y-6">
      <Section
        title="Shipment search"
        description="Find a shipment by shipment ID, tracking number, order reference, phone number, or correlation ID."
        collapsible
        collapseKey="shipments.search"
        testId={`${testIdPrefix}-shipment-search`}
      >
        <TrackingSearchForm
          actionHref={searchActionHref}
          defaultValue={identifier}
          paramKey="identifier"
          label="Identifier"
          placeholder="Tracking, order, phone, shipment ID, or correlation ID"
          searchLabel="Search shipments"
          clearLabel="Clear search"
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
          if (!detail || detailError || !detailId) return null;
          return (
            <>
              {renderShipmentTimelineSection({
                appBasePath,
                canViewTrace,
                locale: me?.locale ?? null,
                timeline,
                timelineError,
                timeZone: me?.timezone ?? null,
                testIdPrefix,
              })}
              {renderShipmentPodAssetSection({
                appBasePath,
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
