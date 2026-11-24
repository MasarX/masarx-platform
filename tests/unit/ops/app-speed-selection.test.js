const { select } = require('../../../scripts/ci-hosted/changes.cjs');

test.each([
  ['apps/console-v2/src/App.tsx', ['build_console']],
  ['apps/portal/app/tracking/page.tsx', ['build_portal']],
  ['packages/ui/src/tracking-page.tsx', ['build_console', 'build_portal']],
  ['tests/speed-e2e/measure-speed.ts', ['build_console', 'build_portal']],
  ['DESIGN.md', ['build_console', 'build_portal', 'e2e']],
  ['scripts/frontend/design-speed-budgets.cjs', ['build_console', 'build_portal', 'e2e']],
])('selects the budget jobs for %s', (file, gates) => {
  const affected = select([file]);
  for (const gate of gates) expect(affected[gate]).toBe(true);
});
