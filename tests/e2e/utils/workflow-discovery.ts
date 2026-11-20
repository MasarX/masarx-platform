import { createAuthedSupabaseClient, rpcWithRetry, signOutSupabaseClient } from "./supabase";
import { createE2EDatabasePool } from "./db";

export type WorkflowBinding = {
  businessAction: string;
  stage: string;
  templateName: string | null;
  scopeType: string | null;
  scopeId: string | null;
  enabled: boolean;
  metadata: unknown;
};

export type WorkflowTemplate = {
  id: string;
  name: string;
  description: string | null;
  version: number;
  status: string;
  scopeType: string;
  scopeId: string | null;
};

export type WorkflowStep = {
  id: string;
  sequenceOrder: number;
  operationName: string;
  transitionCondition: string;
  nextOperationName: string | null;
  enabled: boolean;
  metadata: unknown;
};

let templatesCache: WorkflowTemplate[] | null = null;
const stepsCache = new Map<string, WorkflowStep[]>();

type UiMeResult = {
  access_scope?: {
    scope_type?: string | null;
    scope_id?: string | null;
  } | null;
};

function normalizeBindingRow(row: Record<string, unknown>): WorkflowBinding {
  const stageValue =
    row.stage_value && typeof row.stage_value === "object"
      ? (row.stage_value as Record<string, unknown>)
      : null;
  return {
    businessAction: String(
      row.binding_key ?? row.business_action ?? "",
    ).trim(),
    stage: String(row.stage_key ?? row.stage ?? "").trim(),
    templateName:
      typeof row.workflow_template_name === "string"
        ? row.workflow_template_name.trim()
        : typeof row.template_name === "string"
          ? row.template_name.trim()
          : null,
    scopeType:
      typeof row.resolved_scope_type === "string"
        ? row.resolved_scope_type.trim()
        : typeof row.scope_type === "string"
          ? row.scope_type.trim()
          : null,
    scopeId:
      typeof row.resolved_scope_id === "string"
        ? row.resolved_scope_id.trim()
        : typeof row.scope_id === "string"
          ? row.scope_id.trim()
          : null,
    enabled:
      typeof stageValue?.enabled === "boolean"
        ? stageValue.enabled
        : row.enabled !== false,
    metadata: stageValue ?? row.metadata ?? null,
  };
}

function normalizeBindingsFromRpc(data: unknown): WorkflowBinding[] {
  if (!data || typeof data !== "object") return [];
  const raw = data as Record<string, unknown>;
  const rows = Array.isArray(data)
    ? data
    : Array.isArray(raw.items)
      ? raw.items
      : Array.isArray(raw.bindings)
        ? raw.bindings
        : [];
  return rows
    .filter((item): item is Record<string, unknown> => Boolean(item && typeof item === "object"))
    .map(normalizeBindingRow);
}

function normalizeScopeInput(scope: UiMeResult["access_scope"] | null | undefined) {
  const scopeType =
    typeof scope?.scope_type === "string" && scope.scope_type.trim()
      ? scope.scope_type.trim()
      : null;
  const scopeId =
    typeof scope?.scope_id === "string" && scope.scope_id.trim()
      ? scope.scope_id.trim()
      : null;
  return {
    scopeType,
    scopeId,
  };
}

async function fetchBindingsViaSupabaseRpc(supabase: Awaited<ReturnType<typeof createAuthedSupabaseClient>>) {
  const { data: me, error: meError } = await rpcWithRetry<UiMeResult>(
    supabase,
    "ui_me_v1",
    null,
    { label: "ui_me_v1:workflow-bindings" },
  );

  if (meError || !me) {
    throw new Error(
      `Failed to resolve workflow bindings scope: ${String((meError as { message?: string } | null)?.message || "ui_me_v1 returned no data")}`,
    );
  }

  const { scopeType, scopeId } = normalizeScopeInput(me.access_scope);
  const scopeArgs =
    scopeType === "global"
      ? { p_scope_type: "global", p_scope_id: null }
      : scopeType
        ? { p_scope_type: scopeType, p_scope_id: scopeId }
        : null;

  const { data, error } = await rpcWithRetry(
    supabase,
    "ui_list_workflow_bindings_v1",
    scopeArgs,
    { label: `ui_list_workflow_bindings_v1:${scopeType ?? "unknown"}` },
  );
  if (error) {
    throw new Error(
      `Failed to read workflow bindings: ${String((error as { message?: string } | null)?.message || error)}`,
    );
  }
  return normalizeBindingsFromRpc(data);
}

export async function fetchWorkflowBindings(params: {
  email: string;
  password: string;
}): Promise<WorkflowBinding[]> {
  const supabase = await createAuthedSupabaseClient({
    email: params.email,
    password: params.password,
    label: "workflow-bindings",
  });
  try {
    return await fetchBindingsViaSupabaseRpc(supabase);
  } finally {
    await signOutSupabaseClient(supabase, { label: "workflow-bindings" });
  }
}

/**
 * Fetch all active workflow templates. Cached per-process.
 */
export async function fetchActiveTemplates(): Promise<WorkflowTemplate[]> {
  if (templatesCache) return templatesCache;

  const { pool } = await createE2EDatabasePool("workflow-templates");
  try {
    const res = await pool.query(
      `SELECT id,
              name,
              description,
              version,
              status,
              scope_type,
              scope_id
         FROM workflow_templates
        WHERE status = 'active'
        ORDER BY name`
    );
    const templates: WorkflowTemplate[] = (res.rows ?? []).map(
      (row: Record<string, unknown>) => ({
        id: String(row.id ?? "").trim(),
        name: String(row.name ?? "").trim(),
        description:
          typeof row.description === "string" ? row.description : null,
        version: typeof row.version === "number" ? row.version : 1,
        status: String(row.status ?? "active").trim(),
        scopeType: String(row.scope_type ?? "").trim(),
        scopeId:
          typeof row.scope_id === "string" ? row.scope_id.trim() : null,
      })
    );
    templatesCache = templates;
    return templates;
  } finally {
    await pool.end();
  }
}

/**
 * Fetch steps for a specific workflow template. Cached per template id.
 */
export async function fetchTemplateSteps(
  templateId: string
): Promise<WorkflowStep[]> {
  const key = templateId.trim();
  if (!key) return [];
  const cached = stepsCache.get(key);
  if (cached) return cached;

  const { pool } = await createE2EDatabasePool(`workflow-steps:${key}`);
  try {
    const res = await pool.query(
      `SELECT id,
              sequence_order,
              operation_name,
              transition_condition,
              next_operation_name,
              enabled,
              COALESCE(metadata, '{}'::jsonb) AS metadata
         FROM workflow_template_steps
        WHERE workflow_template_id = $1
        ORDER BY sequence_order`,
      [key]
    );
    const steps: WorkflowStep[] = (res.rows ?? []).map(
      (row: Record<string, unknown>) => ({
        id: String(row.id ?? "").trim(),
        sequenceOrder:
          typeof row.sequence_order === "number" ? row.sequence_order : 0,
        operationName: String(row.operation_name ?? "").trim(),
        transitionCondition: String(
          row.transition_condition ?? ""
        ).trim(),
        nextOperationName:
          typeof row.next_operation_name === "string"
            ? row.next_operation_name.trim()
            : null,
        enabled: row.enabled !== false,
        metadata: row.metadata ?? null,
      })
    );
    stepsCache.set(key, steps);
    return steps;
  } finally {
    await pool.end();
  }
}
