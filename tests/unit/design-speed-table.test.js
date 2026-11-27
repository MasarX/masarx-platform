// The DESIGN.md speed table must give every core web screen a usable state,
// an LCP and INP p75 budget, a tolerance and a timed journey (#301).
const { readSpeedBudgets } = require('../../scripts/frontend/design-speed-budgets.cjs');

const CORE_WEB_ROUTES = [
  '/',
  '/track/',
  '/operate/shipments',
  '/operate/dispatch',
  '/operate/exceptions',
  '/operate/pickups',
  '/operate/tracking-map',
  '/finance/cod',
  '/tracking',
];

const HEADER = [
  '### Speed',
  '',
  '| Screen | Visible and interactive at usable | May still show “updating” | Target time to usable | Agreed tolerance | Timed journey and previous result |',
  '| --- | --- | --- | --- | --- | --- |',
].join('\n');

describe('DESIGN.md speed table', () => {
  const rows = readSpeedBudgets();

  it('has a row for each core web screen', () => {
    const routes = rows.map((row) => row.route);
    for (const route of CORE_WEB_ROUTES) expect(routes).toContain(route);
  });

  it('keeps LCP at or under 2.5 s and INP at or under 200 ms at p75', () => {
    for (const row of rows) {
      expect({ screen: row.screen, lcpOk: row.lcpMs <= 2500, inpOk: row.inpMs <= 200 }).toEqual({
        screen: row.screen,
        lcpOk: true,
        inpOk: true,
      });
    }
  });

  it('has at least one row measured by the landing speed spec', () => {
    expect(rows.some((row) => row.spec === 'landing-speed-p75')).toBe(true);
  });

  it('rejects a TBD row with its screen name', () => {
    const markdown = `${HEADER}\n| Landing \`/\` | TBD | Nothing | LCP ≤ 2.5 s, INP ≤ 200 ms at p75 | +10% | Load |\n`;
    expect(() => readSpeedBudgets(markdown)).toThrow('speed row "Landing `/`": usable is blank or TBD');
  });

  it('rejects a row without parseable budgets', () => {
    const markdown = `${HEADER}\n| Landing \`/\` | Hero | Nothing | Fast | +10% | Load |\n`;
    expect(() => readSpeedBudgets(markdown)).toThrow('needs a `route`, "LCP ≤ n s", "INP ≤ n ms"');
  });
});
