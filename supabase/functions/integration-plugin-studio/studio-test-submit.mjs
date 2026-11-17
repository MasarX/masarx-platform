// Internal Studio submission seam. Never return credential material or upstream bodies.
const uuid = value => typeof value === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);
function fail(code) { throw Object.assign(new Error(code), { status: 400, code }); }
export async function submitStudioTest({ body, bearer, userClient, serviceClient, functionsBaseUrl, fetchImpl = fetch }) {
  if (!uuid(body.source_id) || !body.payload || Array.isArray(body.payload) ||
      typeof body.payload !== 'object' || !uuid(body.payload.event?.id)) fail('studio.test.invalid_request');
  const raw = JSON.stringify(body.payload);
  if (new TextEncoder().encode(raw).length > 65536) fail('studio.test.payload_too_large');
  const { data: identity, error: identityError } = await userClient.auth.getUser(bearer)
    .catch(() => fail('studio.test.authentication_required'));
  if (identityError || !uuid(identity?.user?.id)) fail('studio.test.authentication_required');
  // Never consume body.actor_id, claims, organization_id or supplied credentials.
  const { data: material, error } = await Promise.resolve(
    serviceClient.rpc('integration_studio_test_material_v1', {
      p_actor_id: identity.user.id, p_source_id: body.source_id, p_raw_body: raw,
    }),
  ).catch(() => fail('studio.test.source_unavailable'));
  if (error || material?.source_id !== body.source_id || !material.headers ||
      typeof material.headers['x-webhook-token'] !== 'string') fail('studio.test.source_unavailable');
  let base;
  try { base = new URL(functionsBaseUrl); } catch { fail('studio.test.ingress_configuration_invalid'); }
  const path = base.pathname.replace(/\/+$/g, '');
  if (!['http:', 'https:'].includes(base.protocol) || base.username || base.password || base.search || base.hash ||
      path !== '/functions/v1') fail('studio.test.ingress_configuration_invalid');
  const response = await fetchImpl(new URL(`${path}/webhook-receiver`, base.origin), {
    method: 'POST', headers: material.headers, body: raw, redirect: 'error', signal: AbortSignal.timeout(20000),
  }).catch(() => fail('studio.test.transport_outcome_unknown'));
  // Submission acceptance is not terminal success. No automatic retry after ambiguous transport.
  await response.body?.cancel()?.catch(() => {});
  return { accepted: response.ok, pending: response.ok, http_status: response.status,
    source_id: body.source_id, external_id: body.payload.event.id };
}
