const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const ts = require('typescript');
const { webcrypto, randomUUID } = require('node:crypto');

const edgeRoot = path.resolve(__dirname, '../../../supabase/functions');

test('proof URLs bind to the session, expire and serve only stripped private image bytes', async () => {
  const saved = await import('../../../supabase/functions/_shared/raster-images.mjs');
  const { outputText } = ts.transpileModule(fs.readFileSync(path.join(edgeRoot, 'public-shipment-tracking/proof.ts'), 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  });
  const record = { exports: {} };
  let now = Date.now();
  vm.runInNewContext(outputText, {
    require: () => saved,
    exports: record.exports,
    TextEncoder, Response, Headers, URLSearchParams,
    crypto: webcrypto,
    Date: { now: () => now, parse: Date.parse },
  });
  const { serveTrackingProof } = record.exports;
  const id = randomUUID();
  const owner = randomUUID();
  const other = randomUUID();
  const token = randomUUID();
  const salt = randomUUID();
  const chunk = (kind, bytes) => {
    const length = Buffer.alloc(4);
    length.writeUInt32BE(bytes.length);
    return Buffer.concat([length, Buffer.from(kind), bytes, Buffer.alloc(4)]);
  };
  const png = Buffer.concat([
    Buffer.from('89504e470d0a1a0a', 'hex'),
    chunk('IHDR', Buffer.from('00000001000000010802000000', 'hex')),
    chunk('eXIf', Buffer.from([1, 2, 3])),
    chunk('IDAT', Buffer.from([0])),
    chunk('IEND', Buffer.alloc(0)),
  ]);
  const artifact = {
    id, kind: 'photo', captured_at: new Date(now).toISOString(),
    storage_bucket: 'fixture-bucket', storage_key: 'fixture-path', mime_type: 'image/png',
  };
  const client = {
    rpc: jest.fn(async (_name, { p_input }) => ({
      data: {
        ok: true, session_id: p_input.session_token === token ? owner : other,
        session_expires_at: new Date(now + 3600_000).toISOString(),
        proof: {
          state: 'available', available_until: new Date(now + 7200_000).toISOString(),
          recipient_name: 'F******', artifacts: [artifact],
        },
      },
    })),
    storage: { from: jest.fn(() => ({ download: async () => ({ data: new Blob([png]) }) })) },
  };
  const requestUrl = new URL('https://edge.example.invalid/functions/v1/public-shipment-tracking/proof');
  const listing = await serveTrackingProof(client, { session_token: token }, requestUrl, {}, salt);
  const { proof } = await listing.json();
  expect(proof.artifacts[0]).toEqual({ kind: 'photo', captured_at: artifact.captured_at, url: expect.any(String) });
  const fileUrl = new URL(proof.artifacts[0].url, requestUrl);
  const file = await serveTrackingProof(client, { session_token: token }, fileUrl, {}, salt);
  expect(file.status).toBe(200);
  expect(file.headers.get('cache-control')).toBe('no-store');
  expect(file.headers.get('referrer-policy')).toBe('no-referrer');
  expect(Buffer.from(await file.arrayBuffer()).includes(Buffer.from('eXIf'))).toBe(false);
  expect((await serveTrackingProof(client, { session_token: randomUUID() }, fileUrl, {}, salt)).status).toBe(404);
  now += 600_000;
  expect((await serveTrackingProof(client, { session_token: token }, fileUrl, {}, salt)).status).toBe(404);
  expect(client.storage.from).toHaveBeenCalledTimes(1);
});
