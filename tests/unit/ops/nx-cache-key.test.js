const fs = require('fs');
const os = require('os');
const path = require('path');

const {
  computeNxCacheKey,
  resolveNxCacheInputFiles,
} = require('../../../scripts/ops/ci/nx-cache-key');

describe('nx-cache-key', () => {
  let tempRoot;

  beforeEach(() => {
    tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'masarx-nx-cache-key-'));
  });

  afterEach(() => {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  });

  function write(relativePath, content) {
    const fullPath = path.join(tempRoot, relativePath);
    fs.mkdirSync(path.dirname(fullPath), { recursive: true });
    fs.writeFileSync(fullPath, content, 'utf8');
  }

  test('resolves the tracked Nx cache input files in stable sorted order', () => {
    write('package-lock.json', '{"name":"root"}\n');
    write('nx.json', '{"extends":"nx/presets/npm.json"}\n');
    write('apps/console/package.json', '{"name":"console"}\n');
    write('packages/ui/package.json', '{"name":"ui"}\n');
    write('apps/console/node_modules/ignored/package.json', '{"name":"ignored"}\n');

    const files = resolveNxCacheInputFiles(tempRoot).map((entry) => entry.relativePath);

    expect(files).toEqual([
      'apps/console/package.json',
      'nx.json',
      'package-lock.json',
      'packages/ui/package.json',
    ]);
  });

  test('changes the cache key when an input manifest changes', () => {
    write('package-lock.json', '{"name":"root"}\n');
    write('nx.json', '{"extends":"nx/presets/npm.json"}\n');
    write('apps/console/package.json', '{"name":"console"}\n');

    const first = computeNxCacheKey(tempRoot);
    write('apps/console/package.json', '{"name":"console","version":"2.0.0"}\n');
    const second = computeNxCacheKey(tempRoot);

    expect(first.fileCount).toBe(3);
    expect(second.fileCount).toBe(3);
    expect(first.cacheKey).not.toBe(second.cacheKey);
  });

  test('returns a deterministic placeholder key when no tracked inputs exist', () => {
    const first = computeNxCacheKey(tempRoot);
    const second = computeNxCacheKey(tempRoot);

    expect(first.fileCount).toBe(0);
    expect(first.cacheKey).toBe(second.cacheKey);
  });
});
