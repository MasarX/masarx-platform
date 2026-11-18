import { lookup as resolveHost } from 'node:dns/promises';
import { request as requestHttps } from 'node:https';
import { isPublicIpAddress } from '../../../../../../../supabase/functions/api-caller/egress.mjs';

export function createTokenTransport({ lookup = resolveHost, request = requestHttps } = {}) {
  return (endpoint, parameters) => new Promise((resolve, reject) => {
    let pending;
    let settled = false;
    const finish = (error, result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (error) {
        pending?.destroy();
        reject(new Error('OAuth token request failed.'));
      } else resolve(result);
    };
    const timer = setTimeout(() => finish(true), 10_000);
    let url;
    try {
      url = new URL(endpoint);
      if (url.protocol !== 'https:' || url.username || url.password || url.hash || url.port && url.port !== '443') throw new Error();
    } catch { finish(true); return; }
    const hostname = url.hostname.replace(/^\[|\]$/g, '');
    Promise.resolve().then(() => lookup(hostname, { all: true, verbatim: true })).then((addresses) => {
      if (settled) return;
      if (!Array.isArray(addresses) || !addresses.length || addresses.some(({ address }) => !isPublicIpAddress(address))) throw new Error();
      const pinned = addresses[0];
      const body = new URLSearchParams(parameters).toString();
      pending = request(url, {
        method: 'POST', agent: false, servername: hostname, rejectUnauthorized: true,
        headers: { accept: 'application/json', 'content-type': 'application/x-www-form-urlencoded', 'content-length': Buffer.byteLength(body) },
        // Pin the checked peer; TLS still verifies the original provider hostname.
        lookup: (_host, options, callback) => options.all
          ? callback(null, [pinned]) : callback(null, pinned.address, pinned.family),
      }, (response) => {
        const status = response.statusCode || 0;
        const contentType = String(response.headers['content-type'] || '').split(';')[0].trim().toLowerCase();
        if (status < 200 || status >= 300 && status < 400 || !/^application\/(?:json|[\w.+-]+\+json)$/.test(contentType) || Number(response.headers['content-length'] || 0) > 65_536) {
          response.destroy(); finish(true); return;
        }
        const chunks = [];
        let bytes = 0;
        response.on('data', (chunk) => {
          bytes += chunk.length;
          if (bytes > 65_536) { response.destroy(); finish(true); return; }
          chunks.push(chunk);
        });
        response.on('error', () => finish(true));
        response.on('aborted', () => finish(true));
        response.on('end', () => {
          try { finish(false, { status, body: JSON.parse(Buffer.concat(chunks).toString('utf8')) }); }
          catch { finish(true); }
        });
      });
      pending.on('error', () => finish(true));
      pending.end(body);
    }).catch(() => finish(true));
  });
}

export const requestOAuthTokens = createTokenTransport();
