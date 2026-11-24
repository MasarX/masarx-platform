const { randomBytes } = require('node:crypto');
const { createEdgeDbJwt } = require('../../../scripts/ops/workspace/edge-db-jwt');

const path = '/functions/v1/label-renderer';
const publicEndpoint = ['https://renderer', 'example', 'test'].join('.') + path;
const localEndpoint = ['http:', '', ['127', '0', '0', '1'].join('.') + ':54321'].join('/') + path;
const gatewayJwt = createEdgeDbJwt({ secret: randomBytes(32), role: 'edge_renderer_gateway_role' });
const signingKey = randomBytes(32).toString('hex');
let authorizeRendererSend;
let executeBoundedEgress;

beforeAll(async () => {
  ({ authorizeRendererSend } = await import('../../../supabase/functions/api-caller/renderer-auth.mjs'));
  ({ executeBoundedEgress } = await import('../../../supabase/functions/api-caller/egress.mjs'));
});

test('authorizes public renderer requests only to the exact configured HTTPS endpoint', async () => {
  await expect(authorizeRendererSend({ url: publicEndpoint }, publicEndpoint, signingKey, gatewayJwt))
    .resolves.toMatchObject({ url: publicEndpoint });
  await expect(authorizeRendererSend({ url: `${publicEndpoint}/other` }, publicEndpoint, signingKey, gatewayJwt))
    .rejects.toThrow('renderer_endpoint_not_authorized');
});

test('requires local deployment authorization before signing for an internal HTTP renderer', async () => {
  const dispatch = { url: localEndpoint };
  await expect(authorizeRendererSend(dispatch, localEndpoint, signingKey, gatewayJwt))
    .rejects.toThrow('renderer_endpoint_not_authorized');
  await expect(authorizeRendererSend(dispatch, localEndpoint, signingKey, gatewayJwt, true))
    .resolves.toMatchObject({ url: localEndpoint });
  await expect(authorizeRendererSend({ url: `${localEndpoint}?` }, localEndpoint, signingKey, gatewayJwt, true))
    .rejects.toThrow('renderer_endpoint_not_authorized');
});

test('direct local renderer transport sends once to its pinned endpoint and declines redirects', async () => {
  const directFetch = jest.fn(async () => new Response(null, {
    status: 307, headers: { location: publicEndpoint },
  }));
  const resolveDns = jest.fn();
  const guardedFetch = jest.fn();
  const options = {
    url: localEndpoint,
    method: 'POST',
    timeoutMs: 1000,
    policy: { transportMode: 'guarded_proxy', allowedMethods: ['POST'], followRedirects: true },
    localRendererEndpoint: localEndpoint,
    directFetch,
    resolveDns,
    guardedFetch,
  };
  await expect(executeBoundedEgress(options)).resolves.toMatchObject({ status: 307 });
  await expect(executeBoundedEgress({ ...options, url: localEndpoint.replace('54321', '54322') }))
    .rejects.toThrow('only https://');
  expect(directFetch).toHaveBeenCalledTimes(1);
  expect(directFetch).toHaveBeenCalledWith(localEndpoint, expect.objectContaining({ redirect: 'manual' }));
  expect(guardedFetch).not.toHaveBeenCalled();
  expect(resolveDns).not.toHaveBeenCalled();
});
