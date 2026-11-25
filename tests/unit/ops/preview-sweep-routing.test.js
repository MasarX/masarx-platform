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

test('ignores unrelated changes and runs the capture when the selector output is missing', () => {
  const unrelated = ['DESIGN.md', 'apps/fieldops/App.tsx', 'apps/landing/src/site.ts', 'tests/ui/table.test.tsx'];
  const affected = [...unrelated, 'apps/portal/app/page.tsx'];
  expect(selectPreviewSweep(affected)).toBe(true);
  expect(selectPreviewSweep(unrelated)).toBe(false);
  expect(selectPreviewSweep()).toBe(true);
});
