// Pure preparation contract shared by the Edge and browser-server facades.
type JsonRecord = Record<string, unknown>;
type RpcClient = {
  rpc: (name: string, args?: JsonRecord) => PromiseLike<{ data: unknown; error: { message?: string } | null }>;
};

const record = (value: unknown): JsonRecord =>
  value && typeof value === "object" && !Array.isArray(value) ? value as JsonRecord : {};
const records = (value: unknown): JsonRecord[] =>
  Array.isArray(value) ? value.map(record) : [];
const text = (value: unknown) => typeof value === "string" ? value.trim() : "";
const token = (value: unknown) => text(value).toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "");
const positiveInteger = (value: unknown) => {
  const number = Number(value);
  return Number.isSafeInteger(number) && number > 0 ? number : null;
};

export class ImportPreparationError extends Error {
  constructor(public readonly status: number, public readonly code: string, message: string) {
    super(message);
  }
}

async function rpc(client: RpcClient, name: string, args?: JsonRecord) {
  const { data, error } = await client.rpc(name, args);
  if (error) throw new Error(error.message || `${name} failed`);
  return data;
}

export async function loadImportPreparation(client: RpcClient, resourceKey: string, scopeContext: JsonRecord) {
  const registry = record(await rpc(client, "ui_read_registry_v1"));
  const resource = records(registry.resources).find((entry) => entry.key === resourceKey);
  if (!resource || record(resource.import).enabled !== true) {
    throw new ImportPreparationError(422, "import_not_enabled", "Choose a registered resource with imports enabled.");
  }
  const scope = record(await rpc(client, "ui_resolve_import_scope_context_v1", {
    p_payload: { resource_key: resourceKey, scope_context: scopeContext },
  }));
  const normalizedScope = record(scope.scope_context);
  // This existing RPC checks the resource capability as well as the resolved tenant scope.
  const profiles = records(await rpc(client, "ui_tabular_import_profiles_v1", {
    p_resource: resourceKey,
    p_scope_context: normalizedScope,
  }));
  const policyResult = await rpc(client, "resolve_tabular_import_policy_v1", {
    p_context: {
      organization_id: scope.organization_id,
      client_id: scope.client_id,
      sender_id: scope.sender_id,
      resource_key: resourceKey,
    },
  });
  const policy = record(record(Array.isArray(policyResult) ? policyResult[0] : policyResult).value);
  const importConfig = record(resource.import);
  const maxFileBytes = positiveInteger(policy.max_file_size_bytes);
  const maxRows = positiveInteger(policy.max_rows);
  if (!maxFileBytes || !maxRows) {
    throw new ImportPreparationError(422, "invalid_import_policy", "Import policy must define positive byte and row limits.");
  }
  return {
    registry, resource, profiles,
    organizationId: text(scope.organization_id),
    scopeContext: normalizedScope,
    maxFileBytes: Math.min(maxFileBytes, positiveInteger(importConfig.max_file_bytes) ?? maxFileBytes),
    maxRows: Math.min(maxRows, positiveInteger(importConfig.max_rows) ?? maxRows),
  };
}

export function validateImportFile(file: { size: number }, maxBytes?: number) {
  if (file.size <= 0) {
    throw new ImportPreparationError(400, "empty_import_file", "The selected import file is empty. Add a header row and at least one data row.");
  }
  if (maxBytes !== undefined && file.size > maxBytes) {
    throw new ImportPreparationError(413, "import_file_too_large", `The selected import file exceeds the configured ${maxBytes} byte limit.`);
  }
}

// Use registered aliases and inline-node prefixes only; no guessed resource or target names.
function inferRegisteredRules(registry: JsonRecord, resource: JsonRecord, headers: string[]) {
  const rules: JsonRecord[] = [];
  const targets = new Set<string>();
  const columns = records(resource.columns);
  const addColumns = (entries: JsonRecord[], prefix = "", prefixes: string[] = []) => {
    for (const column of entries) {
      const config = record(column.import);
      if (config.enabled !== true || !text(column.key)) continue;
      const names = [column.key, column.label, ...(Array.isArray(config.aliases) ? config.aliases : [])].map(token).filter(Boolean);
      const candidates = prefix
        ? prefixes.flatMap((entry) => names.map((name) => token(`${entry}_${name}`)))
        : names;
      const header = headers.find((entry) => candidates.includes(token(entry)));
      const target = `${prefix}${text(column.key)}`;
      if (!header || targets.has(target)) continue;
      targets.add(target);
      rules.push({ source_column: header, target_field: target, enabled: true });
    }
  };
  addColumns(columns);
  for (const column of columns) {
    const reference = record(record(column.import).reference);
    if (reference.allow_inline_node !== true) continue;
    const related = records(registry.resources).find((entry) => entry.key === reference.resource);
    const node = text(reference.inline_node_key) || text(column.key).replace(/_id$/i, "");
    if (!related || !node) continue;
    const prefixes = Array.isArray(reference.mapping_prefixes) ? reference.mapping_prefixes.map(text).filter(Boolean) : [node];
    addColumns(records(related.columns), `${node}.`, prefixes);
  }
  return rules;
}

export function validateImportWorkbook(
  preparation: Awaited<ReturnType<typeof loadImportPreparation>>,
  workbook: { headers: string[]; rows: unknown[] },
  fingerprint: string,
  rules: unknown[],
  ruleSource: string,
) {
  if (!workbook.headers.some((header) => header.trim())) {
    throw new ImportPreparationError(422, "no_readable_column_headers", "No readable column headers were found. Add a header row before preparing the import.");
  }
  if (workbook.rows.length === 0) {
    throw new ImportPreparationError(422, "empty_import_rows", "The selected file contains no data rows. Add at least one data row before preparing it.");
  }
  if (workbook.rows.length > preparation.maxRows) {
    throw new ImportPreparationError(413, "import_row_limit_exceeded", `The selected import file exceeds the configured ${preparation.maxRows} row limit.`);
  }
  const inferredRules = rules.length ? rules : inferRegisteredRules(preparation.registry, preparation.resource, workbook.headers);
  const matchingProfile = preparation.profiles.some((profile) =>
    profile.header_fingerprint === fingerprint && records(record(profile.mapping_config).field_rules).length > 0,
  );
  if (inferredRules.length === 0 && (ruleSource === "manual" || !matchingProfile)) {
    throw new ImportPreparationError(422, "unmapped_import_headers", "No import columns matched this file. Check its headers or select a registered mapping profile.");
  }
  return inferredRules;
}

export async function processStartedImport(userClient: RpcClient, serviceClient: RpcClient, runId: string, batchSize: unknown) {
  let processingWarning: string | null = null;
  try {
    await rpc(serviceClient, "process_tabular_import_run_v1", {
      p_run_id: runId,
      p_batch_size: Math.min(positiveInteger(batchSize) ?? 100, 1000),
    });
  } catch {
    // Starting already committed. Keep the durable task visible for the existing worker.
    processingWarning = "The initial processing attempt did not finish. The durable import task remains tracked below.";
  }
  const run = record(await rpc(userClient, "ui_get_tabular_import_run_v1", { p_run_id: runId }));
  if (run.id !== runId || !text(run.status)) throw new Error("The started import could not be confirmed.");
  return { run, processingWarning: ["queued", "processing"].includes(text(run.status)) ? processingWarning : null };
}
