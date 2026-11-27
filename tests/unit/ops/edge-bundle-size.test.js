jest.mock('node:child_process', () => ({ spawnSync: jest.fn() }));
jest.mock('../../../config/edge/functions.json', () => ({
  functions: [
    { name: 'fixture-large', enabled: true },
    { name: 'fixture-small', enabled: true },
  ],
}));

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const registry = require('../../../config/edge/functions.json');
const { verify } = require('../../../scripts/edge/verify-frozen-lock.cjs');

let temp;
let workdir;
let summary;

beforeEach(() => {
  temp = fs.mkdtempSync(path.join(os.tmpdir(), 'edge-bundle-size-test-'));
  workdir = path.join(temp, 'build');
  summary = path.join(temp, 'summary.md');
  spawnSync.mockReset().mockImplementation((_command, args) => {
    if (args[0] === 'bundle') {
      const content = args.at(-1).includes('/fixture-large/') ? '\u00e9\u00e9\u00e9x' : 'ok\n';
      fs.writeFileSync(args[args.indexOf('--output') + 1], content);
    }
    return { status: 0 };
  });
});

afterEach(() => fs.rmSync(temp, { recursive: true }));

function expectMeasurements(limitBytes) {
  const markdown = fs.readFileSync(summary, 'utf8');
  const [, json] = markdown.match(/```json\n([\s\S]*?)\n```/);
  expect(JSON.parse(json)).toEqual([
    { name: 'fixture-large', sizeBytes: 7, limitBytes },
    { name: 'fixture-small', sizeBytes: 3, limitBytes },
  ]);
}

test.each([7, 8])('accepts each generated bundle at or below a %i-byte limit', limitBytes => {
  registry.use_api_bundle_limit_bytes = limitBytes;

  expect(verify(workdir, summary)).toBe(0);
  expectMeasurements(limitBytes);
  expect(fs.existsSync(path.join(workdir, 'SHA256SUMS'))).toBe(true);
});

test('rejects an oversized bundle by name, reports all sizes and leaves no manifest', () => {
  registry.use_api_bundle_limit_bytes = 6;

  expect(() => verify(workdir, summary)).toThrow(/fixture-large: 7 bytes \(limit 6 bytes\)/);
  expectMeasurements(6);
  expect(fs.existsSync(path.join(workdir, 'SHA256SUMS'))).toBe(false);
});

test.each([undefined, 0, -1, 1.5, '7', Number.MAX_SAFE_INTEGER + 1])(
  'rejects a missing or invalid bundle limit (%p) before invoking Deno', limitBytes => {
    if (limitBytes === undefined) delete registry.use_api_bundle_limit_bytes;
    else registry.use_api_bundle_limit_bytes = limitBytes;

    expect(() => verify(workdir, summary)).toThrow(/use_api_bundle_limit_bytes must be a positive safe integer/);
    expect(spawnSync).not.toHaveBeenCalled();
  },
);
