const fs = require('fs');
const path = require('path');
const vm = require('vm');
const ts = require('typescript');
const { createHmac, webcrypto } = require('crypto');

const functionsRoot = path.resolve(__dirname, '../../../supabase/functions');
const compiledModules = new Map();

// Run the real handler and shared modules with isolated environment and I/O.
function loadHandler(name, { env = {}, createClient = jest.fn(), fetch = jest.fn() } = {}) {
  let handler;
  const loaded = new Map();
  const context = vm.createContext({
    URL, URLSearchParams, Request, Response, Headers, Blob, TextEncoder, TextDecoder,
    Uint8Array, AbortController, DOMException, setTimeout, clearTimeout,
    atob, btoa, crypto: webcrypto, fetch,
    console: { error: jest.fn(), warn: jest.fn(), log: jest.fn(), info: jest.fn() },
    Deno: { env: { get: (key) => env[key] }, serve: (fn) => { handler = fn; } },
  });
  const load = (filename) => {
    if (loaded.has(filename)) return loaded.get(filename).exports;
    const module = { exports: {} };
    loaded.set(filename, module);
    if (!compiledModules.has(filename)) {
      compiledModules.set(filename, ts.transpileModule(fs.readFileSync(filename, 'utf8'), {
        fileName: `${filename}.ts`,
        compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
      }).outputText);
    }
    const localRequire = (specifier) => {
      if (specifier.startsWith('npm:@supabase/supabase-js@')) return { createClient };
      if (specifier === 'npm:@xmldom/xmldom@0.9.12') return require('@xmldom/xmldom');
      if (specifier.startsWith('./_shared/')) {
        return load(path.join(functionsRoot, '_shared', specifier.slice('./_shared/'.length)));
      }
      if (specifier.startsWith('.')) return load(path.resolve(path.dirname(filename), specifier));
      throw new Error(`Unexpected edge import: ${specifier}`);
    };
    const execute = new vm.Script(`(function(require, module, exports) {\n${compiledModules.get(filename)}\n})`, { filename });
    execute.runInContext(context)(localRequire, module, module.exports);
    return module.exports;
  };
  load(path.join(functionsRoot, name, 'index.ts'));
  return handler;
}

describe('organization profile branding authority and compensation', () => {
  const bucketConfig = fs.readFileSync(path.join(functionsRoot, '../config.toml'), 'utf8')
    .split('[storage.buckets."label-render-assets"]')[1].split(/\r?\n\[/)[0];
  const allowedLogoMimeTypes = JSON.parse(bucketConfig.match(/^allowed_mime_types = (.+)$/m)[1]);
  const org = '4d1fbd36-6b6e-4c35-acc4-5e3ad9043830';
  const actor = '22222222-2222-4222-8222-222222222222';
  const artifactId = '33333333-3333-4333-8333-333333333333';
  const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABAQMAAAAl21bKAAAAA1BMVEX/AAAZ4gk3AAAACklEQVR4nGNgAAAAAgABSK+kcQAAAABJRU5ErkJggg==', 'base64');
  const old = { id: org, name: 'Synthetic tenant', timezone: 'UTC', locale: 'en', default_settings: { keep: { flag: true }, branding: { logo_artifact_id: 'OLD' } } };
  const request = (payload = {}, headers = {}) => new Request('https://api.example.test/functions/v1/organization-profile', {
    method: 'POST', headers: { authorization: 'Bearer verified-user', origin: 'https://console.example.test', 'content-type': 'application/json', ...headers },
    body: JSON.stringify({ action: 'save', organization_id: org, ...payload }),
  });
  const logo = (bytes = png, contentType = 'image/png') => ({ file_name: 'logo.png', content_type: contentType, file_base64: bytes.toString('base64') });
  function setup({ denied = false, registerError = null, registerThrow = false, saveError = null, abortError = null, removeError = null, uploadError = null } = {}) {
    const upload = jest.fn(async (_key, _blob, { contentType }) => ({
      error: uploadError || (allowedLogoMimeTypes.includes(contentType) ? null : { message: 'MIME type not allowed' }),
    }));
    const remove = jest.fn(async () => ({ error: removeError }));
    const createSignedUrl = jest.fn(async () => ({ data: { signedUrl: 'https://api.example.test/storage/v1/object/sign/private?token=short' }, error: null }));
    const from = jest.fn(() => ({ upload, remove, createSignedUrl }));
    const userRpc = jest.fn(async (name, args) => {
      if (name === 'organization_profile_read_v1') return {
        error: denied ? { code: '42501' } : null,
        data: denied ? null : { actor_user_id: actor, organization_id: org, profile: old, logo: {
          artifact_id: 'OLD', storage_bucket: 'label-render-assets', storage_key: `${org}/branding/OLD/logo.png`, file_name: 'old.png',
        } },
      };
      if (name === 'ui_update_organization_profile_v1') return { error: saveError, data: saveError ? null : {
        actor_user_id: actor, organization_id: org,
        profile: { ...old, name: args.p_args.name || old.name }, logo: null,
      } };
      throw new Error('Unexpected user RPC '+name);
    });
    const serviceRpc = jest.fn(async (name) => {
      if (name === 'register_artifact_v1') {
        if (registerThrow) throw new Error('transport interrupted');
        return { data: registerError ? null : [{ artifact_id: artifactId, created: true }], error: registerError };
      }
      if (name === 'organization_profile_abort_upload_v1') return { data: !abortError, error: abortError };
      throw new Error('Unexpected service RPC '+name);
    });
    const createClient = jest.fn((_url, key) => key === 'service' ? { rpc: serviceRpc, storage: { from } } : { rpc: userRpc });
    const handler = loadHandler('organization-profile', { createClient, env: {
      EDGE_SUPABASE_URL: 'https://api.example.test', EDGE_SUPABASE_ANON_KEY: 'anon', EDGE_SUPABASE_SERVICE_ROLE_KEY: 'service',
      API_GATEWAY_CORS_ALLOW_ORIGINS: 'https://console.example.test',
    } });
    return { handler, upload, remove, from, createSignedUrl, userRpc, serviceRpc, createClient };
  }
  test.each(['read','save','signed_url'])('denies %s before storage or mutation when the writer guard fails', async (action) => {
    const calls = setup({ denied: true });
    expect((await calls.handler(request({ action, ...logo() }))).status).toBe(403);
    expect(calls.upload).not.toHaveBeenCalled();
    expect(calls.serviceRpc).not.toHaveBeenCalled();
    expect(calls.createSignedUrl).not.toHaveBeenCalled();
  });
  test.each(['actor_user_id','storage_bucket','storage_key','source_system','artifact_id','logo_artifact_id','default_settings','default_settings_patch'])('rejects caller-supplied %s', async (key) => {
    const calls = setup();
    expect((await calls.handler(request({ [key]: 'forged' }))).status).toBe(400);
    expect(calls.userRpc).not.toHaveBeenCalled();
  });
  test.each([null, 123, {}, '#fff', '#11223344', 'red'])('rejects noncanonical branding colors %j before any upload', async (color) => {
    const calls = setup();
    expect((await calls.handler(request({ ...logo(), primary_color: color }))).status).toBe(400);
    expect(calls.userRpc).not.toHaveBeenCalled();
    expect(calls.upload).not.toHaveBeenCalled();
  });
  test('requires bearer auth and the existing exact-origin CORS allowlist', async () => {
    const calls = setup();
    expect((await calls.handler(request({}, { authorization: '' }))).status).toBe(401);
    expect((await calls.handler(request({}, { origin: 'https://evil.example.test' }))).status).toBe(403);
    expect(calls.userRpc).not.toHaveBeenCalled();
  });
  test('keeps read and preview bound to the exact guard-owned organization and current logo', async () => {
    const calls = setup();
    const read = await calls.handler(request({ action: 'read' }));
    expect(await read.json()).toEqual({ ok: true, profile: old, logo: { artifact_id: 'OLD', file_name: 'old.png' } });
    expect(read.headers.get('cache-control')).toBe('no-store');
    const preview = await calls.handler(request({ action: 'signed_url' }));
    expect(preview.status).toBe(200);
    expect(calls.userRpc).toHaveBeenCalledTimes(2);
    expect(calls.createSignedUrl).toHaveBeenCalledWith(`${org}/branding/OLD/logo.png`, 60);
    expect(calls.upload).not.toHaveBeenCalled();
  });
  test('registers the actual bytes under a new server-generated identity and saves by returned artifact id', async () => {
    const calls = setup();
    const response = await calls.handler(request({ ...logo(), name: 'Renamed', primary_color: '#112233' }));
    expect(response.status).toBe(200);
    const [key, blob, options] = calls.upload.mock.calls[0];
    expect(key).toMatch(new RegExp(`^${org}/branding/[0-9a-f-]{36}/logo.png$`));
    expect(Buffer.from(await blob.arrayBuffer())).toEqual(png);
    expect(options).toEqual({ contentType: 'image/png', upsert: false });
    const registered = calls.serviceRpc.mock.calls[0][1].p_artifact;
    expect(registered).toMatchObject({ organization_id: org, created_by_user_id: actor, source_system: 'organization-profile', storage_bucket: 'label-render-assets', storage_key: key, size_bytes: png.length });
    expect(registered.sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(calls.userRpc).toHaveBeenLastCalledWith('ui_update_organization_profile_v1', { p_args: { organization_id: org, name: 'Renamed', primary_color: '#112233', logo_artifact_id: artifactId } });
    expect((await response.json()).profile.name).toBe('Renamed');
    expect(calls.remove).not.toHaveBeenCalled();
    expect(old.default_settings.branding.logo_artifact_id).toBe('OLD');
  });
  test('compensates only the acknowledged new object after a confirmed registration rollback', async () => {
    const calls = setup({ registerError: { code: '23514' } });
    const response = await calls.handler(request(logo()));
    expect((await response.json()).compensation.status).toBe('removed_new_upload');
    expect(calls.remove).toHaveBeenCalledWith([calls.upload.mock.calls[0][0]]);
    expect(calls.userRpc).not.toHaveBeenCalledWith('ui_update_organization_profile_v1', expect.anything());
  });
  test('aborts the exact returned new artifact before compensating its object after save failure', async () => {
    const calls = setup({ saveError: { code: '22023' } });
    const response = await calls.handler(request(logo()));
    const body = await response.json();
    expect(body.error.code).toBe('organization_profile_update_failed');
    expect(body.compensation.status).toBe('removed_new_upload');
    const key = calls.upload.mock.calls[0][0];
    expect(calls.serviceRpc).toHaveBeenLastCalledWith('organization_profile_abort_upload_v1', {
      p_artifact_id: artifactId, p_organization_id: org, p_actor_user_id: actor,
      p_upload_id: key.split('/')[2], p_storage_key: key,
    });
    expect(calls.remove).toHaveBeenCalledWith([key]);
    expect(calls.remove.mock.calls.flat(2).some((value) => String(value).includes('/OLD/'))).toBe(false);
  });
  test.each([
    [{ registerThrow: true }, 'registration_state_unknown'],
    [{ saveError: { code: '22023' }, abortError: { code: '42501' } }, 'artifact_abort_failed'],
    [{ uploadError: { message: 'transport unknown' } }, 'upload_result_unknown'],
  ])('retains custody rather than pretending uncertain cleanup succeeded: %j', async (options, reason) => {
    const calls = setup(options);
    const response = await calls.handler(request(logo()));
    expect((await response.json()).compensation).toEqual({ status: 'unconfirmed', reason });
    expect(calls.remove).not.toHaveBeenCalled();
  });
  test('keeps the original error alongside failed object compensation', async () => {
    const calls = setup({ saveError: { code: '22023' }, removeError: { message: 'storage unavailable' } });
    const body = await (await calls.handler(request(logo()))).json();
    expect(body.error.code).toBe('organization_profile_update_failed');
    expect(body.compensation).toEqual({ status: 'unconfirmed', reason: 'object_remove_failed' });
  });
  const webpChunk = (type, body) => {
    const head = Buffer.alloc(8); head.write(type); head.writeUInt32LE(body.length, 4);
    return Buffer.concat([head, body, body.length % 2 ? Buffer.from([0]) : Buffer.alloc(0)]);
  };
  const webp = (...chunks) => {
    const head = Buffer.alloc(12); head.write('RIFF'); head.write('WEBP', 8);
    const value = Buffer.concat([head, ...chunks]); value.writeUInt32LE(value.length - 8, 4); return value;
  };
  const lossless = Buffer.from([0x2f,0,0,0,0,0x88]);
  const lossy = Buffer.from([0x10,0,0,0x9d,1,0x2a,1,0,1,0,0x88]);
  const canvas = Buffer.alloc(10);
  const animationCanvas = Buffer.from(canvas); animationCanvas[0] = 2;
  const frame = Buffer.concat([Buffer.alloc(16), webpChunk('VP8L', lossless)]);
  test.each([
    ['lossless WebP', webp(webpChunk('VP8L', lossless)), 'image/webp'],
    ['lossy WebP', webp(webpChunk('VP8 ', lossy)), 'image/webp'],
    ['extended WebP', webp(webpChunk('VP8X', canvas), webpChunk('VP8L', lossless)), 'image/webp'],
    ['animated WebP', webp(webpChunk('VP8X', animationCanvas), webpChunk('ANIM', Buffer.alloc(6)), webpChunk('ANMF', frame)), 'image/webp'],
    ['PNG', png, 'image/png'],
  ])('preserves supported %s logos', async (_label, bytes, mime) => {
    const calls = setup(); expect((await calls.handler(request(logo(bytes, mime)))).status).toBe(200);
  });
  test.each([
    ['truncated PNG', png.subarray(0,8), 'image/png'],
    ['SVG is not a logo raster', Buffer.from('<svg/>'), 'image/svg+xml'],
    ['MIME mismatch', png, 'image/jpeg'],
    ['WebP signature only', Buffer.from('RIFF0000WEBP'), 'image/webp'],
    ['WebP wrong RIFF size', webp(webpChunk('VP8L', lossless)).subarray(0,-1), 'image/webp'],
    ['WebP empty bitstream', webp(webpChunk('VP8L', lossless.subarray(0,5))), 'image/webp'],
    ['WebP oversized dimensions', webp(webpChunk('VP8L', Buffer.from([0x2f,0xff,0x3f,0,0,0x88]))), 'image/webp'],
    ['WebP reserved flags', webp(webpChunk('VP8X', Buffer.from([0x80,0,0,0,0,0,0,0,0,0])), webpChunk('VP8L', lossless)), 'image/webp'],
    ['WebP mismatched canvas', webp(webpChunk('VP8X', Buffer.from([0,0,0,0,1,0,0,0,0,0])), webpChunk('VP8L', lossless)), 'image/webp'],
    ['WebP duplicate bitstream', webp(webpChunk('VP8L', lossless), webpChunk('VP8L', lossless)), 'image/webp'],
    ['WebP missing animation header', webp(webpChunk('VP8X', animationCanvas), webpChunk('ANMF', frame)), 'image/webp'],
    ['WebP out of bounds frame', webp(webpChunk('VP8X', animationCanvas), webpChunk('ANIM', Buffer.alloc(6)), webpChunk('ANMF', Buffer.concat([Buffer.from([1]), frame.subarray(1)]))), 'image/webp'],
    ['oversize file', Buffer.alloc(5*1024*1024+1), 'image/png'],
  ])('rejects %s before storage', async (_label, bytes, mime) => {
    const calls = setup(); expect((await calls.handler(request(logo(bytes, mime)))).status).toBeGreaterThanOrEqual(400);
    expect(calls.upload).not.toHaveBeenCalled(); expect(calls.serviceRpc).not.toHaveBeenCalled();
  });
  test.each(['!!!=', 'AAA', 'A===', 'AA=A'])('rejects malformed base64 %s before storage', async (base64) => {
    const calls = setup();
    expect((await calls.handler(request({ ...logo(), file_base64: base64 }))).status).toBe(400);
    expect(calls.upload).not.toHaveBeenCalled();
  });
});

describe('designer image uploads validate bytes before storage', () => {
  // Real 1px PNG/APNG (UPNG) and baseline/progressive JPEG (Pillow) fixtures, not mocked parser results.
  const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABAQMAAAAl21bKAAAAA1BMVEX/AAAZ4gk3AAAACklEQVR4nGNgAAAAAgABSK+kcQAAAABJRU5ErkJggg==', 'base64');
  const apng = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABAQMAAAAl21bKAAAACGFjVEwAAAACAAAAAPONk3AAAAAGUExURf8AAAD/ANKH73EAAAAaZmNUTAAAAAAAAAABAAAAAQAAAAAAAAAAAGQD6AAAs35jzQAAAApJREFUeJxjYAAAAAIAAUivpHEAAAAaZmNUTAAAAAEAAAABAAAAAQAAAAAAAAAAAGQD6AABXwq5jwAAAA5mZEFUAAAAAnicY2gAAACCAIEF0jlmAAAAAElFTkSuQmCC', 'base64');
  const jpeg = Buffer.from('/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAAgGBgcGBQgHBwcJCQgKDBQNDAsLDBkSEw8UHRofHh0aHBwgJC4nICIsIxwcKDcpLDAxNDQ0Hyc5PTgyPC4zNDL/2wBDAQkJCQwLDBgNDRgyIRwhMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjL/wAARCAABAAEDASIAAhEBAxEB/8QAHwAAAQUBAQEBAQEAAAAAAAAAAAECAwQFBgcICQoL/8QAtRAAAgEDAwIEAwUFBAQAAAF9AQIDAAQRBRIhMUEGE1FhByJxFDKBkaEII0KxwRVS0fAkM2JyggkKFhcYGRolJicoKSo0NTY3ODk6Q0RFRkdISUpTVFVWV1hZWmNkZWZnaGlqc3R1dnd4eXqDhIWGh4iJipKTlJWWl5iZmqKjpKWmp6ipqrKztLW2t7i5usLDxMXGx8jJytLT1NXW19jZ2uHi4+Tl5ufo6erx8vP09fb3+Pn6/8QAHwEAAwEBAQEBAQEBAQAAAAAAAAECAwQFBgcICQoL/8QAtREAAgECBAQDBAcFBAQAAQJ3AAECAxEEBSExBhJBUQdhcRMiMoEIFEKRobHBCSMzUvAVYnLRChYkNOEl8RcYGRomJygpKjU2Nzg5OkNERUZHSElKU1RVVldYWVpjZGVmZ2hpanN0dXZ3eHl6goOEhYaHiImKkpOUlZaXmJmaoqOkpaanqKmqsrO0tba3uLm6wsPExcbHyMnK0tPU1dbX2Nna4uPk5ebn6Onq8vP09fb3+Pn6/9oADAMBAAIRAxEAPwDi6KKK+ZP3E//Z', 'base64');
  const progressive = Buffer.from('/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAAgGBgcGBQgHBwcJCQgKDBQNDAsLDBkSEw8UHRofHh0aHBwgJC4nICIsIxwcKDcpLDAxNDQ0Hyc5PTgyPC4zNDL/2wBDAQkJCQwLDBgNDRgyIRwhMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjL/wgARCAABAAEDASIAAhEBAxEB/8QAFQABAQAAAAAAAAAAAAAAAAAAAAX/xAAVAQEBAAAAAAAAAAAAAAAAAAAFBv/aAAwDAQACEAMQAAABigy4/8QAFBABAAAAAAAAAAAAAAAAAAAAAP/aAAgBAQABBQJ//8QAFBEBAAAAAAAAAAAAAAAAAAAAAP/aAAgBAwEBPwF//8QAFBEBAAAAAAAAAAAAAAAAAAAAAP/aAAgBAgEBPwF//8QAFBABAAAAAAAAAAAAAAAAAAAAAP/aAAgBAQAGPwJ//8QAFBABAAAAAAAAAAAAAAAAAAAAAP/aAAgBAQABPyF//9oADAMBAAIAAwAAABAH/8QAFBEBAAAAAAAAAAAAAAAAAAAAAP/aAAgBAwEBPxB//8QAFBEBAAAAAAAAAAAAAAAAAAAAAP/aAAgBAgEBPxB//8QAFBABAAAAAAAAAAAAAAAAAAAAAP/aAAgBAQABPxB//9k=', 'base64');
  const svg = '<svg xmlns="http://www.w3.org/2000/svg"><rect width="1" height="1"/></svg>';
  const latinSvg = '<svg xmlns="http://www.w3.org/2000/svg"><text>caf\u00e9</text></svg>';
  const latinDeclaration = "<?xml version='1.0' encoding='ISO-8859-1'?>";
  const utf16 = (source, bigEndian = false) => {
    const bytes = Buffer.from(source, 'utf16le');
    return Buffer.concat([Buffer.from(bigEndian ? [254, 255] : [255, 254]), bigEndian ? bytes.swap16() : bytes]);
  };
  const changed = (bytes, change) => { const copy = Buffer.from(bytes); change(copy); return copy; };
  const scan = jpeg.indexOf(Buffer.from([255, 218]));

  function uploads({ who = { ok: true, organization_id: 'org-a', can_read: true, can_write: true }, storageError = null } = {}) {
    const upload = jest.fn(async () => ({ error: storageError }));
    const from = jest.fn(() => ({ upload }));
    const createClient = jest.fn((_url, _key, options) => ({
      rpc: jest.fn(() => ({ single: async () => ({ data: options?.global?.headers?.Authorization === 'Bearer expired' ? null : who, error: null }) })),
      storage: { from },
    }));
    const fetch = jest.fn(() => { throw new Error('Network access forbidden'); });
    const handler = loadHandler('label-designer-assets', { createClient, fetch, env: {
      EDGE_SUPABASE_URL: 'https://api.example.test', EDGE_SUPABASE_ANON_KEY: 'anon', EDGE_SUPABASE_SERVICE_ROLE_KEY: 'service',
    } });
    return { handler, upload, from, createClient, fetch };
  }

  const request = (bytes, contentType, overrides = {}, headers = { authorization: 'Bearer user' }) => new Request('https://api.example.test/functions/v1/label-designer-assets', {
    method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify({
      mode: 'upload', file_name: '../logo.asset', content_type: contentType, file_base64: Buffer.from(bytes).toString('base64'), ...overrides,
    }),
  });

  test.each([
    ['PNG', png, 'image/png'], ['APNG', apng, 'image/png'], ['JPEG', jpeg, 'image/jpeg'], ['progressive JPEG', progressive, 'image/jpeg'],
    ['SVG UTF-8', Buffer.from(svg), 'image/svg+xml'], ['SVG UTF-8 BOM', Buffer.concat([Buffer.from([239,187,191]),Buffer.from(svg)]), 'image/svg+xml'],
    ['SVG UTF-16LE', utf16(svg), 'image/svg+xml'], ['SVG UTF-16BE', utf16(svg, true), 'image/svg+xml'],
    ['SVG Latin1 declaration', Buffer.from(latinDeclaration+latinSvg,'latin1'), 'image/svg+xml'],
    ['SVG Latin1 charset only', Buffer.from(latinSvg,'latin1'), 'image/svg+xml; charset="ISO-8859-1"', 'image/svg+xml; charset=windows-1252'],
    ['SVG matching declaration and charset', Buffer.from(latinDeclaration+latinSvg,'latin1'), 'image/svg+xml; charset=iso-8859-1', 'image/svg+xml; charset=windows-1252'],
    ['SVG charset overrides declaration', Buffer.from("<?xml version='1.0' encoding='UTF-8'?>"+latinSvg,'latin1'), 'image/svg+xml; charset=ISO-8859-1', 'image/svg+xml; charset=windows-1252'],
    ['SVG UTF-8 BOM overrides charset', Buffer.concat([Buffer.from([239,187,191]),Buffer.from(svg)]), 'image/svg+xml; charset=utf-16be', 'image/svg+xml'],
    ['SVG UTF-16 BOM overrides charset and declaration', utf16(latinDeclaration+latinSvg), 'image/svg+xml; charset=utf-8', 'image/svg+xml'],
    ['SVG UTF-16LE charset only', utf16(svg).subarray(2), 'image/svg+xml; charset=UTF-16LE', 'image/svg+xml; charset=utf-16le'],
    ['SVG UTF-16BE charset only', utf16(svg,true).subarray(2), 'image/svg+xml; charset=UTF-16BE', 'image/svg+xml; charset=utf-16be'],
    ['SVG quoted unrelated MIME parameter', Buffer.from(svg), 'image/svg+xml; name="logo; charset=utf-16be"', 'image/svg+xml'],
  ])('retains valid %s bytes and scoped storage semantics', async (_name, bytes, mime, storedMime = mime) => {
    const { handler, upload, from, fetch } = uploads();
    const response = await handler(request(bytes, mime));
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true, path: 'org-a/designer/logo.asset' });
    expect(from).toHaveBeenCalledWith('label-render-assets');
    const [key, blob, options] = upload.mock.calls[0];
    expect(key).toBe('org-a/designer/logo.asset');
    expect(options).toEqual({ contentType: storedMime, upsert: true });
    expect(blob.type).toBe(storedMime);
    expect(Buffer.from(await blob.arrayBuffer())).toEqual(bytes);
    expect(fetch).not.toHaveBeenCalled();
  });

  test.each([
    ['PNG signature only', png.subarray(0,8), 'image/png'], ['PNG header only', png.subarray(0,33), 'image/png'],
    ['PNG no IEND', png.subarray(0,-12), 'image/png'], ['PNG no image data', Buffer.concat([png.subarray(0,33),png.subarray(-12)]), 'image/png'],
    ['PNG oversized chunk', changed(png, b => b.writeUInt32BE(0xffffffff,8)), 'image/png'],
    ['PNG duplicate IHDR', Buffer.concat([png.subarray(0,33),png.subarray(8,33),png.subarray(33)]), 'image/png'],
    ['JPEG signature only', jpeg.subarray(0,3), 'image/jpeg'], ['JPEG no EOI', jpeg.subarray(0,-2), 'image/jpeg'],
    ['JPEG bad segment length', changed(jpeg, b => b.writeUInt16BE(0xffff,4)), 'image/jpeg'],
    ['JPEG no scan', Buffer.concat([jpeg.subarray(0,scan),Buffer.from([255,217])]), 'image/jpeg'],
    ['JPEG invalid scan length', changed(jpeg, b => b.writeUInt16BE(2,scan+2)), 'image/jpeg'],
    ['JPEG empty scan', Buffer.concat([jpeg.subarray(0,scan+2+jpeg.readUInt16BE(scan+2)),Buffer.from([255,217])]), 'image/jpeg'],
    ['malformed SVG', Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><rect>'), 'image/svg+xml'],
    ['SVG parser warning', Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width=1/>'), 'image/svg+xml'],
    ['SVG multiple roots', Buffer.from(svg+svg), 'image/svg+xml'], ['HTML as SVG', Buffer.from('<html/>'), 'image/svg+xml'],
    ['wrong SVG namespace', Buffer.from('<svg xmlns="urn:not-svg"/>'), 'image/svg+xml'],
    ['invalid UTF-8', Buffer.from([0xc3,0x28]), 'image/svg+xml'], ['invalid UTF-16LE', Buffer.concat([utf16(svg),Buffer.from([0])]), 'image/svg+xml'],
    ['invalid UTF-16BE surrogate', Buffer.from([254,255,216,0]), 'image/svg+xml'],
    ['malformed Latin1 XML', Buffer.from(latinDeclaration+latinSvg.replace('</text>','</wrong>'),'latin1'), 'image/svg+xml'],
    ['Latin1 bytes declared UTF-8', Buffer.from("<?xml version='1.0' encoding='UTF-8'?>"+latinSvg,'latin1'), 'image/svg+xml'],
    ['Latin1 bytes with UTF-8 charset', Buffer.from(latinSvg,'latin1'), 'image/svg+xml; charset=utf-8'],
    ['unsupported declaration encoding', Buffer.from("<?xml version='1.0' encoding='made-up-encoding'?>"+svg), 'image/svg+xml'],
    ['empty declaration encoding', Buffer.from("<?xml version='1.0' encoding=''?>"+svg), 'image/svg+xml'],
    ['unsupported MIME charset', Buffer.from(svg), 'image/svg+xml; charset=made-up-encoding'],
    ['empty MIME charset', Buffer.from(svg), 'image/svg+xml; charset=""'],
    ['invalid UTF-16 charset bytes', Buffer.concat([utf16(svg).subarray(2),Buffer.from([0])]), 'image/svg+xml; charset=utf-16le'],
    ['encoding hint hidden in comment', Buffer.from('<!-- '+latinDeclaration+' -->'+latinSvg,'latin1'), 'image/svg+xml'],
    ['unknown bytes', Buffer.from('not an image'), 'image/png'],
  ])('rejects %s before upload', async (_name, bytes, mime) => {
    const { handler, upload } = uploads();
    const response = await handler(request(bytes, mime));
    expect(response.status).toBe(400);
    expect((await response.json()).error.code).toBe('invalid_image');
    expect(upload).not.toHaveBeenCalled();
  });

  test.each([[png,'image/jpeg'],[jpeg,'image/svg+xml'],[Buffer.from(svg),'image/png']])('rejects a valid image with mismatched MIME (case %#)', async (bytes, mime) => {
    const { handler, upload } = uploads();
    const response = await handler(request(bytes,mime));
    expect(response.status).toBe(400);
    expect((await response.json()).error.code).toBe('image_mime_mismatch');
    expect(upload).not.toHaveBeenCalled();
  });

  test.each(['application/pdf','font/ttf','font/otf','font/woff','font/woff2'])('rejects non-image %s uploads before storage', async mime => {
    const { handler, upload } = uploads();
    const response = await handler(request(Buffer.from('synthetic non-image content'), mime));
    expect(response.status).toBe(400);
    expect((await response.json()).error.code).toBe('invalid_image');
    expect(upload).not.toHaveBeenCalled();
  });

  test('strict SVG parsing never fetches external DTDs or expands custom entities', async () => {
    const { handler, upload, fetch } = uploads();
    const dtd = '<!DOCTYPE svg SYSTEM "https://must-not-fetch.invalid/fixture.dtd">'+svg;
    expect((await handler(request(Buffer.from(dtd),'image/svg+xml'))).status).toBe(200);
    for(const entity of ['SYSTEM "file:///must-not-read.invalid"','"expanded"']) {
      const xml = '<!DOCTYPE svg [<!ENTITY x '+entity+'>]><svg xmlns="http://www.w3.org/2000/svg">&x;</svg>';
      expect((await handler(request(Buffer.from(xml),'image/svg+xml'))).status).toBe(400);
    }
    expect(upload).toHaveBeenCalledTimes(1);
    expect(fetch).not.toHaveBeenCalled();
  });

  test('malformed base64, empty bytes, missing name and oversize retain controlled no-upload responses', async () => {
    const { handler, upload } = uploads();
    for(const [bytes,overrides,status,code] of [
      [png,{file_base64:'%%%invalid%%%'},400,'invalid_file_base64'],
      [png,{file_base64:'===='},400,'empty_file'], [png,{file_name:''},400,'file_name_required'],
      [Buffer.alloc(5*1024*1024+1),{},413,'file_too_large'],
    ]) {
      const response = await handler(request(bytes,'image/png',overrides));
      expect(response.status).toBe(status);
      expect((await response.json()).error.code).toBe(code);
    }
    expect(upload).not.toHaveBeenCalled();
  });

  test('denied or unauthenticated actors cannot upload even malformed bytes', async () => {
    for(const who of [{ok:false},{ok:true,organization_id:null,can_write:true},{ok:true,organization_id:'org-a',can_write:false}]) {
      const { handler, upload, from } = uploads({who});
      expect((await handler(request(Buffer.from('invalid'),'image/png'))).status).toBe(403);
      expect(from).not.toHaveBeenCalled();
      expect(upload).not.toHaveBeenCalled();
    }
    const { handler, createClient } = uploads();
    expect((await handler(request(png,'image/png',{},{}))).status).toBe(403);
    expect(createClient).not.toHaveBeenCalled();
  });

  test('body JWT fallback, base64url/data URLs and canonical MIME remain supported', async () => {
    const { handler, upload } = uploads();
    const file_base64 = 'data:image/png;base64,'+png.toString('base64url');
    expect((await handler(request(png,'IMAGE/PNG; charset=binary',{user_jwt:'user',file_base64},{authorization:'Bearer expired'}))).status).toBe(200);
    expect(upload.mock.calls[0][2].contentType).toBe('image/png');
  });

  test('storage failure responses are generic and cross-organization paths are denied', async () => {
    const { handler, upload } = uploads({storageError:{message:'storage rejected'}});
    const response = await handler(request(png,'image/png'));
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({
      ok: false,
      error: { code: 'upload_failed', message: 'Could not upload asset' },
      correlation_id: expect.stringMatching(/^[\da-f]{8}-(?:[\da-f]{4}-){3}[\da-f]{12}$/i),
    });
    for(const mode of ['signed_url','delete']) {
      expect((await handler(request(png,'image/png',{mode,path:'org-b/designer/logo.png'}))).status).toBe(403);
    }
    expect(upload).toHaveBeenCalledTimes(1);
  });
});

describe.each([
  ['marketing-lead-intake', 'MARKETING_CORS_ALLOW_ORIGINS'],
  ['tenant-signup-intake', 'TENANT_SIGNUP_CORS_ALLOW_ORIGINS'],
  ['public-shipment-tracking', 'PUBLIC_TRACKING_CORS_ALLOW_ORIGINS'],
])('%s local fallback isolation', (name, allowlistKey) => {
  test.each(['origin', 'x-forwarded-host', 'host'])('hosted deployment cannot enable local fallback through %s', async (header) => {
    const handler = loadHandler(name, { env: { EDGE_SUPABASE_URL: 'https://api.example.test' } });
    const headers = { origin: 'http://localhost:3333', [header]: header === 'origin' ? 'http://localhost:3333' : 'localhost' };
    const response = await handler(new Request(`https://api.example.test/functions/v1/${name}`, {
      method: 'OPTIONS', headers,
    }));
    expect(response.status).toBe(500);
    expect((await response.json()).error.message).toBe('cors_allowlist_missing');
  });

  test('inherited hosted Kong URL cannot enable local fallbacks', async () => {
    const handler = loadHandler(name, { env: { SUPABASE_URL: 'http://kong:8000' } });
    const response = await handler(new Request(`https://api.example.test/functions/v1/${name}`, {
      method: 'OPTIONS', headers: { origin: 'http://localhost:3333', 'x-forwarded-host': 'localhost' },
    }));
    expect(response.status).toBe(500);
  });

  test.each(['http://127.0.0.1:54321', 'http://kong:8000', 'http://rvzwwjlztwwisjthghnipgjr.example.invalid:54321', 'http://xqpjiyiztkhwlxxwurxilvmo.example.invalid:8000'])('local deployment %s keeps local browser preflight working', async (supabaseUrl) => {
    const handler = loadHandler(name, { env: {
      EDGE_SUPABASE_URL: supabaseUrl,
      PUBLIC_EDGE_LOCAL_QA_ENABLED: '1',
      PUBLIC_EDGE_LOCAL_CORS_ALLOW_ORIGINS: 'http://localhost:3333',
    } });
    const response = await handler(new Request(`http://127.0.0.1:54321/functions/v1/${name}`, {
      method: 'OPTIONS', headers: { origin: 'http://localhost:3333' },
    }));
    expect(response.status).toBe(204);
    expect(response.headers.get('access-control-allow-origin')).toBe('http://localhost:3333');
  });

  test.each([
    {},
    { PUBLIC_EDGE_LOCAL_CORS_ALLOW_ORIGINS: 'http://localhost:3333' },
    { PUBLIC_EDGE_LOCAL_QA_ENABLED: '1' },
  ])('a local backend URL alone does not supply missing QA authority: %j', async (authority) => {
    const handler = loadHandler(name, { env: { EDGE_SUPABASE_URL: 'http://xqpjiyiztkhwlxxwurxilvmo.example.invalid:8000', ...authority } });
    const response = await handler(new Request(`http://127.0.0.1:54321/functions/v1/${name}`, {
      method: 'OPTIONS', headers: { origin: 'http://localhost:3333' },
    }));
    expect(response.status).toBe(500);
    expect((await response.json()).error.message).toBe('cors_allowlist_missing');
    expect(response.headers.has('access-control-allow-origin')).toBe(false);
  });

  test('explicit local QA authority cannot authorize a hosted request or spoofed host headers', async () => {
    const createClient = jest.fn();
    const fetch = jest.fn();
    const handler = loadHandler(name, { createClient, fetch, env: {
      EDGE_SUPABASE_URL: 'https://api.example.test',
      PUBLIC_EDGE_LOCAL_QA_ENABLED: '1',
      PUBLIC_EDGE_LOCAL_CORS_ALLOW_ORIGINS: 'http://localhost:3333',
    } });
    const response = await handler(new Request(`https://api.example.test/functions/v1/${name}`, {
      method: 'OPTIONS', headers: { origin: 'http://localhost:3333', host: 'localhost', 'x-forwarded-host': 'localhost' },
    }));
    expect(response.status).toBe(403);
    expect((await response.json()).error.code).toBe('origin_not_allowed');
    expect(response.headers.has('access-control-allow-origin')).toBe(false);
    expect(createClient).not.toHaveBeenCalled();
    expect(fetch).not.toHaveBeenCalled();
  });

  test('configured hosted origins remain authoritative on local deployments', async () => {
    const handler = loadHandler(name, { env: {
      EDGE_SUPABASE_URL: 'http://127.0.0.1:54321',
      [allowlistKey]: 'https://landing.example.test',
    } });
    const response = await handler(new Request(`http://127.0.0.1:54321/functions/v1/${name}`, {
      method: 'OPTIONS', headers: { origin: 'http://localhost:3333' },
    }));
    expect(response.status).toBe(403);
    expect((await response.json()).error.code).toBe('origin_not_allowed');
  });

  test('hosted deployment accepts its configured origin', async () => {
    const handler = loadHandler(name, { env: {
      EDGE_SUPABASE_URL: 'https://api.example.test',
      [allowlistKey]: 'https://landing.example.test',
    } });
    const response = await handler(new Request(`https://api.example.test/functions/v1/${name}`, {
      method: 'OPTIONS', headers: { origin: 'https://landing.example.test' },
    }));
    expect(response.status).toBe(204);
  });
});

describe('UI resource download storage paths', () => {
  function downloadHandler(filePath) {
    const createSignedUrl = jest.fn(async () => ({ data: { signedUrl: 'https://storage.example.test/signed' }, error: null }));
    const from = jest.fn(() => ({ createSignedUrl }));
    const rpc = jest.fn(async (name) => {
      if (name === 'ui_read_registry_v1') return { data: { resources: [{
        key: 'exports', download: { bucket: 'reports', path_column: 'file_path' },
      }] }, error: null };
      if (name === 'ui_get_resource_v1') return { data: { file_path: filePath }, error: null };
      throw new Error(`Unexpected RPC: ${name}`);
    });
    const createClient = jest.fn(() => ({ rpc, storage: { from } }));
    const handler = loadHandler('ui-resource-download', {
      env: { EDGE_SUPABASE_URL: 'https://api.example.test', EDGE_SUPABASE_ANON_KEY: 'anon', EDGE_SUPABASE_SERVICE_ROLE_KEY: 'service' },
      createClient,
    });
    return { handler, from, createSignedUrl };
  }

  test.each([
    ['https://api.example.test/storage/v1/object/public/reports/tenant/report.pdf', 'reports', 'tenant/report.pdf'],
    ['https://api.example.test/storage/v1/object/sign/reports/tenant/report.pdf?token=existing', 'reports', 'tenant/report.pdf'],
    ['https://api.example.test/storage/v1/object/authenticated/reports/tenant/report.pdf', 'reports', 'tenant/report.pdf'],
    ['https://api.example.test/storage/v1/object/reports/tenant/report.pdf', 'reports', 'tenant/report.pdf'],
    ['https://api.example.test/storage/v1/object/public/reports/tenant/Quarter%201%20%23.pdf', 'reports', 'tenant/Quarter 1 #.pdf'],
    ['reports/tenant/report.pdf', 'reports', 'tenant/report.pdf'],
    ['/reports/tenant/report.pdf', 'reports', 'tenant/report.pdf'],
    ['tenant/report.pdf', 'reports', 'tenant/report.pdf'],
  ])('signs the correct bucket and decoded key for %s', async (filePath, bucket, key) => {
    const { handler, from, createSignedUrl } = downloadHandler(filePath);
    const response = await handler(new Request('https://api.example.test/functions/v1/ui-resource-download?resource=exports&id=record', {
      headers: { authorization: 'Bearer user' },
    }));
    expect(response.status).toBe(200);
    expect(from).toHaveBeenCalledWith(bucket);
    expect(createSignedUrl).toHaveBeenCalledWith(key, 900);
  });

  test.each([
    'https://api.example.test/unrelated/storage/v1/object/public/reports/report.pdf',
    'https://api.example.test/storage/v1/object/public/reports/%invalid.pdf',
    'https://api.example.test/unrelated/report.pdf',
  ])('rejects unsupported or malformed storage URL %s', async (filePath) => {
    const { handler, from } = downloadHandler(filePath);
    const response = await handler(new Request('https://api.example.test/functions/v1/ui-resource-download?resource=exports&id=record', {
      headers: { authorization: 'Bearer user' },
    }));
    expect(response.status).toBe(500);
    expect(from).not.toHaveBeenCalled();
  });
});

describe('GitHub planning webhook validation', () => {
  const secret = 'webhook-fixture-secret';
  const env = { GITHUB_WEBHOOK_SECRET: secret, GITHUB_PLANNING_WORKFLOW_TOKEN: 'workflow-fixture-token' };
  const request = (body, signature) => new Request('https://api.example.test/functions/v1/github-planning-receiver', {
    method: 'POST', body,
    headers: {
      'content-type': 'application/json', 'x-github-event': 'projects_v2_item',
      'x-hub-signature-256': signature || `sha256=${createHmac('sha256', secret).update(body).digest('hex')}`,
    },
  });

  test('malformed JSON returns a controlled client error without dispatching', async () => {
    const fetch = jest.fn();
    const handler = loadHandler('github-planning-receiver', { env, fetch });
    const response = await handler(request('{"secret_input":"must not appear in errors",invalid}'));
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: 'invalid_json' });
    expect(fetch).not.toHaveBeenCalled();
  });

  test.each(['sha256=zz', 'sha256=' + '0'.repeat(63), 'sha256=' + 'g'.repeat(64)])('rejects malformed signature %s', async (signature) => {
    const fetch = jest.fn();
    const handler = loadHandler('github-planning-receiver', { env, fetch });
    const response = await handler(request('{"action":"edited","projects_v2_item":{"node_id":"item-1"}}', signature));
    expect(response.status).toBe(401);
    expect(fetch).not.toHaveBeenCalled();
  });

  test('a valid signed project event still dispatches the workflow', async () => {
    const fetch = jest.fn(async () => new Response(null, { status: 204 }));
    const handler = loadHandler('github-planning-receiver', { env, fetch });
    const response = await handler(request('{"action":"edited","projects_v2_item":{"node_id":"item-1"}}'));
    expect(response.status).toBe(202);
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(JSON.parse(fetch.mock.calls[0][1].body)).toMatchObject({ inputs: { item_id: 'item-1', event_action: 'edited' } });
  });
});
