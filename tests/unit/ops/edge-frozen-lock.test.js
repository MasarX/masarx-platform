const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const yaml = require('yaml');

const root = path.resolve(__dirname, '../../..');
const script = 'scripts/edge/verify-frozen-lock.cjs';
const name = 'fixture-edge';
const npmEntry = 'qrcode-generator@1.5.2';
const deno = spawnSync('deno', ['--version'], { stdio: 'ignore' });
const withDeno = deno.error?.code === 'ENOENT' ? test.skip : test;

test.each(['database', 'database-dry-run'])('%s checks the prepared Edge tree before using DEV credentials', jobName => {
  const workflow = yaml.parse(fs.readFileSync(path.join(root, '.github/workflows/deploy.yml'), 'utf8'));
  const job = workflow.jobs[jobName];
  const gate = job.steps.find(step => step.name === 'Verify Edge frozen lock');
  const install = job.steps.find(step => step.name === 'Install pinned Deno');
  const before = job.steps.slice(0, job.steps.indexOf(gate));
  const prepare = before.find(step => step.run?.includes('npm run edge:sync-shared'));
  const dev = job.steps.find(step => step.id === 'deploy' || step.id === 'measure');

  expect(gate.run).toBe(`node ${script}`);
  expect(gate.env).toBeUndefined();
  expect(gate['continue-on-error']).toBeUndefined();
  expect(workflow.permissions).toEqual({ contents: 'read' });
  expect(before).toContain(install);
  expect(install.run).toMatch(/\/v2\.9\.6\/deno-.*\.zip/);
  expect(install.run).toContain('sha256sum --check');
  expect(prepare.run).toContain('npm run edge:sync-shared\nnpm run edge:prepare-resource-import-exceljs');
  expect(job.steps.indexOf(dev)).toBeGreaterThan(job.steps.indexOf(gate));
  expect(dev.run).toContain(' link --project-ref ');
  expect(dev.run).toContain(' db push ');
  expect(JSON.stringify([workflow.env, job.env, ...before.filter(step => step.id !== 'guard')]))
    .not.toMatch(/\bsecrets\./);
  if (jobName === 'database') {
    const probe = before.find(step => step.id === 'guard');
    expect(Object.entries(probe.env)).toEqual([
      ['CONFIGURED', expect.stringMatching(/^\$\{\{ (?:secrets\.[A-Z_]+ != '' && ){3}vars\.[A-Z_]+ != '' \}\}$/)],
    ]);
    expect(gate.if).toBe(prepare.if);
    expect(dev.if).toContain(`steps.${gate.id}.outcome == 'success'`);
    expect(dev.run).toContain(' functions deploy ');
  } else {
    expect(gate.if).toBeUndefined();
    expect(dev.if).toBeUndefined();
    expect(JSON.stringify(before)).not.toMatch(/\bsecrets\./);
  }
});

withDeno.each([
  ['clean lock', () => {}, null],
  ['missing npm entry', lock => { delete lock.npm[npmEntry]; }, /Could not find 'qrcode-generator@1\.5\.2' in the list of packages/],
  ['changed integrity hash', lock => {
    lock.npm[npmEntry].integrity = 'sha512-' + Buffer.alloc(64).toString('base64');
  }, /Tarball checksum did not match/],
])('checks the frozen Edge lock with a %s', (_label, changeLock, errorPattern) => {
  const fixture = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'edge-lock-test-'));
  const write = (file, contents) => {
    const target = path.join(fixture, file);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, contents);
  };
  try {
    write(script, fs.readFileSync(path.join(root, script)));
    write('config/edge/functions.json', JSON.stringify({ functions: [
      { name, enabled: true },
      { name: 'fixture-disabled', enabled: false },
    ] }));
    write(`supabase/functions/${name}/index.ts`, 'import "fixture-import";\n');
    write(`supabase/functions/${name}/deno.json`, JSON.stringify({
      imports: { 'fixture-import': `npm:${npmEntry}` },
    }));
    const lock = JSON.parse(fs.readFileSync(path.join(root, 'deno.lock'), 'utf8'));
    changeLock(lock);
    write('deno.lock', JSON.stringify(lock, null, 2) + '\n');

    const result = spawnSync(process.execPath, [script], {
      cwd: fixture, encoding: 'utf8', timeout: 20000,
    });
    expect(result.error).toBeUndefined();
    if (errorPattern) {
      expect(result.stderr).toMatch(new RegExp(`^${name}: error:`, 'm'));
      expect(result.stderr).toMatch(errorPattern);
      expect(result.status).toBeGreaterThan(0);
    } else {
      expect(result.stderr).toBe('');
      expect(result.stdout).toContain('Enabled functions: 1.');
      expect(result.status).toBe(0);
    }
  } finally {
    fs.rmSync(fixture, { recursive: true });
  }
});
