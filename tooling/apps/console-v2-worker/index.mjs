import securityHeaders from '../../../apps/shared/security-headers.js';

const { buildSecurityHeaders } = securityHeaders;

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.origin !== env.DEV_ORIGIN) return new Response(null, { status: 404 });
    if (request.method !== 'GET' && request.method !== 'HEAD') {
      return new Response(null, { status: 405, headers: { Allow: 'GET, HEAD' } });
    }

    // Keep SPA fallback to documents so missing scripts and deploy markers return 404.
    const document = request.headers.get('sec-fetch-mode') === 'navigate'
      || request.headers.get('accept')?.includes('text/html');
    const staticPath = url.pathname.startsWith('/assets/') || url.pathname.startsWith('/__deploy/');
    const asset = await env.ASSETS.fetch(new Request(url, { method: request.method }));
    const response = asset.status === 404 && document && !staticPath
      ? await env.ASSETS.fetch(new Request(new URL('/index.html', url), { method: request.method }))
      : asset;
    if (!response.ok || !response.headers.get('content-type')?.includes('text/html')) return response;

    const nonce = btoa(String.fromCharCode(...crypto.getRandomValues(new Uint8Array(18))));
    const rewritten = new Response(response.body, response);
    rewritten.headers.set('Cache-Control', 'no-store');
    for (const header of ['ETag', 'Last-Modified', 'Content-Length']) rewritten.headers.delete(header);
    for (const { key, value } of buildSecurityHeaders({
      nonce,
      nodeEnv: 'production',
      supabaseUrl: env.SUPABASE_URL,
      trustedExternalDataOrigins: env.TRUSTED_EXTERNAL_DATA_ORIGINS,
      mapTileOrigins: env.MAP_TILE_ORIGINS,
      fontStylesheetOrigins: env.FONT_STYLESHEET_ORIGINS,
      fontAssetOrigins: env.FONT_ASSET_ORIGINS,
      sameOriginWorkers: true,
    })) {
      rewritten.headers.set(key, value);
    }
    return new HTMLRewriter().on('[nonce]', {
      element(element) {
        if (element.getAttribute('nonce') === env.NONCE_PLACEHOLDER) {
          element.setAttribute('nonce', nonce);
        }
      },
    }).transform(rewritten);
  },
};
