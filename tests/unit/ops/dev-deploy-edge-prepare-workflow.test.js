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

test.each([
  ['missing bundle', null],
  ['missing token', {}],
  ['empty token', { marketing_db_jwt: '' }],
  ['wrong role', { marketing_db_jwt: `e30.${Buffer.from('{"role":"service_role"}').toString('base64url')}.fixture` }],
])('deploy aborts before writing secrets for %s', (_label, bundle) => {
  const code = deploy.jobs.database.steps.find(step => step.id === 'deploy').run
    .match(/node <<'NODE'\n([\s\S]*?)\nNODE/)[1];
  const writeFileSync = jest.fn();
  const buildEdgeDbJwtBundle = jest.fn(() => bundle);
  const console = { log: jest.fn(), error: jest.fn() };
  const aborted = new Error('deploy aborted');
  const runtime = { env: { SUPABASE_JWT_SECRET: 'signing-fixture' }, exit: jest.fn(() => { throw aborted; }) };
  const dependencies = name => name === 'node:fs' ? { writeFileSync } : { buildEdgeDbJwtBundle };

  expect(() => new Function('require', 'console', 'process', code)(dependencies, console, runtime)).toThrow(aborted);
  expect(buildEdgeDbJwtBundle).toHaveBeenCalledWith({ secret: 'signing-fixture', includeMarketing: true });
  expect(runtime.exit).toHaveBeenCalledWith(1);
  expect(console.error).toHaveBeenCalledWith('::error::Failed to mint MARKETING_DB_JWT with the edge_marketing_role claim.');
  expect(console.log).not.toHaveBeenCalled();
  expect(writeFileSync).not.toHaveBeenCalled();
});

test('deploy writes the dedicated credential without logging it and gates function deployment on secret verification', () => {
  const run = deploy.jobs.database.steps.find(step => step.id === 'deploy').run;
  const code = run.match(/node <<'NODE'\n([\s\S]*?)\nNODE/)[1];
  const writeFileSync = jest.fn();
  const console = { log: jest.fn(), error: jest.fn() };
  const runtime = { env: { SUPABASE_JWT_SECRET: 'signing-fixture', EDGE_SECRET_FILE: 'fixture.env' } };
  const realGenerator = require('../../../scripts/ops/workspace/edge-db-jwt');
  const dependencies = name => name === 'node:fs' ? { writeFileSync } : realGenerator;
  new Function('require', 'console', 'process', code)(dependencies, console, runtime);

  const [file, contents, options] = writeFileSync.mock.calls[0];
  expect(file).toBe('fixture.env');
  expect(options).toEqual({ mode: 0o600 });
  const token = contents.match(/^MARKETING_DB_JWT=(.+)$/m)[1];
  expect(realGenerator.isJwtSignedWithSecret(token, 'signing-fixture')).toBe(true);
  const maskCommand = ['::add-mask::' + token];
  expect(console.log.mock.calls.filter(call => call.includes(maskCommand[0]))).toEqual([maskCommand]);
  const ordinaryOutput = console.log.mock.calls.filter(([line]) => !line.startsWith('::add-mask::'));
  expect(JSON.stringify(ordinaryOutput)).not.toContain(token);
  expect(console.error).not.toHaveBeenCalled();
  expect(run).toMatch(/secrets set[^\n]+\n} >\/dev\/null 2>&1 \|\| \{\n\s+echo '[^']*MARKETING_DB_JWT\.'\n\s+exit 1/);
  expect(run.indexOf('secrets list')).toBeGreaterThan(run.indexOf('secrets set'));
  expect(run.indexOf('secrets list')).toBeLessThan(run.indexOf('functions deploy'));
  expect(run).toContain('::error::Marketing token is missing from the secret list.');
});
