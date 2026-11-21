const fs = require('node:fs');
const path = require('node:path');
const yaml = require('yaml');

const workflow = name => yaml.parse(fs.readFileSync(path.resolve(__dirname, '../../../.github/workflows', name), 'utf8'));
const deploy = workflow('deploy.yml');
const ci = workflow('public-ci.yml');
const edgeCommands = step => step.run.match(/^npm run edge:[^\n]+$/gm);

test('installs the root lockfile with scripts disabled before preparing deploy edge packages', () => {
  const steps = deploy.jobs.database.steps;
  const install = steps.find(step => step.name === 'Install locked edge dependencies');
  const prepare = steps.find(step => step.name === 'Prepare edge packages and pinned CLI');
  expect(install).toMatchObject({
    if: prepare.if,
    'working-directory': '${{ github.workspace }}',
    run: expect.stringContaining('npm ci --ignore-scripts --no-audit --no-fund &&'),
  });
  expect(deploy.env.NPM_CONFIG_IGNORE_SCRIPTS).toBe('true');
  expect(steps.indexOf(install)).toBeLessThan(steps.indexOf(prepare));
  expect(edgeCommands(prepare)).toEqual([
    'npm run edge:sync-shared',
    'npm run edge:prepare-resource-import-exceljs',
  ]);
});

test('runs the deploy edge commands after the locked install in the existing CI lint job', () => {
  const steps = ci.jobs.lint.steps;
  const install = steps.find(step => step.id === 'install');
  const check = steps.find(step => step.name === 'Check deploy edge preparation');
  const prepare = deploy.jobs.database.steps.find(step => step.name === 'Prepare edge packages and pinned CLI');
  expect(install.run).toBe('node scripts/ci-hosted/tasks.cjs install');
  expect(check.if).toBe(install.if);
  expect(ci.env.NPM_CONFIG_IGNORE_SCRIPTS).toBe('true');
  expect(steps.indexOf(install)).toBeLessThan(steps.indexOf(check));
  expect(edgeCommands(check)).toEqual(edgeCommands(prepare));
});
