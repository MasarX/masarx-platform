import "server-only";
import { createUiServerClient } from "@masarx/api/server";
import { UiCommandDefinition, UiMe, UiReadRegistry } from "@masarx/api";
import { getPublicConfig } from "@masarx/config";
import { Badge } from "./badge";
import { Button } from "./button";
import { CommandCatalogFilters } from "./command-catalog-filters";
import { fetchCommandRegistry } from "./command-registry";
import { resolveCommandHref, resolveCommandReadState, formatCommandBackendReference } from "./command-utils";
import { PageContainer } from "./page-container";
import { PageHeader } from "./page-header";
import { Section } from "./section";
import { createUiTranslator, resolveRowDisplayText } from "./i18n";
import { hasCapability, resolveCapabilitySet } from "./capabilities";
import { buildTestId } from "./test-ids";
import { formatUiError } from "./utils";

type CommandCatalogPageProps = {
  appKey: "console" | "portal";
  appLabel: string;
  testIdPrefix: string;
  appBasePath: string;
  searchParams?: Record<string, string | string[] | undefined>;
};

const t = createUiTranslator("ui.commandCatalog");

const formatValue = (value: string | null | undefined) => {
  if (!value) return t("unknown");
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : t("unknown");
};

const resolveLabel = (command: UiCommandDefinition) =>
  formatValue(command.label ?? command.key);

/**
 * Command catalog page with searchable workflow command registry.
 */
export async function CommandCatalogPage({
  appKey,
  appLabel,
  testIdPrefix,
  appBasePath,
  searchParams,
}: CommandCatalogPageProps) {
  const ui = createUiServerClient();
  let commands: UiCommandDefinition[] = [];
  let me: UiMe | null = null;
  let errorMessage: string | null = null;
  let readRegistry: UiReadRegistry | null = null;
  let readError: string | null = null;

  try {
    const [registryResult, meResult, readResult] = await Promise.all([
      fetchCommandRegistry(ui),
      ui.me(),
      ui.readRegistry().catch((error) => {
        readError = formatUiError(error, t("errors.readRegistry"));
        return null;
      }),
    ]);
    commands = registryResult.commands;
    me = meResult;
    readRegistry = readResult;
    if (registryResult.error) {
      errorMessage = formatUiError(registryResult.error, t("errors.load"));
    }
  } catch (error) {
    errorMessage = formatUiError(error, t("errors.load"));
  }

  const getParamValue = (value: string | string[] | undefined) =>
    Array.isArray(value) ? value[0] ?? "" : value ?? "";
  const query = getParamValue(searchParams?.q).trim();
  const categoryFilter = getParamValue(searchParams?.category).trim();
  const capabilityFilter = getParamValue(searchParams?.capability).trim();
  const accessFilter = getParamValue(searchParams?.access).trim();

  const capabilitySet = resolveCapabilitySet(me?.capabilities);
  const normalizedQuery = query.toLowerCase();
  const categories = Array.from(
    new Set(
      commands
        .map((command) => command.schema_category)
        .filter(
          (value): value is string =>
            typeof value === "string" && value.trim().length > 0
        )
    )
  ).sort();
  const capabilities = Array.from(
    new Set(
      commands
        .map((command) => command.capability)
        .filter(
          (value): value is string =>
            typeof value === "string" && value.trim().length > 0
        )
    )
  ).sort();

  const rows = commands.map((command) => {
    const href = resolveCommandHref(command, appBasePath, appKey);
    const readState = resolveCommandReadState(command, readRegistry, capabilitySet);
    const capabilityAllowed = hasCapability(capabilitySet, command.capability);
    return { command, href, readState, capabilityAllowed,
      allowed: Boolean(href) && capabilityAllowed && readState === "allowed" };
  });
  const matchingRows = rows.filter(({ command }) => {
    const label = resolveLabel(command);
    const searchFields = [
      label,
      command.key,
      command.description ?? "",
      command.workflow_key ?? "",
      command.binding_key ?? "",
      command.stage_key ?? "",
      command.schema_category ?? "",
      command.capability ?? "",
      formatCommandBackendReference(command),
    ]
      .filter(Boolean)
      .join(" ")
      .toLowerCase();

    if (normalizedQuery && !searchFields.includes(normalizedQuery)) {
      return false;
    }
    if (categoryFilter && command.schema_category !== categoryFilter) {
      return false;
    }
    if (capabilityFilter) {
      if (capabilityFilter === "__none__") {
        if (command.capability) return false;
      } else if (command.capability !== capabilityFilter) {
        return false;
      }
    }

    return true;
  });

  const sortedRows = matchingRows.filter(({ command, allowed }) =>
    accessFilter === "allowed" ? allowed :
    accessFilter === "missing" ? !allowed :
    accessFilter === "none" ? !command.capability : true,
  ).sort((a, b) => resolveLabel(a.command).localeCompare(resolveLabel(b.command)));
  const hasFilters = Boolean(normalizedQuery || categoryFilter || capabilityFilter || accessFilter);
  const blocked = {
    route: matchingRows.filter((row) => row.capabilityAllowed && row.readState === "allowed" && !row.href).length,
    command: matchingRows.filter((row) => !row.capabilityAllowed).length,
    read: matchingRows.filter((row) => row.capabilityAllowed && row.readState !== "allowed").length,
  };
  const unavailableRead = matchingRows.some((row) => row.readState === "unavailable");
  const showBlocked = matchingRows.length > 0 && !matchingRows.some((row) => row.allowed) && accessFilter !== "missing";

  return (
    <PageContainer className="space-y-6">
      <PageHeader
        title={t("title", { appLabel })}
        description={t("description")}
      />
      <Section
        title={t("sections.registryTitle")}
        description={t("sections.registryDescription")}
        collapsible
        collapseKey="command-catalog.registry"
      >
        <div data-testid={buildTestId(testIdPrefix, "ready")} className="space-y-4">
          {errorMessage ? (
            <div role="status" aria-label={t("statusLabel")} aria-live="polite" aria-atomic="true"
              data-testid={`${testIdPrefix}-degraded`}>
              <p>{t("errors.registryUnavailable")}</p><p>{errorMessage}</p>
            </div>
          ) : null}
          {readError ? (
            <div role="status" aria-label={t("readStatusLabel")} aria-live="polite" aria-atomic="true"
              data-testid={`${testIdPrefix}-read-registry-degraded`}>
              <p>{t("errors.readRegistry")}</p><p>{readError}</p>
            </div>
          ) : null}
          <CommandCatalogFilters
            query={query}
            category={categoryFilter}
            capability={capabilityFilter}
            access={accessFilter}
            categories={categories.map((value) => ({
              value,
              label: formatValue(value),
            }))}
            capabilities={capabilities.map((value) => ({
              value,
              label: formatValue(value),
            }))}
            appBasePath={appBasePath}
            testIdPrefix={testIdPrefix}
          />
          <div className="text-xs text-ui-muted">
            {hasFilters
              ? t("summary.filtered", {
                  count: sortedRows.length,
                  total: commands.length,
                })
              : t("summary.available", { count: sortedRows.length })}
          </div>
          {showBlocked ? (
            <div className="rounded-xl border border-ui-border bg-ui-surface/70 p-4 text-xs text-ui-muted">
              {t(unavailableRead ? "summary.readUnavailable" : "summary.blocked", { appLabel, ...blocked })}
            </div>
          ) : null}
          {sortedRows.length === 0 ? (
            <div className="rounded-xl border border-ui-border bg-ui-surface/70 p-4 text-sm text-ui-muted">
              {errorMessage || showBlocked ? null : hasFilters ? t("summary.filteredEmpty") : t("summary.empty")}
            </div>
          ) : (
            <div className="grid gap-4 lg:grid-cols-2">
              {sortedRows.map(({ command, href: commandHref, readState, capabilityAllowed, allowed }) => {
                const statusLabel = !capabilityAllowed ? t("status.missingCapability") :
                  readState === "unavailable" ? t("status.readUnavailable") :
                  readState === "denied" ? t("status.readRequired") :
                  !commandHref ? t("status.noTarget") : t("status.allowed");
                const backendReference = formatCommandBackendReference(command);
                return (
                  <div
                    key={command.key}
                    className="rounded-2xl border border-ui-border bg-ui-surface/80 p-5 shadow-soft"
                  >
                    <div className="flex flex-wrap items-start justify-between gap-3">
                      <div>
                        <div className="text-sm font-semibold text-ui-ink">
                          {resolveRowDisplayText(resolveLabel(command), command.label_ar, getPublicConfig().locale)}
                        </div>
                        <div className="text-xs text-ui-muted">{command.key}</div>
                      </div>
                      <Badge tone={allowed ? "accent" : "neutral"}>
                        {statusLabel}
                      </Badge>
                    </div>
                    {command.description ? (
                      <p className="mt-3 text-sm text-ui-muted">{resolveRowDisplayText(command.description, command.description_ar, getPublicConfig().locale)}</p>
                    ) : null}
                    {commandHref && allowed ? (
                      <div className="mt-4">
                        <Button asChild variant="ghost">
                          <a href={commandHref}>{t("actions.openRequest")}</a>
                        </Button>
                      </div>
                    ) : null}
                    {!commandHref ? <p className="mt-2 text-xs text-ui-muted">{t("noTargetDescription", { appLabel })}</p> : null}
                    {backendReference ? <div className="mt-3 text-xs"><span>{t("fields.backendReference")}</span><p>{backendReference}</p></div> : null}
                    <dl className="mt-4 grid gap-3 text-xs sm:grid-cols-2">
                      <div>
                        <dt className="uppercase tracking-wide text-ui-muted">
                          {t("fields.requiredCapability")}
                        </dt>
                        <dd className="mt-1 text-ui-ink">
                          {formatValue(command.capability)}
                        </dd>
                      </div>
                      <div>
                        <dt className="uppercase tracking-wide text-ui-muted">
                          {t("fields.workflow")}
                        </dt>
                        <dd className="mt-1 text-ui-ink">
                          {formatValue(command.workflow_key)}
                        </dd>
                      </div>
                      <div>
                        <dt className="uppercase tracking-wide text-ui-muted">
                          Binding stage
                        </dt>
                        <dd className="mt-1 text-ui-ink">
                          {formatValue(
                            command.binding_key && command.stage_key
                              ? `${command.binding_key}/${command.stage_key}`
                              : command.binding_key ?? command.stage_key ?? ""
                          )}
                        </dd>
                      </div>
                      {commandHref ? (
                        <div>
                          <dt className="uppercase tracking-wide text-ui-muted">
                            {t("fields.route")}
                          </dt>
                          <dd className="mt-1 break-all text-ui-ink">
                            {commandHref}
                          </dd>
                        </div>
                      ) : null}
                      <div>
                        <dt className="uppercase tracking-wide text-ui-muted">
                          {t("fields.schema")}
                        </dt>
                        <dd className="mt-1 text-ui-ink">
                          {formatValue(command.schema_category)}
                        </dd>
                      </div>
                    </dl>
                  </div>
                );
              })}
            </div>
          )}
        </div>
      </Section>
    </PageContainer>
  );
}
