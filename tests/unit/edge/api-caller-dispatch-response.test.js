const path = require('path');
const { pathToFileURL } = require('url');

const gatewayModulePath = path.resolve(
  __dirname,
  '../../../supabase/functions/api-gateway/api-caller-response.mjs',
);
const webhookModulePath = path.resolve(
  __dirname,
  '../../../supabase/functions/webhook-receiver/api-caller-response.mjs',
);

let readApiCallerResult;
let assertApiCallerAccepted;

beforeAll(async () => {
  ({ readApiCallerResult } = await import(pathToFileURL(gatewayModulePath).href));
  ({ assertApiCallerAccepted } = await import(pathToFileURL(webhookModulePath).href));
});

const response = (status, body) => new Response(
  typeof body === 'string' ? body : JSON.stringify(body),
  { status, headers: { 'content-type': 'application/json' } },
);

describe('api-caller sibling response handling', () => {
  test('api-gateway accepts a valid 2xx result envelope', async () => {
    await expect(readApiCallerResult(response(200, {
      success: true,
      result: { status: 204, headers: { 'x-proof': 'ok' }, body: null },
    }))).resolves.toEqual({ status: 204, headers: { 'x-proof': 'ok' }, body: null });
  });

  test('api-gateway preserves a valid provider-mirror result from an outer 502', async () => {
    await expect(readApiCallerResult(response(502, {
      success: false,
      result: { status: 503, headers: { 'retry-after': '5' }, body: { error: 'unavailable' } },
    }))).resolves.toEqual({
      status: 503,
      headers: { 'retry-after': '5' },
      body: { error: 'unavailable' },
    });
  });

  test('api-gateway rejects a valid failure envelope for async dispatch', async () => {
    await expect(readApiCallerResult(response(502, {
      success: false,
      result: { status: 503, headers: {}, body: { error: 'unavailable' } },
    }), { requireSuccess: true })).rejects.toThrow('api_caller_dispatch_failed');
  });

  test.each([401, 500])('api-gateway rejects sanitized HTTP %s without a result', async (status) => {
    await expect(readApiCallerResult(response(status, { secret: 'must-not-leak' })))
      .rejects.toThrow(`api_caller_http_${status}`);
  });

  test('api-gateway rejects malformed 2xx bodies', async () => {
    await expect(readApiCallerResult(response(200, 'not-json')))
      .rejects.toThrow('api_caller_response_malformed');
  });

  test('webhook accepts a valid 2xx success envelope', async () => {
    await expect(assertApiCallerAccepted(response(200, { success: true }))).resolves.toBeUndefined();
  });

  test.each([401, 500])('webhook records sanitized HTTP %s failure', async (status) => {
    await expect(assertApiCallerAccepted(response(status, { secret: 'must-not-leak' })))
      .rejects.toThrow(`api_caller_http_${status}`);
  });

  test('webhook rejects malformed 2xx bodies', async () => {
    await expect(assertApiCallerAccepted(response(200, '{}')))
      .rejects.toThrow('api_caller_response_malformed');
  });
});
