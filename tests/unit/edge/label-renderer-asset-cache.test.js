const fs = require('fs');
const path = require('path');
const vm = require('vm');
const ts = require('typescript');
const { AssetCache } = require('../../../supabase/functions/_shared/asset-cache');

describe('label renderer asset retention', () => {
  test('evicts the least recently used asset when the byte budget is reached', () => {
    const cache = new AssetCache(6, 10, 1000);
    const logo = new Uint8Array([1, 2]);
    cache.set('logo', logo);
    cache.set('font', new Uint8Array([3, 4, 5]));
    expect(cache.get('logo')).toBe(logo);
    cache.set('second-logo', new Uint8Array([6, 7]));
    expect(cache.get('font')).toBeUndefined();
    expect(cache.get('logo')).toBe(logo);
    expect(cache.get('second-logo')).toEqual(new Uint8Array([6, 7]));
  });

  test('caps entry count even for zero-byte assets', () => {
    const cache = new AssetCache(100, 2, 1000);
    cache.set('one', new Uint8Array());
    cache.set('two', new Uint8Array());
    cache.set('three', new Uint8Array());
    expect(cache.get('one')).toBeUndefined();
    expect(cache.get('two')).toBeDefined();
    expect(cache.get('three')).toBeDefined();
  });

  test('expires assets even when reads are frequent', () => {
    let now = 0;
    const cache = new AssetCache(100, 10, 10, () => now);
    cache.set('logo', new Uint8Array([1]));
    now = 9;
    expect(cache.get('logo')).toBeDefined();
    now = 10;
    expect(cache.get('logo')).toBeUndefined();
  });

  test('oversized assets are not retained and replacement releases previous bytes', () => {
    const cache = new AssetCache(4, 10, 1000);
    cache.set('logo', new Uint8Array([1, 2]));
    cache.set('logo', new Uint8Array([1, 2, 3, 4, 5]));
    expect(cache.get('logo')).toBeUndefined();
    cache.set('font', new Uint8Array([1, 2, 3, 4]));
    expect(cache.get('font')).toBeDefined();
    cache.delete('font');
    cache.set('next', new Uint8Array([1, 2, 3, 4]));
    expect(cache.get('next')).toBeDefined();
  });

  test('a designer refresh replaces the old cached image before rendering', async () => {
    const filename = path.resolve(__dirname, '../../../supabase/functions/label-renderer/index.ts');
    const source = fs.readFileSync(filename, 'utf8');
    const start = source.indexOf('const fetchAsset =');
    const end = source.indexOf('const resolveTemplateSnapshot =', start);
    expect(start).toBeGreaterThan(-1);
    expect(end).toBeGreaterThan(start);
    const compiled = ts.transpileModule(`${source.slice(start, end)}\nmodule.exports = fetchAsset;`, {
      compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
    }).outputText;
    const module = { exports: {} };
    const assetCache = new AssetCache();
    const storageDownloadObject = jest.fn()
      .mockResolvedValueOnce({ data: new Blob([new Uint8Array([1])]), error: null })
      .mockResolvedValueOnce({ data: new Blob([new Uint8Array([2])]), error: null });
    vm.runInNewContext(compiled, { module, exports: module.exports, assetCache, storageDownloadObject, ASSET_BUCKET: 'assets', Uint8Array, console });
    const fetchAsset = module.exports;
    expect(await fetchAsset('org/designer/logo.png')).toEqual(new Uint8Array([1]));
    expect(await fetchAsset('org/designer/logo.png', true)).toEqual(new Uint8Array([2]));
    expect(await fetchAsset('org/designer/logo.png')).toEqual(new Uint8Array([2]));
    expect(storageDownloadObject).toHaveBeenCalledTimes(2);
    expect(source).toContain('fetchAsset(path, path.startsWith(`${orgId}/`))');
  });
});
