import "server-only";

import { revalidatePath } from "next/cache";
import { createUiServerClient } from "@masarx/api/server";
import { createServerClient } from "@masarx/auth/server";
import { Badge } from "./badge";
import { Button } from "./button";
import { PageContainer } from "./page-container";
import { PageHeader } from "./page-header";
import { Section } from "./section";
import { formatUiError } from "./utils";
import { hasCapability, resolveCapabilitySet } from "./capabilities";

type SearchParams = Record<string, string | string[] | undefined>;

type WorkflowBindingsPageProps = {
  appKey: "console" | "portal";
  appBasePath: string;
  baseHref: string;
  testIdPrefix: string;
  searchParams?: SearchParams;
};

type BindingItem = Record<string, unknown>;
type InventoryItem = Record<string, unknown>;
type JsonRecord = Record<string, unknown>;

function firstValue(value: string | string[] | undefined) {
  if (Array.isArray(value)) return value[0];
  return value;
}

function stringValue(value: unknown) {
  return typeof value === "string" ? value : null;
}

function booleanValue(value: unknown) {
  return typeof value === "boolean" ? value : false;
}

function arrayValue(value: unknown) {
  return Array.isArray(value) ? value : [];
}

function recordValue(value: unknown): JsonRecord | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as JsonRecord)
    : null;
}

function toneForExecutionKind(value: string | null) {
  if (value === "workflow_native") return "success" as const;
  if (value === "hybrid_task_backed") return "warning" as const;
  return "neutral" as const;
}

function toneForConfigurability(value: string | null) {
  if (value === "workflow_configurable") return "success" as const;
  if (value === "policy_only") return "warning" as const;
  return "neutral" as const;
}

/**
 * Scope-aware workflow bindings page with override controls and inventory audit.
 */
export async function WorkflowBindingsPage({
  appKey,
  appBasePath,
  baseHref,
  testIdPrefix,
  searchParams,
}: WorkflowBindingsPageProps) {
  const ui = createUiServerClient();
  const client = createServerClient({ allowCookieSet: false });

  let meError: string | null = null;
  let bindingsError: string | null = null;
  let inventoryError: string | null = null;
  let capabilities: string[] = [];
  let requestedScopeType = firstValue(searchParams?.scope_type) ?? null;
  let requestedScopeId = firstValue(searchParams?.scope_id) ?? null;
  let bindingItems: BindingItem[] = [];
  let inventoryItems: InventoryItem[] = [];

  try {
    const me = await ui.me();
    capabilities = me?.capabilities ?? [];
    requestedScopeType ||= me?.access_scope?.scope_type ?? null;
    requestedScopeId ||= me?.access_scope?.scope_id ?? null;
  } catch (error) {
    meError = formatUiError(error, "Unable to load current scope.");
  }

  const capabilitySet = resolveCapabilitySet(capabilities);
  const canRead = hasCapability(capabilitySet, "workflow_runs.read");
  const canWrite = hasCapability(capabilitySet, "workflow_runs.write");

  try {
    const { data, error } = await client.rpc("ui_list_workflow_bindings_v1", {
      p_scope_type: requestedScopeType,
      p_scope_id: requestedScopeId,
    });
    if (error) {
      bindingsError = formatUiError(error, "Unable to load workflow bindings.");
    } else {
      const items = arrayValue((data as Record<string, unknown> | null)?.items);
      bindingItems = items.filter(
        (item): item is BindingItem => Boolean(item) && typeof item === "object",
      );
    }
  } catch (error) {
    bindingsError = formatUiError(error, "Unable to load workflow bindings.");
  }

  try {
    const { data, error } = await client
      .from("workflow_business_action_inventory_v1")
      .select("*")
      .order("binding_key", { ascending: true });
    if (error) {
      inventoryError = formatUiError(error, "Unable to load workflow business action inventory.");
    } else {
      inventoryItems = Array.isArray(data)
        ? data.filter(
            (item): item is InventoryItem => Boolean(item) && typeof item === "object",
          )
        : [];
    }
  } catch (error) {
    inventoryError = formatUiError(error, "Unable to load workflow business action inventory.");
  }

  async function cloneOverride(formData: FormData) {
    "use server";
    const bindingKey = String(formData.get("binding_key") ?? "").trim();
    const stageKey = String(formData.get("stage_key") ?? "").trim();
    const scopeType = String(formData.get("scope_type") ?? "").trim() || null;
    const scopeId = String(formData.get("scope_id") ?? "").trim() || null;

    const server = createServerClient({ allowCookieSet: false });
    const { error } = await server.rpc("ui_workflow_binding_clone_override_v1", {
      p_binding_key: bindingKey,
      p_stage_key: stageKey,
      p_scope_type: scopeType,
      p_scope_id: scopeId,
    });
    if (error) {
      throw new Error(formatUiError(error, "Workflow binding override clone failed."));
    }
    revalidatePath(baseHref);
  }

  async function resetOverride(formData: FormData) {
    "use server";
    const bindingKey = String(formData.get("binding_key") ?? "").trim();
    const stageKey = String(formData.get("stage_key") ?? "").trim();
    const scopeType = String(formData.get("scope_type") ?? "").trim() || null;
    const scopeId = String(formData.get("scope_id") ?? "").trim() || null;

    const server = createServerClient({ allowCookieSet: false });
    const { error } = await server.rpc("ui_workflow_binding_reset_override_v1", {
      p_binding_key: bindingKey,
      p_stage_key: stageKey,
      p_scope_type: scopeType,
      p_scope_id: scopeId,
    });
    if (error) {
      throw new Error(formatUiError(error, "Workflow binding reset failed."));
    }
    revalidatePath(baseHref);
  }

  return (
    <PageContainer
      className="space-y-6"
      data-testid={`${testIdPrefix}-ready`}
    >
      <PageHeader
        title="Workflow bindings"
        eyebrow={appKey === "console" ? "Console" : "Portal"}
        description="Resolve effective workflow bindings for business-affecting actions, clone scoped overrides, and audit which actions are workflow-native versus still hybrid or direct."
      />

      <Section
        title="Resolved scope"
        description="Bindings resolve through the dynamic scope ladder. The page below shows the currently requested scope and whether each stage is overridden there."
      >
        <div
          className="grid gap-3 text-sm sm:grid-cols-3"
          data-testid={`${testIdPrefix}-scope`}
        >
          <div className="rounded-xl border border-ui-border/60 bg-ui-surface/70 p-4">
            <div className="text-xs uppercase tracking-wide text-ui-muted">Scope type</div>
            <div className="mt-1 font-medium text-ui-ink">
              {requestedScopeType ?? "Not available"}
            </div>
          </div>
          <div className="rounded-xl border border-ui-border/60 bg-ui-surface/70 p-4">
            <div className="text-xs uppercase tracking-wide text-ui-muted">Scope id</div>
            <div className="mt-1 break-all font-medium text-ui-ink">
              {requestedScopeId ?? "Not available"}
            </div>
          </div>
          <div className="rounded-xl border border-ui-border/60 bg-ui-surface/70 p-4">
            <div className="text-xs uppercase tracking-wide text-ui-muted">Capabilities</div>
            <div className="mt-1 flex flex-wrap gap-2">
              <Badge tone={canRead ? "success" : "neutral"}>
                {canRead ? "workflow_runs.read" : "read missing"}
              </Badge>
              <Badge tone={canWrite ? "success" : "neutral"}>
                {canWrite ? "workflow_runs.write" : "write missing"}
              </Badge>
            </div>
          </div>
        </div>
        {meError ? <p className="mt-3 text-xs text-ui-muted">{meError}</p> : null}
      </Section>

      <Section
        title="Bindings"
        description="Each row is one binding stage. Use clone override to fork the resolved template into the current scope, or reset to inherit from the parent scope again."
        collapsible
        collapseKey="workflow-bindings.bindings"
      >
        {!canRead ? (
          <div className="rounded-xl border border-ui-border/60 bg-ui-surface/70 p-4 text-sm text-ui-muted">
            This surface requires the `workflow_runs.read` capability.
          </div>
        ) : bindingsError ? (
          <div className="rounded-xl border border-ui-border/60 bg-ui-surface/70 p-4 text-sm text-ui-muted">
            {bindingsError}
          </div>
        ) : bindingItems.length === 0 ? (
          <div className="rounded-xl border border-ui-border/60 bg-ui-surface/70 p-4 text-sm text-ui-muted">
            No workflow bindings were resolved for this scope.
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="min-w-full text-left text-sm" data-testid={`${testIdPrefix}-bindings-table`}>
              <thead className="text-xs uppercase tracking-wide text-ui-muted">
                <tr className="border-b border-ui-border/60">
                  <th className="px-3 py-3">Binding</th>
                  <th className="px-3 py-3">Stage</th>
                  <th className="px-3 py-3">Resolved from</th>
                  <th className="px-3 py-3">Template</th>
                  <th className="px-3 py-3">Status</th>
                  <th className="px-3 py-3">Actions</th>
                </tr>
              </thead>
              <tbody>
                {bindingItems.map((item) => {
                  const bindingKey = stringValue(item.binding_key) ?? "";
                  const stageKey = stringValue(item.stage_key) ?? "";
                  const templateId = stringValue(item.workflow_template_id);
                  const templateName = stringValue(item.workflow_template_name);
                  const resolvedScopeType = stringValue(item.resolved_scope_type);
                  const resolvedScopeId = stringValue(item.resolved_scope_id);
                  const overridden = booleanValue(item.is_overridden_at_requested_scope);
                  const stageValue = recordValue(item.stage_value);
                  const stageEnabled = booleanValue(stageValue?.enabled);
                  return (
                    <tr
                      key={`${bindingKey}:${stageKey}`}
                      className="border-b border-ui-border/40 align-top"
                    >
                      <td className="px-3 py-4">
                        <div className="font-medium text-ui-ink">
                          {stringValue(item.binding_label) ?? bindingKey}
                        </div>
                        <div className="text-xs text-ui-muted">{bindingKey}</div>
                      </td>
                      <td className="px-3 py-4">
                        <div className="font-medium text-ui-ink">
                          {stringValue(item.stage_label) ?? stageKey}
                        </div>
                        <div className="text-xs text-ui-muted">{stageKey}</div>
                      </td>
                      <td className="px-3 py-4">
                        <div className="font-medium text-ui-ink">
                          {resolvedScopeType ?? "unknown"}
                        </div>
                        <div className="text-xs text-ui-muted break-all">
                          {resolvedScopeId ?? "global"}
                        </div>
                      </td>
                      <td className="px-3 py-4">
                        <div className="font-medium text-ui-ink">
                          {templateName ?? "Template missing"}
                        </div>
                        <div className="text-xs text-ui-muted break-all">
                          {templateId ?? "No template"}
                        </div>
                      </td>
                      <td className="px-3 py-4">
                        <div className="flex flex-wrap gap-2">
                          <Badge tone={overridden ? "warning" : "neutral"}>
                            {overridden ? "Scoped override" : "Inherited"}
                          </Badge>
                          <Badge tone={stageEnabled ? "success" : "neutral"}>
                            {stageEnabled ? "Enabled" : "Disabled"}
                          </Badge>
                        </div>
                      </td>
                      <td className="px-3 py-4">
                        <div className="flex flex-wrap gap-2">
                          {templateId ? (
                            <Button asChild size="sm" variant="ghost">
                              <a href={`${appBasePath}/workflows/templates/${encodeURIComponent(templateId)}`}>
                                Open in studio
                              </a>
                            </Button>
                          ) : null}
                          <form action={cloneOverride}>
                            <input type="hidden" name="binding_key" value={bindingKey} />
                            <input type="hidden" name="stage_key" value={stageKey} />
                            <input type="hidden" name="scope_type" value={requestedScopeType ?? ""} />
                            <input type="hidden" name="scope_id" value={requestedScopeId ?? ""} />
                            <Button size="sm" variant="soft" disabled={!canWrite}>
                              Clone override
                            </Button>
                          </form>
                          <form action={resetOverride}>
                            <input type="hidden" name="binding_key" value={bindingKey} />
                            <input type="hidden" name="stage_key" value={stageKey} />
                            <input type="hidden" name="scope_type" value={requestedScopeType ?? ""} />
                            <input type="hidden" name="scope_id" value={requestedScopeId ?? ""} />
                            <Button size="sm" variant="ghost" disabled={!canWrite}>
                              Reset
                            </Button>
                          </form>
                        </div>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </Section>

      <Section
        title="Business action inventory"
        description="Audit snapshot of business-affecting actions and whether they are workflow-native, hybrid, or still direct."
        collapsible
        collapseKey="workflow-bindings.inventory"
      >
        {inventoryError ? (
          <div className="rounded-xl border border-ui-border/60 bg-ui-surface/70 p-4 text-sm text-ui-muted">
            {inventoryError}
          </div>
        ) : inventoryItems.length === 0 ? (
          <div className="rounded-xl border border-ui-border/60 bg-ui-surface/70 p-4 text-sm text-ui-muted">
            No business action inventory rows are registered yet.
          </div>
        ) : (
          <div className="grid gap-4 lg:grid-cols-2" data-testid={`${testIdPrefix}-inventory`}>
            {inventoryItems.map((item) => {
              const bindingKey = stringValue(item.binding_key) ?? "";
              const executionKind = stringValue(item.current_execution_kind);
              const configurability = stringValue(item.configurability_status);
              return (
                <div
                  key={bindingKey}
                  className="rounded-2xl border border-ui-border/60 bg-ui-surface/80 p-5 shadow-sm"
                >
                  <div className="flex flex-wrap items-start justify-between gap-3">
                    <div>
                      <div className="text-sm font-semibold text-ui-ink">
                        {stringValue(item.label) ?? bindingKey}
                      </div>
                      <div className="text-xs text-ui-muted">{bindingKey}</div>
                    </div>
                    <div className="flex flex-wrap gap-2">
                      <Badge tone={toneForExecutionKind(executionKind)}>
                        {executionKind ?? "unknown"}
                      </Badge>
                      <Badge tone={toneForConfigurability(configurability)}>
                        {configurability ?? "unknown"}
                      </Badge>
                    </div>
                  </div>
                  {stringValue(item.description) ? (
                    <p className="mt-3 text-sm text-ui-muted">
                      {stringValue(item.description)}
                    </p>
                  ) : null}
                  <dl className="mt-4 grid gap-3 text-xs sm:grid-cols-2">
                    <div>
                      <dt className="uppercase tracking-wide text-ui-muted">Entrypoint</dt>
                      <dd className="mt-1 text-ui-ink">
                        {stringValue(item.entrypoint_type) ?? "unknown"}
                      </dd>
                    </div>
                    <div>
                      <dt className="uppercase tracking-wide text-ui-muted">Surface</dt>
                      <dd className="mt-1 text-ui-ink">
                        {stringValue(item.actor_surface) ?? "unknown"}
                      </dd>
                    </div>
                    <div>
                      <dt className="uppercase tracking-wide text-ui-muted">Stages</dt>
                      <dd className="mt-1 text-ui-ink">
                        {String(item.registered_stage_count ?? 0)} total / {String(item.enabled_stage_count ?? 0)} enabled
                      </dd>
                    </div>
                    <div>
                      <dt className="uppercase tracking-wide text-ui-muted">Owner</dt>
                      <dd className="mt-1 text-ui-ink">
                        {stringValue(item.owner) ?? "unknown"} / {stringValue(item.migration_phase) ?? "unknown"}
                      </dd>
                    </div>
                  </dl>
                </div>
              );
            })}
          </div>
        )}
      </Section>
    </PageContainer>
  );
}
