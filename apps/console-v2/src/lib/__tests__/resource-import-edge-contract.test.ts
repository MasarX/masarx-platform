import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const repoRoot = path.resolve(__dirname, '../../../../..');
const resourceImportSource = readFileSync(path.join(repoRoot, 'supabase/functions/resource-import-studio/index.ts'), 'utf8');

describe('resource-import-studio edge contract', () => {
  it('keeps the Docker internal Supabase URL for in-container import RPC and storage calls', () => {
    expect(resourceImportSource).toContain('const LOCAL_EDGE_SUPABASE_HOSTS = new Set(["kong"]);');
    expect(resourceImportSource).not.toContain('new Set(["kong", "rvzwwjlztwwisjthghnipgjr.example.invalid"])');
  });

  it('fails unmapped file headers before upload or DB prepare unless a profile matches', () => {
    expect(resourceImportSource).toContain('loadMatchingImportProfile');
    expect(resourceImportSource).toContain('ui_match_tabular_import_profile_v1');
    expect(resourceImportSource).toContain('p_resource: resourceKey');
    expect(resourceImportSource).toContain('p_header_fingerprint: headerFingerprint');
    expect(resourceImportSource).not.toContain('p_resource_key: resourceKey');
    expect(resourceImportSource).toContain('unmapped_import_headers');
    expect(resourceImportSource).toContain('No import columns matched this file');

    const failFastIndex = resourceImportSource.indexOf('unmapped_import_headers');
    const uploadIndex = resourceImportSource.indexOf('const uploaded = await uploadSourceArtifact');
    const prepareRpcIndex = resourceImportSource.indexOf('userClient.rpc("tabular_import_prepare_v1"');

    expect(failFastIndex).toBeGreaterThan(0);
    expect(uploadIndex).toBeGreaterThan(failFastIndex);
    expect(prepareRpcIndex).toBeGreaterThan(failFastIndex);
  });

  it('infers row-driven fixed defaults before prepare when lookup-backed required fields are not in the file', () => {
    expect(resourceImportSource).toContain('columnDefaultValue');
    expect(resourceImportSource).toContain('default_value');
    expect(resourceImportSource).toContain('value_mode: "fixed"');
    expect(resourceImportSource).toContain('fixed_value: fixedValue');
    expect(resourceImportSource).toContain('addDefaultRule(`${nodeKey}.${key}`, columnDefaultValue(column))');
  });

  it('fails empty or headerless files before artifact upload or DB prepare', () => {
    const emptyGuardIndex = resourceImportSource.indexOf('"empty_import_file"');
    const headerGuardIndex = resourceImportSource.indexOf('"no_readable_column_headers"');
    const uploadIndex = resourceImportSource.indexOf('uploadSourceArtifact({');
    const prepareRpcIndex = resourceImportSource.indexOf('tabular_import_prepare_v1');

    expect(emptyGuardIndex).toBeGreaterThan(0);
    expect(headerGuardIndex).toBeGreaterThan(emptyGuardIndex);
    expect(uploadIndex).toBeGreaterThan(headerGuardIndex);
    expect(prepareRpcIndex).toBeGreaterThan(headerGuardIndex);
  });

  it('enforces row-driven file and row limits before artifact upload or DB prepare', () => {
    expect(resourceImportSource).toContain('importPolicyLimit');
    expect(resourceImportSource).toContain('"max_file_bytes"');
    expect(resourceImportSource).toContain('"max_rows"');
    expect(resourceImportSource).toContain('"import_file_too_large"');
    expect(resourceImportSource).toContain('"import_row_limit_exceeded"');

    const fileLimitIndex = resourceImportSource.indexOf('"import_file_too_large"');
    const rowLimitIndex = resourceImportSource.indexOf('"import_row_limit_exceeded"');
    const uploadIndex = resourceImportSource.indexOf('uploadSourceArtifact({');
    const prepareRpcIndex = resourceImportSource.indexOf('tabular_import_prepare_v1');

    expect(fileLimitIndex).toBeGreaterThan(0);
    expect(rowLimitIndex).toBeGreaterThan(fileLimitIndex);
    expect(uploadIndex).toBeGreaterThan(rowLimitIndex);
    expect(prepareRpcIndex).toBeGreaterThan(rowLimitIndex);
  });

  it('processes a started run through the canonical backend processor before returning readback', () => {
    expect(resourceImportSource).toContain('ui_start_tabular_import_run_v1');
    expect(resourceImportSource).toContain('process_tabular_import_run_v1');
    expect(resourceImportSource).toContain('RESOURCE_IMPORT_START_PROCESS_BATCH_SIZE');
    expect(resourceImportSource).toContain('p_batch_size: processBatchSize');

    const startIndex = resourceImportSource.indexOf('userClient.rpc("ui_start_tabular_import_run_v1"');
    const processIndex = resourceImportSource.indexOf('"process_tabular_import_run_v1"', startIndex);
    const readbackIndex = resourceImportSource.indexOf(
      'const run = await hydrateArtifacts(serviceClient, asRecord(processedData)',
      processIndex,
    );

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
