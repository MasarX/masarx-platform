const fs = jest.requireActual('node:fs');
const path = jest.requireActual('node:path');
const vm = jest.requireActual('node:vm');
const ts = jest.requireActual('typescript');

const source = fs.readFileSync(path.resolve(__dirname, '../../../supabase/functions/label-renderer/index.ts'), 'utf8');
const failureHelpers = source.slice(source.indexOf('const logRenderer ='), source.indexOf('interface LeaseRequest'));
const helpers = source.slice(source.indexOf('const normalizeString ='), source.indexOf('type BundleReturnMode ='));
const handler = source.slice(source.indexOf('const handlePrintRequest ='), source.indexOf('const handleBundleRequest ='));
const compiled = ts.transpileModule(`${failureHelpers}\n${helpers}\n${handler}\nmodule.exports = handlePrintRequest;`, {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
}).outputText;

let classifyError;
let rendererError;

beforeAll(async () => {
  ({ classifyError } = await import('../../../supabase/functions/_shared/mod.mjs'));
  ({ rendererError } = await import('../../../supabase/functions/label-renderer/error-response.mjs'));
});

function renderer(fresh, reused = false) {
  const callRendererRpc = jest.fn(async (_client, name) => ({
    data: name.includes('target') ? 'job-1' : {
      job_ids: ['job-1'], inserted_count: reused ? 0 : 1, reused_count: reused ? 1 : 0,
    },
    error: null,
  }));
  const schedulePrintWorkflowResult = jest.fn();
  const handlerModule = { exports: {} };
  vm.runInNewContext(compiled, {
    module: handlerModule, exports: handlerModule.exports, Error,
    classifyError, rendererError, logStructured: jest.fn(),
    normalizeLabelTargetType: (value) => value,
    defaultLabelTypeForTargetType: () => 'route',
    resolveWorkflowProgress: (input) => input.workflow_run_step_id
      ? { workflowRunStepId: input.workflow_run_step_id } : null,
    resolveLabelPrintPolicy: async () => ({
      default_expires_seconds: 900, fresh_generation_required: fresh,
      print_sync_bundle_strategy: 'direct',
    }),
    resolveEdgeDbMode: () => 'rest',
    resolveBundleReturnMode: () => 'file_path_only',
    ensureSupabase: () => ({}),
    callRendererRpc, schedulePrintWorkflowResult,
    // Stop at the unchanged rendering boundary: these tests prove enqueue, not PDF generation.
    assertLabelBucketAvailable: async () => { throw new Error('test_stop_after_enqueue'); },
  });
  return { print: handlerModule.exports, callRendererRpc, schedulePrintWorkflowResult };
}

const paths = [
  ['target', false, 'request_label_generation_target_v1'],
  ['target', true, 'request_label_generation_target_for_step_v1'],
  ['bulk', false, 'request_label_generation_bulk_compact_v1'],
  ['bulk', true, 'request_label_generation_bulk_compact_for_step_v1'],
];

function request(kind, step, purpose) {
  return {
    organization_id: 'org-1', job_purpose: purpose,
    ...(step ? { workflow_run_step_id: 'step-1' } : {}),
    ...(kind === 'target' ? { targets: [{ target_type: 'route', target_id: 'route-1' }] }
      : { shipments: [{ shipment_id: 'shipment-1', box_ids: ['box-1'] }] }),
  };
}

describe.each(paths)('label purpose %s step=%s (%s)', (kind, step, rpc) => {
  test.each(['primary', 'reprint', 'manual'].flatMap((purpose) =>
    [false, true].flatMap((fresh) => [false, true].map((reused) => [purpose, fresh, reused]))
  ))('resolves explicit %s when freshness=%s and reused=%s', async (purpose, fresh, reused) => {
    const value = renderer(fresh, reused);
    const effectivePurpose = fresh && purpose === 'primary' ? 'reprint' : purpose;
    const result = await value.print(request(kind, step, purpose), 'correlation-1', {});
    expect(value.callRendererRpc).toHaveBeenCalledTimes(1);
    expect(value.callRendererRpc).toHaveBeenCalledWith(expect.anything(), rpc, expect.objectContaining({
      p_job_purpose: effectivePurpose, p_requested_source: 'label_print_sync:correlation-1',
      ...(step ? { p_workflow_run_step_id: 'step-1' } : {}),
    }), 'rest');
    expect(result.statusCode).toBe(503);
    expect(result.body.error).toBe('label_bucket_unavailable');
    expect(result.body.error_class).toBe('unknown');
    expect(result.body.steps.find((entry) => entry.step === 'render_label_jobs')).toMatchObject({
      ok: false, error: 'label_bucket_unavailable', error_class: 'unknown',
    });
    expect(JSON.stringify(result.body)).not.toContain('test_stop_after_enqueue');
    expect(result.body.job_purpose).toBe(effectivePurpose);
    expect(result.body.steps.find((entry) => entry.step === 'enqueue_label_jobs')).toMatchObject({
      job_purpose: effectivePurpose, fresh_generation_required: fresh,
      ...(kind === 'bulk' ? { inserted_count: reused ? 0 : 1, reused_count: reused ? 1 : 0 } : {}),
    });
    expect(value.schedulePrintWorkflowResult).toHaveBeenCalledWith(expect.anything(), result.body);
  });

  test('fresh-generation policy cannot be bypassed by explicit primary input', async () => {
    for (const purpose of ['primary', ' Primary ', 'PRIMARY']) {
      const value = renderer(true, true);
      const result = await value.print({ print: request(kind, step, purpose) }, 'correlation-1', {});
      expect(value.callRendererRpc).toHaveBeenCalledTimes(1);
      expect(value.callRendererRpc.mock.calls[0][2].p_job_purpose).toBe('reprint');
      expect(value.callRendererRpc).not.toHaveBeenCalledWith(expect.anything(), rpc,
        expect.objectContaining({ p_job_purpose: 'primary' }), expect.anything());
      expect(result.body.job_purpose).toBe('reprint');
      expect(result.body.steps.find((entry) => entry.step === 'enqueue_label_jobs')).toMatchObject({
        job_purpose: 'reprint', fresh_generation_required: true,
      });
      expect(value.schedulePrintWorkflowResult).toHaveBeenCalledWith(expect.anything(), result.body);
    }
  });

  test.each([false, true])('absent/invalid purpose keeps freshness=%s fallback', async (fresh) => {
    for (const purpose of [undefined, null, '', '  ', 'unsupported', 7, {}, ['manual']]) {
      const value = renderer(fresh);
      const result = await value.print(request(kind, step, purpose), 'correlation-1', {});
      expect(value.callRendererRpc.mock.calls[0][2].p_job_purpose).toBe(fresh ? 'reprint' : 'primary');
      expect(result.body.job_purpose).toBe(fresh ? 'reprint' : 'primary');
    }
  });
});

test('nested print input normalizes an explicit purpose once', async () => {
  const value = renderer(true);
  const result = await value.print({ organization_id: 'org-1', print: request('bulk', false, ' Manual ') }, 'correlation-1', {});
  expect(value.callRendererRpc.mock.calls[0][2].p_job_purpose).toBe('manual');
  expect(result.body.job_purpose).toBe('manual');
});

test('purpose support does not bypass print authorization', async () => {
  const value = renderer(false);
  const result = await value.print(request('bulk', false, 'manual'), 'correlation-1', null);
  expect(result.statusCode).toBe(401);
  expect(value.callRendererRpc).not.toHaveBeenCalled();
});
