import "server-only";
import { createUiServerClient } from "@masarx/api/server";
import { ContextNotice } from "./context-notice";
import { EmptyState } from "./empty-state";
import { PageContainer } from "./page-container";
import { PageHeader } from "./page-header";
import { ResourcePage } from "./resource-page";
import { Section } from "./section";
import { ShipmentResourcePage } from "./shipment-resource-page";
import { createUiTranslator } from "./i18n";
import { resolveTrackingConfig, resolveTrackingOperatorHandoff } from "./tracking-config";
import { TrackingSearchForm } from "./tracking-search-form";
import { formatUiError } from "./utils";
import { resolveSafeAppBasePath, resolveSafeHref } from "./url-guard";

type SearchParams = Record<string, string | string[] | undefined>;

type TrackingPageProps = {
  searchParams: SearchParams;
  appKey: "console" | "portal";
  appBasePath: string;
  testIdPrefix?: string;
  locale?: string;
};

function firstValue(value: string | string[] | undefined) {
  if (Array.isArray(value)) return value[0];
  return value;
}

/**
 * Tracking page for portal shipment lookups.
 */
export async function TrackingPage({
  searchParams,
  appKey,
  appBasePath,
  testIdPrefix,
  locale,
}: TrackingPageProps) {
  const t = createUiTranslator("ui.tracking", { locale });
  const ui = createUiServerClient();
  let trackingConfig = null;
  let configError: string | null = null;

  try {
    trackingConfig = await ui.publicTrackingConfig();
  } catch (error) {
    configError = formatUiError(error, t("errors.loadConfig"));
  }

  const { config, error } = resolveTrackingConfig(trackingConfig, locale);
  const configErrorMessage = configError ?? error;
  const errorTestId = testIdPrefix ? `${testIdPrefix}-error` : undefined;
  if (!config || configErrorMessage) {
    return (
      <PageContainer className="space-y-6">
        <PageHeader title={t("title")} description={t("description")} />
        <ContextNotice
          testId={errorTestId}
          title={t("errors.title")}
          action={t("errors.action")}
          detail={configErrorMessage}
        />
      </PageContainer>
    );
  }

  const rawTrackingNumber =
    firstValue(searchParams[config.paramKey]) ??
    firstValue(searchParams[config.filterKey]);
  const trackingNumber = rawTrackingNumber?.trim() ?? "";
  let operatorHandoff = null;
  if (appKey === "portal" && trackingNumber && config.resourceKey === "shipments") {
    try {
      const me = await ui.me();
      if (me?.user?.id) {
        const scoped = await ui.trackingRegistry();
        if (scoped.resource_key === "shipments") operatorHandoff = resolveTrackingOperatorHandoff(scoped.operator_handoff);
      }
    } catch { /* Public lookup remains available without an authenticated handoff. */ }
  }
  const resourceSearchParams: SearchParams = { ...searchParams };

  if (trackingNumber) {
    resourceSearchParams[config.filterKey] = trackingNumber;
  } else {
    delete resourceSearchParams[config.filterKey];
  }
  if (config.paramKey !== config.filterKey) {
    delete resourceSearchParams[config.paramKey];
  }
  const readyTestId = testIdPrefix ? `${testIdPrefix}-ready` : undefined;
  const emptyTestId = testIdPrefix ? `${testIdPrefix}-empty` : undefined;
  const safeBasePath = resolveSafeAppBasePath(appBasePath);
  const actionHref =
    safeBasePath !== null
      ? resolveSafeHref(safeBasePath, "/tracking") ?? "/tracking"
      : "/tracking";

  return (
    <div className="space-y-6" data-testid={readyTestId}>
      <PageContainer className="space-y-6">
        <PageHeader title={config.title} description={config.description} />
        <Section
          title={t("sections.searchTitle")}
          description={t("sections.searchDescription")}
          collapsible
          collapseKey="tracking.search"
        >
          <TrackingSearchForm
            actionHref={actionHref}
            defaultValue={trackingNumber || undefined}
            paramKey={config.paramKey}
            label={config.form.label}
            placeholder={config.form.placeholder}
            searchLabel={config.form.searchLabel}
            clearLabel={config.form.clearLabel}
            resourceKey={config.resourceKey}
            filterKey={config.filterKey}
            testIdPrefix={testIdPrefix}
          />
          {trackingNumber ? (
            <p role="status" className="mt-3 text-xs text-ui-muted"
              data-testid={testIdPrefix ? `${testIdPrefix}-query-readback` : undefined}>
              {t("queryReadback", { trackingNumber })}
            </p>
          ) : null}
        </Section>
      </PageContainer>
      {trackingNumber ? (
        config.resourceKey === "shipments" ? (
          <ShipmentResourcePage
            appKey={appKey}
            appBasePath={appBasePath}
            searchParams={resourceSearchParams}
            operatorHandoff={operatorHandoff}
            testIdPrefix={testIdPrefix ? `${testIdPrefix}-results` : "tracking-results"}
          />
        ) : (
          <ResourcePage
            appKey={appKey}
            resourceKey={config.resourceKey}
            searchParams={resourceSearchParams}
            appBasePath={appBasePath}
            description={config.resultsDescription}
            testIdPrefix={testIdPrefix ? `${testIdPrefix}-results` : undefined}
          />
        )
      ) : (
        <PageContainer data-testid={emptyTestId}>
          <Section
            title={t("sections.resultsTitle")}
            description={t("sections.resultsDescription")}
            collapsible
            collapseKey="tracking.results"
          >
            <EmptyState variant="inline" title={config.empty} />
          </Section>
        </PageContainer>
      )}
    </div>
  );
}
