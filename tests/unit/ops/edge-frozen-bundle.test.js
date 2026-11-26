jest.mock('node:child_process', () => ({ spawnSync: jest.fn() }));
jest.mock('../../../config/edge/functions.json', () => ({
  use_api_bundle_limit_bytes: 1024,
  functions: [{ name: 'fixture-edge', enabled: true }],
}));

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { spawnSync } = require('node:child_process');
const { spawnSync: spawnActual } = jest.requireActual('node:child_process');
const yaml = require('yaml');
const { verify } = require('../../../scripts/edge/verify-frozen-lock.cjs');

let temp;
let workdir;

beforeEach(() => {
  temp = fs.mkdtempSync(path.join(os.tmpdir(), 'edge-bundle-test-'));
  workdir = path.join(temp, 'build');
  spawnSync.mockReset();
});

afterEach(() => fs.rmSync(temp, { recursive: true }));

test('stages only the frozen Edge entry point and its verified digest', () => {
  const bundle = 'Deno.serve(() => new Response("fixture"));\n';
  const entry = 'supabase/functions/fixture-edge/index.ts';
  spawnSync.mockImplementation((_command, args) => {
    if (args[0] === 'bundle') fs.writeFileSync(args[args.indexOf('--output') + 1], bundle);
    return { status: 0 };
  });

  expect(verify(workdir)).toBe(0);
  const [command, args, options] = spawnSync.mock.calls[0];
  expect(command).toBe('deno');
  expect(args).toEqual([
    'bundle', '--frozen', '--lock=deno.lock', '--no-config', '--node-modules-dir=none',
    '--platform=deno', '--packages=bundle', '--output', path.join(workdir, entry), entry,
  ]);
  expect(options.env.DENO_DIR).not.toBe(process.env.DENO_DIR);
  expect(spawnSync.mock.calls[1]).toEqual(['deno', [
    'cache', '--no-config', '--no-lock', '--no-remote', '--no-npm', '--node-modules-dir=none', `./${entry}`,
  ], expect.objectContaining({
    cwd: workdir,
    env: expect.objectContaining({ DENO_DIR: path.join(options.env.DENO_DIR, 'offline') }),
  })]);
  expect(fs.readdirSync(path.join(workdir, 'supabase/functions/fixture-edge'))).toEqual(['index.ts']);
  expect(fs.readFileSync(path.join(workdir, entry), 'utf8')).toBe(bundle);
  const digest = createHash('sha256').update(bundle).digest('hex');
  const config = fs.readFileSync(path.join(workdir, 'supabase/config.toml'));
  const configDigest = createHash('sha256').update(config).digest('hex');
  expect(fs.readFileSync(path.join(workdir, 'SHA256SUMS'), 'utf8')).toBe(
    `${digest}  ${entry}\n${configDigest}  supabase/config.toml\n`,
  );
});

test('a rejected frozen build leaves no deployable Edge checksum manifest', () => {
  spawnSync.mockReturnValue({ status: 1, stderr: 'error: fixture integrity mismatch' });

  expect(verify(workdir)).toBe(1);
  expect(fs.existsSync(path.join(workdir, 'SHA256SUMS'))).toBe(false);
  expect(fs.existsSync(path.join(workdir, 'supabase/config.toml'))).toBe(false);
});

test('a failed offline resolution leaves no manifest', () => {
  spawnSync.mockImplementationOnce((_command, args) => {
    fs.writeFileSync(args[args.indexOf('--output') + 1], 'void import("npm:fixture-package");\n');
    return { status: 0 };
  }).mockReturnValueOnce({ status: 1, stderr: 'error: npm imports are disabled' });

  expect(verify(workdir)).toBe(1);
  expect(fs.existsSync(path.join(workdir, 'SHA256SUMS'))).toBe(false);
});

test.each([
  ['accepts node specifiers', 'import "node:fs"; void import("node:path"); export * from "node:os";', 0],
  ['rejects npm specifiers', 'void import("npm:fixture-package");', 1],
  ['rejects jsr specifiers', 'void import("jsr:@fixture/package");', 1],
  ['rejects relative import declarations', 'import "./fixture.ts";', 1],
  ['rejects relative dynamic imports', 'void import("./fixture.ts");', 1],
  ['rejects non-literal dynamic imports', 'const specifier = "node:fs"; void import(specifier);', 1],
  ['rejects external re-exports', 'export * from "./fixture.ts";', 1],
])('the frozen Edge bundle import check %s', (_description, source, status) => {
  const checker = path.resolve(__dirname, '../../../scripts/edge/check-frozen-bundle-imports.cjs');
  const fixture = path.join(temp, 'bundle.ts');
  fs.writeFileSync(fixture, source);

  const result = spawnActual(process.execPath, [checker, fixture], { encoding: 'utf8' });
  expect(result.status).toBe(status);
  expect(result.stderr.trimEnd()).toBe(status === 0 ? '' : `Unbundled Edge import in ${fixture}:1`);
});

test('DEV checks the bundle manifest before writes and limits the upload to that workdir', () => {
  const workflow = yaml.parse(fs.readFileSync(path.resolve(__dirname, '../../../.github/workflows/deploy.yml'), 'utf8'));
  const { database } = workflow.jobs;
  const deploy = database.steps.find(step => step.id === 'deploy');
  expect(database.env.EDGE_FROZEN_WORKDIR).toBeTruthy();
  expect(deploy.if).toContain("steps.edge_lock.outcome == 'success'");
  const verify = deploy.run.indexOf('bash scripts/edge/verify-frozen-manifest.sh');
  expect(verify).toBeGreaterThan(-1);
  expect(verify).toBeLessThan(deploy.run.indexOf(' db push '));
  const manifest = deploy.run.indexOf('mapfile -t edge_deploy < edge-deploy.tsv');
  const recheck = deploy.run.lastIndexOf('bash scripts/edge/verify-frozen-manifest.sh');
  expect(manifest).toBeGreaterThan(verify);
  expect(manifest).toBeLessThan(deploy.run.indexOf(' db push '));
  expect(recheck).toBeGreaterThan(deploy.run.indexOf(' db push '));
  expect(recheck).toBeLessThan(deploy.run.indexOf(' functions deploy '));
  expect(deploy.run).toMatch(/functions deploy[^\n]*--workdir "\$EDGE_FROZEN_WORKDIR"/);

  const dryRunSelfCheck = workflow.jobs['database-dry-run'].steps.find(step => step.name === 'Self-check Edge frozen lock drift');
  expect(dryRunSelfCheck.run).toMatch(/^env -u EDGE_FROZEN_WORKDIR node /);
});
