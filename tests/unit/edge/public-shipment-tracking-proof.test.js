const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const ts = require('typescript');
const { webcrypto, randomUUID } = require('node:crypto');

const edgeRoot = path.resolve(__dirname, '../../../supabase/functions');

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
// Same 1px progressive JPEG fixture used for the upload validator.
const progressive = Buffer.from('/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAAgGBgcGBQgHBwcJCQgKDBQNDAsLDBkSEw8UHRofHh0aHBwgJC4nICIsIxwcKDcpLDAxNDQ0Hyc5PTgyPC4zNDL/2wBDAQkJCQwLDBgNDRgyIRwhMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjL/wgARCAABAAEDASIAAhEBAxEB/8QAFQABAQAAAAAAAAAAAAAAAAAAAAX/xAAVAQEBAAAAAAAAAAAAAAAAAAAFBv/aAAwDAQACEAMQAAABigy4/8QAFBABAAAAAAAAAAAAAAAAAAAAAP/aAAgBAQABBQJ//8QAFBEBAAAAAAAAAAAAAAAAAAAAAP/aAAgBAwEBPwF//8QAFBEBAAAAAAAAAAAAAAAAAAAAAP/aAAgBAgEBPwF//8QAFBABAAAAAAAAAAAAAAAAAAAAAP/aAAgBAQAGPwJ//8QAFBABAAAAAAAAAAAAAAAAAAAAAP/aAAgBAQABPyF//9oADAMBAAIAAwAAABAH/8QAFBEBAAAAAAAAAAAAAAAAAAAAAP/aAAgBAwEBPxB//8QAFBEBAAAAAAAAAAAAAAAAAAAAAP/aAAgBAgEBPxB//8QAFBABAAAAAAAAAAAAAAAAAAAAAP/aAAgBAQABPxB//9k=', 'base64');

async function setup(bytes = png, mime = 'image/png') {
  const raster = await import('../../../supabase/functions/_shared/raster-images.mjs');
  const { outputText } = ts.transpileModule(fs.readFileSync(path.join(edgeRoot, 'public-shipment-tracking/proof.ts'), 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  });
  const record = { exports: {} };
  let now = Date.UTC(2026, 10, 24);
  vm.runInNewContext(outputText, {
    require: () => raster,
    exports: record.exports,
    AbortSignal, TextEncoder, Response, Headers, URLSearchParams,
    crypto: webcrypto,
    Date: { now: () => now, parse: Date.parse },
  });
  const { serveTrackingProof } = record.exports;
  const org = randomUUID();
  const owner = randomUUID();
  const other = randomUUID();
  const token = randomUUID();
  const secret = randomUUID();
  const artifact = {
    id: randomUUID(), kind: 'photo', captured_at: new Date(now).toISOString(),
    storage_bucket: 'fieldops-evidence', storage_key: org + '/proof/photo.jpg', mime_type: mime,
  };
  const artifacts = [artifact];
  const download = jest.fn(() => ({ asStream: async () => ({ data: new Blob([bytes]).stream() }) }));
  const client = {
    rpc: jest.fn(async (_name, { p_input }) => ({
      data: {
        ok: true, session_id: p_input.session_token === token ? owner : other, organization_id: org,
        session_expires_at: new Date(now + 3600_000).toISOString(),
        proof: {
          state: 'available', available_until: new Date(now + 7200_000).toISOString(),
          recipient_name: 'F******', artifacts,
        },
      },
    })),
    storage: { from: jest.fn(() => ({ download })) },
  };
  const requestUrl = new URL('https://edge.example.invalid/functions/v1/public-shipment-tracking/proof');
  const request = (url = requestUrl, sessionToken = token) =>
    serveTrackingProof(client, { session_token: sessionToken }, url, {}, secret);
  const list = async () => (await (await request()).json()).proof;
  const fileUrl = (relative) => new URL(relative, requestUrl);
  return { org, artifact, artifacts, download, request, list, fileUrl, raster, advance: () => { now += 600_000; } };
}

test('proof URLs bind to the session and artifact, detect tampering and expire', async () => {
  const { artifact, artifacts, download, request, list, fileUrl, advance } = await setup();
  const proof = await list();
  expect(proof.artifacts[0]).toEqual({ kind: 'photo', captured_at: artifact.captured_at, url: expect.any(String) });
  const url = fileUrl(proof.artifacts[0].url);
  const file = await request(url);
  expect(file.status).toBe(200);
  expect(file.headers.get('cache-control')).toBe('no-store');
  expect(file.headers.get('referrer-policy')).toBe('no-referrer');
  expect(Buffer.from(await file.arrayBuffer()).includes(Buffer.from('eXIf'))).toBe(false);
  expect((await request(url, randomUUID())).status).toBe(404);

  const tampered = new URL(url);
  const signature = tampered.searchParams.get('signature');
  tampered.searchParams.set('signature', (signature[0] === '0' ? '1' : '0') + signature.slice(1));
  expect((await request(tampered)).status).toBe(404);

  const wrongArtifact = new URL(url);
  const otherArtifact = { ...artifact, id: randomUUID(), kind: 'signature' };
  artifacts.push(otherArtifact);
  wrongArtifact.searchParams.set('artifact', otherArtifact.id);
  expect((await request(wrongArtifact)).status).toBe(404);

  advance();
  expect((await request(url)).status).toBe(404);
  expect(download).toHaveBeenCalledTimes(2);
});

test('proof refuses invalid storage paths before calling Storage', async () => {
  const { org, artifact, download, request, list, fileUrl } = await setup();
  const { artifacts } = await list();
  const url = fileUrl(artifacts[0].url);
  download.mockClear();
  const otherOrg = randomUUID();
  const rejected = [
    org + '/../' + otherOrg + '/photo.jpg',
    org + '/%2e%2e/' + otherOrg + '/photo.jpg',
    org + '/..\\' + otherOrg + '\\photo.jpg',
    org + '/./photo.jpg', org + '//photo.jpg', '/' + org + '/photo.jpg',
    otherOrg + '/photo.jpg',
  ];
  for (const path of rejected) {
    artifact.storage_key = path;
    expect((await request(url)).status).toBe(404);
    expect((await list()).artifacts).toEqual([]);
  }
  expect(download).not.toHaveBeenCalled();
});

test('JPEG proof preserves Adobe color data and strips private metadata between scans', async () => {
  const segment = (marker, payload) => {
    const header = Buffer.from([0xff, marker, 0, 0]);
    header.writeUInt16BE(payload.length + 2, 2);
    return Buffer.concat([header, payload]);
  };
  const adobe = segment(0xee, Buffer.concat([Buffer.from('Adobe'), Buffer.from([0, 100, 0, 0, 0, 0, 1])]));
  const exif = segment(0xe1, Buffer.from('Exif\0\0fixture'));
  const xmp = segment(0xe1, Buffer.from('http://ns.adobe.com/xap/1.0/\0fixture'));
  const app2 = segment(0xe2, Buffer.from('fixture ICC metadata'));
  const app13 = segment(0xed, Buffer.from('fixture Photoshop metadata'));
  const comment = segment(0xfe, Buffer.from('fixture JPEG comment'));
  const secondScan = progressive.indexOf(Buffer.from([0xff, 0xda]), 2 + progressive.indexOf(Buffer.from([0xff, 0xda])));
  const input = Buffer.concat([
    progressive.subarray(0, 2), adobe, exif, app2, progressive.subarray(2, secondScan),
    xmp, app13, comment, progressive.subarray(secondScan),
  ]);
  const { request, list, fileUrl, raster } = await setup(input, 'image/jpeg');
  const { artifacts } = await list();
  const file = await request(fileUrl(artifacts[0].url));
  expect(file.status).toBe(200);
  const output = Buffer.from(await file.arrayBuffer());
  expect(raster.validatedLogoContentType(output, 'image/jpeg')).toBe('image/jpeg');
  const endJfif = 4 + progressive.readUInt16BE(4);
  expect(output).toEqual(Buffer.concat([progressive.subarray(0, 2), adobe, progressive.subarray(endJfif)]));
});

test.each([
  ['a raster over 4096px', () => {
    const wide = Buffer.from(png);
    wide.writeUInt32BE(4097, 16);
    return wide;
  }],
  ['a file over 5 MiB', () => Buffer.alloc(5 * 1024 * 1024 + 1)],
  ['a declared PNG containing JPEG bytes', () => progressive],
])('proof listing and download refuse %s', async (_label, invalidBytes) => {
  const { request, list, fileUrl, download } = await setup();
  const { artifacts } = await list();
  const url = fileUrl(artifacts[0].url);
  download.mockImplementation(() => ({ asStream: async () => ({ data: new Blob([invalidBytes()]).stream() }) }));
  expect(await list()).toEqual({ state: 'unavailable', available_until: null, recipient_name: null, artifacts: [] });
  expect((await request(url)).status).toBe(404);
});
