import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const repoRoot = path.resolve(__dirname, '../../../../..');
const resourceImportSource = readFileSync(path.join(repoRoot, 'supabase/functions/resource-import-studio/index.ts'), 'utf8').replace(/\r\n/g, '\n');
const preparationSource = readFileSync(path.join(repoRoot, 'supabase/functions/resource-import-studio/preparation.ts'), 'utf8');
const importStudioSource = readFileSync(path.join(repoRoot, 'apps/console-v2/src/modules/platform/imports.tsx'), 'utf8');

describe('resource-import-studio edge contract', () => {
  it('keeps the Docker internal Supabase URL for in-container import RPC and storage calls', () => {
    expect(resourceImportSource).toContain('const LOCAL_EDGE_SUPABASE_HOSTS = new Set(["kong", "rvzwwjlztwwisjthghnipgjr.example.invalid"]);');
    expect(resourceImportSource).toContain(String.raw`if (
      /^(127\.0\.0\.1|localhost)$/i.test(requestUrl.hostname) &&
      LOCAL_EDGE_SUPABASE_HOSTS.has(configured.hostname.toLowerCase())
    ) {
      return requestUrl.origin;
    }
    return configured.origin;`);
  });

  it('fails unmapped file headers before upload or DB prepare unless a profile matches', () => {
    expect(preparationSource).toContain('export async function loadImportPreparation(client: RpcClient, resourceKey: string, scopeContext: JsonRecord)');
    expect(preparationSource).toContain('const profiles = records(await rpc(client, "ui_tabular_import_profiles_v1", {');
    expect(preparationSource).toContain('p_resource: resourceKey');
    expect(preparationSource).toContain('profile.header_fingerprint === fingerprint && records(record(profile.mapping_config).field_rules).length > 0,');
    expect(preparationSource).not.toContain('p_resource_key: resourceKey');
    expect(preparationSource).toContain('throw new ImportPreparationError(422, "unmapped_import_headers",');
    expect(preparationSource).toContain('No import columns matched this file');

    expect(preparationSource).toContain('if (inferredRules.length === 0 && (ruleSource === "manual" || !matchingProfile)) {');
    const failFastIndex = resourceImportSource.indexOf('const resolvedRules = validateImportWorkbook(preparation, workbook, headerFingerprint, rules, ruleSource);');
    const uploadIndex = resourceImportSource.indexOf('const uploaded = await uploadSourceArtifact');
    const prepareRpcIndex = resourceImportSource.indexOf('userClient.rpc("tabular_import_prepare_v1"');

    expect(failFastIndex).toBeGreaterThan(0);
    expect(uploadIndex).toBeGreaterThan(failFastIndex);
    expect(prepareRpcIndex).toBeGreaterThan(failFastIndex);
  });

  it('infers row-driven fixed defaults before prepare when lookup-backed required fields are not in the file', () => {
    expect(importStudioSource).toContain('function importDefaultValue(column: ImportRegistryColumn): unknown {');
    expect(importStudioSource).toContain('return config.default_value;');
    expect(importStudioSource).toContain("value_mode: 'fixed',");
    expect(importStudioSource).toContain('fixed_value: fixedValue,');
    expect(importStudioSource).toContain('addDefaultRule(`${nodeKey}.${key}`, importDefaultValue(column));');
    expect(importStudioSource).toContain('...(inferredRules.length > 0 ? { rules: inferredRules } : {}),');
    expect(resourceImportSource).toContain('rules: resolvedRules,');
  });

  it('fails empty or headerless files before artifact upload or DB prepare', () => {
    expect(preparationSource).toContain('throw new ImportPreparationError(400, "empty_import_file",');
    expect(preparationSource).toContain('throw new ImportPreparationError(422, "no_readable_column_headers",');
    const emptyGuardIndex = resourceImportSource.indexOf('validateImportFile(file);');
    const headerGuardIndex = resourceImportSource.indexOf('const resolvedRules = validateImportWorkbook(');
    const uploadIndex = resourceImportSource.indexOf('uploadSourceArtifact({');
    const prepareRpcIndex = resourceImportSource.indexOf('tabular_import_prepare_v1');

    expect(emptyGuardIndex).toBeGreaterThan(0);
    expect(headerGuardIndex).toBeGreaterThan(emptyGuardIndex);
    expect(uploadIndex).toBeGreaterThan(headerGuardIndex);
    expect(prepareRpcIndex).toBeGreaterThan(headerGuardIndex);
  });

  it('enforces row-driven file and row limits before artifact upload or DB prepare', () => {
    expect(preparationSource).toContain('const policyResult = await rpc(client, "resolve_tabular_import_policy_v1", {');
    expect(preparationSource).toContain('maxFileBytes: Math.min(maxFileBytes, positiveInteger(importConfig.max_file_bytes) ?? maxFileBytes),');
    expect(preparationSource).toContain('maxRows: Math.min(maxRows, positiveInteger(importConfig.max_rows) ?? maxRows),');
    expect(preparationSource).toContain('throw new ImportPreparationError(413, "import_file_too_large",');
    expect(preparationSource).toContain('throw new ImportPreparationError(413, "import_row_limit_exceeded",');

    const fileLimitIndex = resourceImportSource.indexOf('validateImportFile(file, preparation.maxFileBytes);');
    const rowLimitIndex = resourceImportSource.indexOf('const resolvedRules = validateImportWorkbook(');
    const uploadIndex = resourceImportSource.indexOf('uploadSourceArtifact({');
    const prepareRpcIndex = resourceImportSource.indexOf('tabular_import_prepare_v1');

    expect(fileLimitIndex).toBeGreaterThan(0);
    expect(rowLimitIndex).toBeGreaterThan(fileLimitIndex);
    expect(uploadIndex).toBeGreaterThan(rowLimitIndex);
    expect(prepareRpcIndex).toBeGreaterThan(rowLimitIndex);
  });

  it('processes a started run through the canonical backend processor before returning readback', () => {
    expect(resourceImportSource).toContain('ui_start_tabular_import_run_v1');
    expect(preparationSource).toContain('await rpc(serviceClient, "process_tabular_import_run_v1", {');
    expect(resourceImportSource).toContain('RESOURCE_IMPORT_START_PROCESS_BATCH_SIZE');
    expect(preparationSource).toContain('p_batch_size: Math.min(positiveInteger(batchSize) ?? 100, 1000),');

    const startIndex = resourceImportSource.indexOf('userClient.rpc("ui_start_tabular_import_run_v1"');
    const processIndex = resourceImportSource.indexOf('const processed = await processStartedImport(', startIndex);
    const readbackIndex = resourceImportSource.indexOf('const run = await hydrateArtifacts(serviceClient, processed.run);', processIndex);
    const processorRpcIndex = preparationSource.indexOf('await rpc(serviceClient, "process_tabular_import_run_v1", {');
    expect(preparationSource.indexOf('await rpc(userClient, "ui_get_tabular_import_run_v1",', processorRpcIndex)).toBeGreaterThan(processorRpcIndex);

    expect(startIndex).toBeGreaterThan(0);
    expect(processIndex).toBeGreaterThan(startIndex);
    expect(readbackIndex).toBeGreaterThan(processIndex);
  });

  it('fails closed on unsupported retry or reopen actions instead of exposing hidden lifecycle paths', () => {
    expect(resourceImportSource).toContain('type ResourceImportAction = "prepare" | "start" | "get_run" | "cancel"');
    expect(resourceImportSource).toContain('Expected one of prepare, start, get_run, or cancel.');
    expect(resourceImportSource).not.toContain('ui_retry_tabular_import_run_v1');
    expect(resourceImportSource).not.toContain('ui_reopen_tabular_import_run_v1');
    expect(resourceImportSource).not.toContain('action === "retry"');
    expect(resourceImportSource).not.toContain('action === "reopen"');
  });
});
