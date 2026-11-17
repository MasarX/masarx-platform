import "server-only";
import { createUiServerClient } from "@masarx/api/server";
import { UiCommandDefinition, UiMe } from "@masarx/api";
import { Badge } from "./badge";
import { Button } from "./button";
import { CommandCatalogFilters } from "./command-catalog-filters";
import { fetchCommandRegistry } from "./command-registry";
import { resolveCommandHref } from "./command-utils";
import { PageContainer } from "./page-container";
import { PageHeader } from "./page-header";
import { Section } from "./section";
import { createUiTranslator } from "./i18n";
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

  try {
    const [registryResult, meResult] = await Promise.all([
      fetchCommandRegistry(ui),
      ui.me()
    ]);
    commands = registryResult.commands;
    me = meResult;
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

  if (errorMessage) {
    return (
      <PageContainer className="space-y-6">
        <PageHeader
          title={t("title", { appLabel })}
          description={t("description")}
        />
        <Section>
          <div
            data-testid={buildTestId(testIdPrefix, "error")}
            className="space-y-2 text-sm text-ui-muted"
          >
            <p>{t("errors.unavailable")}</p>
            <p className="text-xs text-ui-muted">{errorMessage}</p>
          </div>
        </Section>
      </PageContainer>
    );
  }

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

  const filteredCommands = commands.filter((command) => {
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

    if (accessFilter) {
      const capabilityAllowed = hasCapability(capabilitySet, command.capability);
      if (accessFilter === "allowed" && !capabilityAllowed) return false;
      if (
        accessFilter === "missing" &&
        (capabilityAllowed || !command.capability)
      ) {
        return false;
      }
      if (accessFilter === "none" && command.capability) return false;
    }

    return true;
  });

  const sortedCommands = [...filteredCommands].sort((a, b) =>
    resolveLabel(a).localeCompare(resolveLabel(b))
  );
  const hasFilters = Boolean(
    normalizedQuery || categoryFilter || capabilityFilter || accessFilter
  );
  const allowedCount = sortedCommands.filter((command) => {
    if (!command.capability) return true;
    return hasCapability(capabilitySet, command.capability);
  }).length;
  const showCapabilityNotice =
    sortedCommands.length > 0 &&
    allowedCount === 0 &&
    accessFilter !== "missing";

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
                  count: sortedCommands.length,
                  total: commands.length,
                })
              : t("summary.available", { count: sortedCommands.length })}
          </div>
          {showCapabilityNotice ? (
            <div className="rounded-xl border border-ui-border bg-ui-surface/70 p-4 text-xs text-ui-muted">
              {t("summary.capabilityBlocked")}
            </div>
          ) : null}
          {sortedCommands.length === 0 ? (
            <div className="rounded-xl border border-ui-border bg-ui-surface/70 p-4 text-sm text-ui-muted">
              {hasFilters ? t("summary.filteredEmpty") : t("summary.empty")}
            </div>
          ) : (
            <div className="grid gap-4 lg:grid-cols-2">
              {sortedCommands.map((command) => {
                const capability = command.capability ?? null;
                const capabilityAllowed = hasCapability(capabilitySet, capability);
                const statusLabel = capability
                  ? capabilityAllowed
                    ? t("status.allowed")
                    : t("status.missingCapability")
                  : t("status.noCapability");
                const commandHref = resolveCommandHref(command, appBasePath, appKey);
                return (
                  <div
                    key={command.key}
                    className="rounded-2xl border border-ui-border bg-ui-surface/80 p-5 shadow-soft"
                  >
                    <div className="flex flex-wrap items-start justify-between gap-3">
                      <div>
                        <div className="text-sm font-semibold text-ui-ink">
                          {resolveLabel(command)}
                        </div>
                        <div className="text-xs text-ui-muted">{command.key}</div>
                      </div>
                      <Badge tone={capabilityAllowed ? "accent" : "neutral"}>
                        {statusLabel}
                      </Badge>
                    </div>
                    {command.description ? (
                      <p className="mt-3 text-sm text-ui-muted">{command.description}</p>
                    ) : null}
                    {commandHref && capabilityAllowed ? (
                      <div className="mt-4">
                        <Button asChild variant="ghost">
                          <a href={commandHref}>{t("actions.openRequest")}</a>
                        </Button>
                      </div>
                    ) : null}
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
