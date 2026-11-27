async function signedRendererHeaders(url) {
  const { authorizeRendererSend } = await import('../../../supabase/functions/api-caller/renderer-auth.mjs');
  const endpoint = new URL(url);
  const allowLocalHttp = ['localhost', '127.0.0.1', '[::1]'].includes(endpoint.hostname);
  const request = await authorizeRendererSend(
    { url },
    url,
    process.env.LABEL_RENDERER_SIGNING_KEY,
    process.env.LABEL_RENDERER_GATEWAY_JWT,
    allowLocalHttp,
  );
  return { ...request.headers, apikey: process.env.SUPABASE_ANON_KEY };
}

module.exports = { signedRendererHeaders };
