const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');

const {
  CAPTURE_MODE,
  main,
  buildSelftest,
  createStaticServer,
  defaultOutputDir,
  mimeTypeFor,
  normalizeAdbPngBuffer,
  parseArgs,
} = require('../../../scripts/qa/capture-fieldops-ui-screenshots-native-runtime');

function requestServer({ port, requestPath }) {
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        host: '127.0.0.1',
        port,
        method: 'GET',
        path: requestPath,
      },
      (res) => {
        const chunks = [];
        res.on('data', (chunk) => chunks.push(Buffer.from(chunk)));
        res.on('end', () =>
          resolve({
            statusCode: res.statusCode,
            headers: res.headers,
            body: Buffer.concat(chunks),
          }),
        );
      },
    );
    req.on('error', reject);
    req.end();
  });
}

async function closeServer(server) {
  await new Promise((resolve) => server.close(resolve));
}

function createStaticFixture() {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'fieldops-native-runtime-'));
  const rootDir = path.join(tmpDir, 'public');
  const outsideFile = path.join(tmpDir, 'secret.txt');

  fs.mkdirSync(rootDir, { recursive: true });
  fs.writeFileSync(path.join(rootDir, 'version-c.html'), '<html><body>native runtime fixture</body></html>');
  fs.writeFileSync(path.join(rootDir, 'app.css'), 'body { color: black; }');
  fs.writeFileSync(outsideFile, 'top-secret');

  return { tmpDir, rootDir, outsideFile };
}

describe('capture-fieldops-ui-screenshots-native-runtime helpers', () => {
  test('strict native-app requirement refuses this prototype before capture side effects', async () => {
    const previous = process.argv;
    const mkdir = jest.spyOn(fs, 'mkdirSync');
    const createServer = jest.spyOn(http, 'createServer');
    try {
      process.argv = [process.execPath, 'capture', '--require-native-app'];
      expect(CAPTURE_MODE).toBe('device_browser_prototype');
      await expect(main()).rejects.toThrow('browser prototype only');
      expect(mkdir).not.toHaveBeenCalled();
      expect(createServer).not.toHaveBeenCalled();
    } finally {
      process.argv = previous;
      mkdir.mockRestore(); createServer.mockRestore();
    }
  });

  test('parseArgs reads key/value flags and bare switches', () => {
    expect(
      parseArgs([
        'ignored-positional',
        '--host',
        '0.0.0.0',
        '--port',
        '4179',
        '--render-wait-ms',
        '600',
        '--dry-run',
      ]),
    ).toEqual({
      host: '0.0.0.0',
      port: '4179',
      'render-wait-ms': '600',
      'dry-run': '1',
    });
  });

  test('defaultOutputDir uses the UTC evidence path contract', () => {
    expect(defaultOutputDir(new Date('2026-04-17T23:59:59.999Z'))).toBe(
      path.join(
        'docs',
        'ops',
        'evidence',
        '2026-04-17',
        'mobile-fieldops',
        'ui-screenshots-native-runtime',
      ),
    );
  });

  test('mimeTypeFor maps known extensions and falls back to octet-stream', () => {
    expect(mimeTypeFor('screen.html')).toBe('text/html; charset=utf-8');
    expect(mimeTypeFor('styles.css')).toBe('text/css; charset=utf-8');
    expect(mimeTypeFor('capture.PNG')).toBe('image/png');
    expect(mimeTypeFor('asset.unknown')).toBe('application/octet-stream');
  });

  test('buildSelftest returns the required pass and fail contract fields', () => {
    expect(buildSelftest('android', 3, [], 'http://127.0.0.1:4179/version-c.html')).toEqual({
      platform: 'android',
      status: 'pass',
      url: 'http://127.0.0.1:4179/version-c.html',
      steps: [
        'Captured 3 device-browser prototype screenshots',
        'Native FieldOps application and Header/Drawer contracts were not verified',
      ],
      error: null,
    });

    expect(buildSelftest('ios', 1, ['drawer failed', 'capture failed'], 'http://127.0.0.1:4179/version-c.html')).toEqual({
      platform: 'ios',
      status: 'fail',
      url: 'http://127.0.0.1:4179/version-c.html',
      steps: [
        'Captured 1 device-browser prototype screenshots',
        'Native FieldOps application and Header/Drawer contracts were not verified',
      ],
      error: 'drawer failed | capture failed',
    });
  });

  test('normalizeAdbPngBuffer normalizes CRLF output and preserves plain buffers', () => {
    const withCrLf = Buffer.from('PNG\r\nchunk\r\n', 'binary');
    const withoutCrLf = Buffer.from('PNG\nchunk\n', 'binary');

    expect(normalizeAdbPngBuffer(withCrLf)).toEqual(Buffer.from('PNG\nchunk\n', 'binary'));
    expect(normalizeAdbPngBuffer('fallback')).toEqual(Buffer.from('fallback'));
    expect(normalizeAdbPngBuffer(withoutCrLf)).toBe(withoutCrLf);
  });

  test('createStaticServer serves the default document from the root directory', async () => {
    const { tmpDir, rootDir } = createStaticFixture();
    let server;

    try {
      server = await createStaticServer({ rootDir, host: '127.0.0.1', port: 0 });
      const { port } = server.address();
      const response = await requestServer({ port, requestPath: '/' });

      expect(response.statusCode).toBe(200);
      expect(response.headers['content-type']).toBe('text/html; charset=utf-8');
      expect(response.body.toString('utf8')).toContain('native runtime fixture');
    } finally {
      if (server) await closeServer(server);
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  test('createStaticServer does not expose files outside the root for traversal-style URLs', async () => {
    const { tmpDir, rootDir, outsideFile } = createStaticFixture();
    let server;

    try {
      server = await createStaticServer({ rootDir, host: '127.0.0.1', port: 0 });
      const { port } = server.address();
      const response = await requestServer({ port, requestPath: '/%2e%2e/secret.txt' });

      expect([403, 404]).toContain(response.statusCode);
      expect(response.body.toString('utf8')).not.toContain(fs.readFileSync(outsideFile, 'utf8'));
    } finally {
      if (server) await closeServer(server);
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});
