import "server-only";

import { createUiServerClient } from "@masarx/api/server";
import type { UiReadRegistry } from "@masarx/api";
import { createUiTranslator } from "./i18n";
import { PageHeader } from "./page-header";
import { Section } from "./section";
import {
  WorkflowTemplateCreateForm,
  type WorkflowTemplateOption,
} from "./workflow-template-create-form";
import { formatUiError } from "./utils";
import { findRegistryResource } from "./ui-registry-utils";

type WorkflowTemplateCreatePageProps = {
  appBasePath: string;
  testIdPrefix?: string | null;
};

function normalizeTemplateOption(item: Record<string, unknown>): WorkflowTemplateOption | null {
  const id = typeof item.id === "string" ? item.id.trim() : "";
  const name = typeof item.name === "string" ? item.name.trim() : "";
  if (!id || !name) return null;
  const status = typeof item.status === "string" ? item.status.trim() : null;
  const versionRaw = item.version;
  const version =
    typeof versionRaw === "number"
      ? versionRaw
      : typeof versionRaw === "string"
        ? Number.parseInt(versionRaw, 10)
        : null;
  return {
    id,
    name,
    status,
    version: Number.isFinite(version) ? (version as number) : null,
  };
}

export async function WorkflowTemplateCreatePage({
  appBasePath,
  testIdPrefix,
}: WorkflowTemplateCreatePageProps) {
  const t = createUiTranslator("ui.workflowStudio");
  const ui = createUiServerClient();

  let templates: WorkflowTemplateOption[] = [];
  let templatesError: string | null = null;
  let userCapabilities: string[] | null = null;
  let registry: UiReadRegistry | null = null;
  let capabilityWrite: string | null = null;

  {
    const [meResult, registryResult] = await Promise.allSettled([ui.me(), ui.readRegistry()]);

    if (meResult.status === "fulfilled") {
      const me = meResult.value;
      userCapabilities = Array.isArray(me?.capabilities) ? me.capabilities : null;
    } else {
      userCapabilities = null;
    }

    if (registryResult.status === "fulfilled") {
      registry = registryResult.value as UiReadRegistry;
    } else {
      registry = null;
    }

    const workflowTemplatesResource = findRegistryResource(registry, "workflow_templates");
    capabilityWrite = workflowTemplatesResource?.capability_write ?? null;
  }

  try {
    const list = await ui.listResource(
      "workflow_templates",
      {},
      50,
      0,
      { key: "created_at", direction: "desc" }
    );
    const items = Array.isArray(list.items) ? list.items : [];
    templates = items
      .map((item) => normalizeTemplateOption(item))
      .filter((entry): entry is WorkflowTemplateOption => Boolean(entry));
  } catch (error) {
    templates = [];
    templatesError = formatUiError(error, t("create.errors.loadTemplates"));
  }

  const resolvedTestIdPrefix = testIdPrefix?.trim() || "";
  const readyTestId = resolvedTestIdPrefix
    ? `${resolvedTestIdPrefix}-ready`
    : undefined;

  return (
    <div className="space-y-6" data-testid={readyTestId}>
      <PageHeader title={t("create.title")} description={t("create.description")} />
      <Section title={t("create.sectionTitle")} collapsible={false}>
        {templatesError ? (
          <p className="text-sm text-ui-muted">{templatesError}</p>
        ) : null}
        <WorkflowTemplateCreateForm
          appBasePath={appBasePath}
          capabilities={userCapabilities}
          capabilityWrite={capabilityWrite}
          templates={templates}
          testIdPrefix={resolvedTestIdPrefix || null}
        />
      </Section>
    </div>
  );
}
