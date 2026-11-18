// plugin-studio-adapters.test.ts — covers the data-source adapters that wire
// the `integration-plugin-studio` edge function (parse|infer|preview|save) to
// the FE through `getSupabaseClient()?.functions.invoke(...)`.
//
// CLAIM-INTEGRATIONS-WORKFLOWS-WIRING (Wave 12 W12-2 — INTEGRATIONS P0 #3 closure).
//
// The tests stub `@supabase/supabase-js` so we can assert the canonical wire
// shape (function name + body shape) without a network round-trip:
//   - the function name is `integration-plugin-studio/<stage>`
//   - the body includes both the path-derived stage (URL) AND `action: <stage>`
//     so the edge fn `resolveEndpoint` accepts either form
//   - errors from the edge fn surface through Error.message

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const invokeSpy = vi.fn();
const rpcSpy = vi.fn();

vi.mock('@supabase/supabase-js', () => ({
  createClient: vi.fn(() => ({
    rpc: rpcSpy,
    from: vi.fn(),
    auth: { getSession: vi.fn() },
    functions: { invoke: invokeSpy },
  })),
}));

import { __resetSupabaseClientForTests } from '../supabase';

async function importDataSource() {
  // Re-import after env stubs so getSupabaseClient picks up the values.
  return await import('../data-source');
}

describe('data-source plugin-studio adapters (W12-2)', () => {
  beforeEach(() => {
    __resetSupabaseClientForTests();
    invokeSpy.mockReset();
    rpcSpy.mockReset();
    vi.stubEnv('VITE_SUPABASE_URL', 'https://example.supabase.co');
    vi.stubEnv('VITE_SUPABASE_ANON_KEY', 'anon-test');
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    __resetSupabaseClientForTests();
  });

  it('plugin_studio_parse_v1 invokes integration-plugin-studio/parse with action=parse', async () => {
    invokeSpy.mockResolvedValue({
      data: {
        ok: true,
        endpoint: 'parse',
        normalized_contract: { source_type: 'curl', plugin_kind: 'api' },
        mapping_suggestion: { version: 1, fields: [] },
        draft: null,
        correlation_id: 'corr_p',
      },
      error: null,
    });
    const ds = await importDataSource();
    const res = await ds.plugin_studio_parse_v1({
      source_type: 'curl',
      source_payload: { curl: 'curl https://api.example.com/v1/orders' },
      plugin_kind: 'api',
    });
    expect(invokeSpy).toHaveBeenCalledTimes(1);
    const [name, opts] = invokeSpy.mock.calls[0]!;
    expect(name).toBe('integration-plugin-studio/parse');
    expect((opts as { body: { action?: string; source_type?: string } }).body.action).toBe('parse');
    expect((opts as { body: { source_type?: string } }).body.source_type).toBe('curl');
    expect(res.endpoint).toBe('parse');
    expect(res.normalized_contract.plugin_kind).toBe('api');
  });

  it('plugin_studio_infer_v1 invokes integration-plugin-studio/infer with action=infer', async () => {
    invokeSpy.mockResolvedValue({
      data: {
        ok: true,
        endpoint: 'infer',
        mapping_suggestion: { version: 1, fields: [{ target_field: 'external_id' }] },
        outbound_suggestions: [{ operation_name: 'forward_event' }],
        normalized_contract: { source_type: 'curl', plugin_kind: 'api' },
        draft: null,
        correlation_id: 'corr_i',
      },
      error: null,
    });
    const ds = await importDataSource();
    const res = await ds.plugin_studio_infer_v1({
      source_type: 'curl',
      source_payload: {},
      normalized_contract: { source_type: 'curl', plugin_kind: 'api' },
    });
    const [name, opts] = invokeSpy.mock.calls[0]!;
    expect(name).toBe('integration-plugin-studio/infer');
    expect((opts as { body: { action?: string } }).body.action).toBe('infer');
    expect(res.outbound_suggestions[0]!.operation_name).toBe('forward_event');
  });

  it('plugin_studio_preview_v1 invokes integration-plugin-studio/preview with artifact in body', async () => {
    invokeSpy.mockResolvedValue({
      data: {
        ok: true,
        endpoint: 'preview',
        artifact: 'integration_plugin',
        normalized_contract: { source_type: 'curl', plugin_kind: 'api' },
        mapping_suggestion: { version: 1, fields: [] },
        review: {
          mapping_config: {},
          coerced_preview: {},
          coercions: [],
          diagnostics: [],
          review_summary: {
            blocking_count: 0,
            warning_count: 0,
            coercion_count: 0,
            next_steps: [],
            egress_policy_resolution_id: null,
          },
        },
        save_modes: { direct_allowed: false, draft_allowed: true, recommended: 'draft' },
        correlation_id: 'corr_pv',
      },
      error: null,
    });
    const ds = await importDataSource();
    const res = await ds.plugin_studio_preview_v1({
      artifact: 'integration_plugin',
      mapping_config: { version: 1, fields: [] },
      normalized_contract: { source_type: 'curl', plugin_kind: 'api' },
      outbound_operations: [
        { operation_name: 'forward_event', method: 'POST', url_template: 'https://provider.nzxmhryhtqlzoshjkyozkpup.example.invalid/v1/orders' },
      ],
    });
    const [name, opts] = invokeSpy.mock.calls[0]!;
    expect(name).toBe('integration-plugin-studio/preview');
    const body = (opts as {
      body: {
        action?: string;
        artifact?: string;
        outbound_operations?: Array<Record<string, unknown>>;
      };
    }).body;
    expect(body.action).toBe('preview');
    expect(body.artifact).toBe('integration_plugin');
    expect(body.outbound_operations?.[0]?.url_template).toBe('https://provider.nzxmhryhtqlzoshjkyozkpup.example.invalid/v1/orders');
    expect(res.save_modes.recommended).toBe('draft');
  });

  it('plugin_studio_save_v1 invokes integration-plugin-studio/save with save_mode in body', async () => {
    invokeSpy.mockResolvedValue({
      data: {
        ok: true,
        endpoint: 'save',
        artifact: 'integration_plugin',
        save_mode: 'draft',
        normalized_contract: { source_type: 'curl', plugin_kind: 'api' },
        review: {
          mapping_config: {},
          coerced_preview: {},
          coercions: [],
          diagnostics: [],
          review_summary: {
            blocking_count: 0,
            warning_count: 0,
            coercion_count: 0,
            next_steps: [],
            egress_policy_resolution_id: null,
          },
        },
        result: { primary_resource_type: 'integration_plugin', plugin_version_id: 'pv_x' },
        report: { report_id: 'rep_x', status: 'succeeded' },
        correlation_id: 'corr_save',
      },
      error: null,
    });
    rpcSpy
      .mockResolvedValueOnce({
        data: { id: 'pv_x', status: 'draft' },
        error: null,
      })
      .mockResolvedValueOnce({
        data: { id: 'rep_x', status: 'succeeded' },
        error: null,
      });
    const ds = await importDataSource();
    const res = await ds.plugin_studio_save_v1({
      artifact: 'integration_plugin',
      save_mode: 'draft',
      mapping_config: { version: 1, fields: [] },
      normalized_contract: { source_type: 'curl', plugin_kind: 'api' },
      outbound_operations: [
        { operation_name: 'forward_event', method: 'POST', url_template: 'https://provider.nzxmhryhtqlzoshjkyozkpup.example.invalid/v1/orders' },
      ],
    });
    const [name, opts] = invokeSpy.mock.calls[0]!;
    expect(name).toBe('integration-plugin-studio/save');
    const body = (opts as {
      body: {
        save_mode?: string;
        action?: string;
        outbound_operations?: Array<Record<string, unknown>>;
      };
    }).body;
    expect(body.action).toBe('save');
    expect(body.save_mode).toBe('draft');
    expect(body.outbound_operations?.[0]?.url_template).toBe('https://provider.nzxmhryhtqlzoshjkyozkpup.example.invalid/v1/orders');
    expect(rpcSpy).toHaveBeenCalledWith('ui_get_resource_v1', {
      p_resource: 'integration_plugin_versions',
      p_id: 'pv_x',
    });
    expect(rpcSpy).toHaveBeenCalledWith('ui_get_resource_v1', {
      p_resource: 'mapping_operation_reports',
      p_id: 'rep_x',
    });
    expect(res.save_mode).toBe('draft');
    expect((res.result as { plugin_version_id?: string }).plugin_version_id).toBe('pv_x');
  });

  it('surfaces edge fn errors through Error.message (fail-closed)', async () => {
    invokeSpy.mockResolvedValue({
      data: null,
      error: { message: 'edge.integration_plugin_studio.failed: Capability denied' },
    });
    const ds = await importDataSource();
    await expect(
      ds.plugin_studio_parse_v1({
        source_type: 'curl',
        source_payload: {},
        plugin_kind: 'api',
      }),
    ).rejects.toThrow(/Capability denied/);
  });

  it('fails closed when a live studio stage returns no edge evidence', async () => {
    invokeSpy.mockResolvedValue({
      data: {
        ok: true,
        endpoint: 'parse',
        normalized_contract: { source_type: 'curl', plugin_kind: 'api' },
        mapping_suggestion: { version: 1, fields: [] },
        draft: null,
      },
      error: null,
    });
    const ds = await importDataSource();
    await expect(
      ds.plugin_studio_parse_v1({
        source_type: 'curl',
        source_payload: {},
        plugin_kind: 'api',
      }),
    ).rejects.toThrow('integration-plugin-studio/parse did not return backend edge evidence');
  });

  it('fails closed when live studio save returns no persisted save evidence', async () => {
    invokeSpy.mockResolvedValue({
      data: {
        ok: true,
        endpoint: 'save',
        artifact: 'integration_plugin',
        save_mode: 'draft',
        normalized_contract: { source_type: 'curl', plugin_kind: 'api' },
        review: {
          mapping_config: {},
          coerced_preview: {},
          coercions: [],
          diagnostics: [],
          review_summary: {
            blocking_count: 0,
            warning_count: 0,
            coercion_count: 0,
            next_steps: [],
            egress_policy_resolution_id: null,
          },
        },
        result: null,
        report: null,
        correlation_id: 'corr_save_no_result',
      },
      error: null,
    });
    const ds = await importDataSource();
    await expect(
      ds.plugin_studio_save_v1({
        artifact: 'integration_plugin',
        save_mode: 'draft',
        mapping_config: { version: 1, fields: [] },
      }),
    ).rejects.toThrow('integration-plugin-studio/save did not return backend save evidence');
  });

  it('extracts structured error envelope from FunctionsHttpError context.json (preferred message)', async () => {
    // Simulate Supabase JS wrapping a non-2xx into FunctionsHttpError with the
    // edge fn JSON body available via `error.context.json()`.
    const mockResponse = {
      json: vi.fn().mockResolvedValue({
        ok: false,
        error: { code: 'mapping_studio.review.blocked', message: 'Submit blocked by review diagnostics.' },
      }),
    };
    invokeSpy.mockResolvedValue({
      data: null,
      error: Object.assign(new Error('FunctionsHttpError: Edge Function returned a non-2xx status code'), {
        context: mockResponse,
      }),
    });
    const ds = await importDataSource();
    await expect(
      ds.plugin_studio_save_v1({
        artifact: 'integration_plugin',
        save_mode: 'draft',
        mapping_config: { version: 1, fields: [] },
      }),
    ).rejects.toThrow(/Submit blocked by review diagnostics/);
    expect(mockResponse.json).toHaveBeenCalled();
  });
});
