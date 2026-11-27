const { readFileSync } = require('node:fs');
const { resolve } = require('node:path');
const { select, selectPreviewSweep } = require('../../../scripts/ci-hosted/changes.cjs');

test('selects preview inputs within the existing UI job', () => {
  for (const file of [
    'apps/console/app/page.tsx',
    'apps/console-v2/src/App.tsx',
    'apps/portal/app/page.tsx',
    'apps/shared/app-layout.tsx',
    'packages/ui/src/theme.tsx',
    'config/dev/sweep-roles.json',
    'tests/preview-sweep/signed-in.spec.cjs',
    'scripts/ci-hosted/preview-sweep.config.cjs',
  ]) {
    expect(select([file]).ui).toBe(true);
    expect(selectPreviewSweep([file])).toBe(true);
  }
});

test('selects only the UI job for changes under tests/preview-sweep/', () => {
  const affected = select(['tests/preview-sweep/additional-capture.spec.cjs']);
  expect(Object.keys(affected).filter(job => affected[job])).toEqual(['ui']);
});

test('ignores unrelated changes and runs the capture when the selector output is missing', () => {
  const unrelated = ['DESIGN.md', 'apps/fieldops/App.tsx', 'apps/landing/src/site.ts', 'tests/ui/table.test.tsx'];
  const affected = [...unrelated, 'apps/portal/app/page.tsx'];
  expect(selectPreviewSweep(affected)).toBe(true);
  expect(selectPreviewSweep(unrelated)).toBe(false);
  expect(selectPreviewSweep()).toBe(true);
});

test('admits only fixed cell keys and numeric geometry in the preview workflow log', () => {
  const workflow = readFileSync(resolve(__dirname, '../../../.github/workflows/public-ci.yml'), 'utf8');
  const [, pattern] = workflow.match(/-e '\/(\^SWEEP-GEOM .+\$)\/p'/);
  const filter = new RegExp(pattern);
  const line = 'SWEEP-GEOM console-v2 ar dark phone empty 390 844 -42.125 100.000 960.000 60.000 0.406250000';
  expect(line).toMatch(filter);
  expect(line.replace('0.406250000', '1.000000000')).toMatch(filter);
  for (const rejected of [
    line + ' extra',
    line.replace('console-v2', 'custom'),
    line.replace('390', 'https://example.com'),
    line.replace('0.406250000', '1.100000000'),
  ]) expect(rejected).not.toMatch(filter);
});

test('keeps marker failure reasons while dropping DOM details and call logs', () => {
  const workflow = readFileSync(resolve(__dirname, '../../../.github/workflows/public-ci.yml'), 'utf8');
  const rules = [...workflow.matchAll(/-e 's\/(\^SWEEP-ERROR [^/]+)\/([^/]+)\/p'/g)];
  const messages = [
    'expect(locator).toBeVisible() failed',
    'Error: strict mode violation: getByTestId("portal-resource-error") resolved to 2 elements:',
    '    1) <p>Synthetic recipient</p>',
    'Timeout:  15000ms',
    '  - Target page, context or browser has been closed',
    '  - waiting for getByText("Synthetic recipient")',
    'Received: <element(s) not found>',
  ];
  const output = messages.flatMap(message => rules.flatMap(([, pattern, replacement]) => {
    const match = new RegExp(pattern).exec('SWEEP-ERROR ' + message);
    return match ? [replacement.replace(/\\([0-9])/g, (_, group) => match[Number(group)])] : [];
  }));
  expect(output).toEqual([
    'SWEEP-ERROR expect(locator).toBeVisible() failed',
    'SWEEP-ERROR strict mode violation: resolved to 2 elements',
    'SWEEP-ERROR Timeout:  15000ms',
    'SWEEP-ERROR Target page, context or browser has been closed',
  ]);
});
