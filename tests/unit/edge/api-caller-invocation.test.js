const path = require('path');
const { pathToFileURL } = require('url');

const modulePath = pathToFileURL(path.resolve(
  __dirname,
  '../../../supabase/functions/api-caller/invocation.mjs',
)).href;

describe('api-caller invocation authority', () => {
  let invocation;

  beforeAll(async () => {
    invocation = await import(modulePath);
  });

  test.each(['url', 'method', 'headers', 'body'])(
    'rejects caller override field %s',
    (field) => {
      expect(() => invocation.validateInvocationPayload({
        job_id: '4d1fbd36-6b6e-4c35-acc4-5e3ad9043830',
        [field]: field === 'headers' ? {} : 'override',
      })).toThrow(`${field} is server-resolved`);
    },
  );

  test('requires exactly one recognized operation shape', () => {
    expect(() => invocation.validateInvocationPayload({})).toThrow('exactly one');
    expect(() => invocation.validateInvocationPayload({
      job_id: '4d1fbd36-6b6e-4c35-acc4-5e3ad9043830',
      batch: 1,
    })).toThrow('exactly one');
    expect(() => invocation.validateInvocationPayload({ batch: 1, timeout_seconds: 5 }))
      .toThrow('timeout_seconds is not allowed for batch');
  });

  test('accepts bounded job and batch inputs', () => {
    expect(invocation.validateInvocationPayload({
      job_id: '4d1fbd36-6b6e-4c35-acc4-5e3ad9043830',
      timeout_seconds: 5,
    })).toEqual({
      operation: 'job',
      payload: {
        job_id: '4d1fbd36-6b6e-4c35-acc4-5e3ad9043830',
        timeout_seconds: 5,
      },
    });
    expect(invocation.validateInvocationPayload({ batch: 5, concurrency: 1 }))
      .toEqual({ operation: 'batch', payload: { batch: 5, concurrency: 1 } });
  });

  test('enforces runtime-safe batch and concurrency ceilings at the boundary', () => {
    expect(invocation.validateInvocationPayload({ batch: 10, concurrency: 1 }))
      .toEqual({ operation: 'batch', payload: { batch: 10, concurrency: 1 } });
    expect(() => invocation.validateInvocationPayload({ batch: 11, concurrency: 1 }))
      .toThrow('batch must be an integer between 1 and 10');
    expect(() => invocation.validateInvocationPayload({ batch: 10, concurrency: 2 }))
      .toThrow('concurrency must be an integer between 1 and 1');
  });

  test('compacts batch results without retaining provider bodies or headers', () => {
    const compact = invocation.compactBatchJobResult({
      job_id: '4d1fbd36-6b6e-4c35-acc4-5e3ad9043830',
      success: false,
      result: {
        status: 502,
        completed: false,
        latency_ms: 41,
        headers: { authorization: 'Bearer secret' },
        body: { payload: 'x'.repeat(20_000_000) },
        error: 'provider failed',
      },
    });

    expect(compact).toEqual({
      job_id: '4d1fbd36-6b6e-4c35-acc4-5e3ad9043830',
      success: false,
      status: 502,
      completed: false,
      latency_ms: 41,
      error: 'provider failed',
    });
    expect(compact).not.toHaveProperty('body');
    expect(compact).not.toHaveProperty('headers');
  });

  test('bounds error metadata and the aggregate serialized batch response', () => {
    const worstCaseBody = 'x'.repeat(20_000_000);
    const results = Array.from({ length: 10 }, (_, index) => ({
      job_id: `${String(index + 1).padStart(8, '0')}-1111-4111-8111-111111111111`,
      success: false,
      result: {
        status: 500,
        completed: false,
        latency_ms: index,
        error: '⚠'.repeat(10_000),
        headers: { secret: 'never-returned' },
        body: worstCaseBody,
      },
    }));

    const defaultResponse = invocation.buildCompactBatchResponse(results);
    expect(defaultResponse.summary).toEqual({ claimed: 10, returned: 10, omitted: 0 });
    expect(Buffer.byteLength(JSON.stringify(defaultResponse), 'utf8')).toBeLessThanOrEqual(
      invocation.MAX_BATCH_RESULT_BYTES,
    );

    const response = invocation.buildCompactBatchResponse(results, { maxBytes: 1_024 });
    expect(Buffer.byteLength(JSON.stringify(response), 'utf8')).toBeLessThanOrEqual(1_024);
    expect(response.summary).toEqual({
      claimed: 10,
      returned: response.jobs.length,
      omitted: 10 - response.jobs.length,
    });
    expect(response.summary.omitted).toBeGreaterThan(0);
    for (const result of response.jobs) {
      expect(Buffer.byteLength(result.error, 'utf8')).toBeLessThanOrEqual(
        invocation.MAX_BATCH_ERROR_BYTES,
      );
      expect(result).not.toHaveProperty('body');
      expect(result).not.toHaveProperty('headers');
    }
  });

  test('keeps the server spec immutable and only narrows timeout', () => {
    const spec = {
      url: 'https://provider.example/v1',
      method: 'POST',
      headers: { authorization: 'Bearer provider-secret' },
      body: { canonical: true },
      timeout_seconds: 30,
    };
    expect(invocation.mergeServerDispatch(spec, {
      url: 'https://attacker.example',
      method: 'DELETE',
      headers: { authorization: 'stolen' },
      body: { canonical: false },
      timeout_seconds: 5,
    })).toEqual({ ...spec, timeout_seconds: 5 });
    expect(invocation.mergeServerDispatch(spec, { timeout_seconds: 60 }).timeout_seconds).toBe(30);
  });
});
