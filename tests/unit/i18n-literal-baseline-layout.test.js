const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { check, readBaseline } = require('../../scripts/tooling/i18n-literal-guard');

const geocoding = 'apps/console-v2/src/modules/network/geocoding.tsx';
const zones = 'apps/console-v2/src/modules/network/zones.tsx';
const marketplace = 'apps/console-v2/src/modules/network/marketplace.tsx';
const finding = { line: 3, kind: 'jsx-text', text: 'Shipments' };

describe('split i18n literal baseline', () => {
  let dir;

  function addAllowance(source, count) {
    const file = path.join(dir, source + '.txt');
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, `${source} ${count}\n`);
  }

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'i18n-literal-baseline-'));
    addAllowance(geocoding, 1);
    addAllowance(zones, 2);
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  test('allows two screens in the same module to remove their allowances independently', () => {
    const current = new Map([[geocoding, [finding]], [zones, [finding, finding]]]);
    expect(check(current, readBaseline(dir))).toEqual([]);

    fs.unlinkSync(path.join(dir, geocoding + '.txt'));
    current.delete(geocoding);
    expect(check(current, readBaseline(dir))).toEqual([]);
    expect(readBaseline(dir).entries).toEqual(new Map([[zones, 2]]));

    fs.unlinkSync(path.join(dir, zones + '.txt'));
    current.delete(zones);
    expect(check(current, readBaseline(dir))).toEqual([]);
  });

  test('rejects an unlisted screen, an over-count and a leftover allowance across files', () => {
    const current = new Map([[geocoding, [finding, finding]], [marketplace, [finding]]]);
    expect(check(current, readBaseline(dir))).toEqual([
      `${geocoding}: 2 literals, baseline allows 1; move the new ones to the catalogs`,
      `${marketplace}: 1 new literal(s); move them to the catalogs. First: line 3 "Shipments"`,
      `${zones}: no literals left; delete its baseline line`,
    ]);
  });

  test('rejects a source listed in two allowance files', () => {
    const duplicate = path.join(dir, marketplace + '.txt');
    fs.writeFileSync(duplicate, `${geocoding} 3\n`);
    expect(readBaseline(dir).problems).toEqual([
      `baseline lists ${geocoding} twice (also in ${path.relative(dir, duplicate)})`,
    ]);
  });
});
