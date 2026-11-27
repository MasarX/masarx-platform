const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const yaml = require('yaml');

const root = path.resolve(__dirname, '../../..');
const deploy = yaml.parse(fs.readFileSync(path.join(root, '.github/workflows/deploy.yml'), 'utf8'));
const version = fs.readFileSync(path.join(root, '.nvmrc'), 'utf8').trim();
const install = deploy.jobs['database-dry-run'].steps.find(step =>
  step.name === 'Install pinned Node.js for Edge preparation',
);
const stubs = [
  "curl() { printf 'curl-argument=%s\\n' \"$@\"; }",
  'sha256sum() { cat >/dev/null; }',
  'tar() { :; }',
].join('\n');

function runInstall(versionFile) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dev-dry-run-node-'));
  try {
    fs.writeFileSync(path.join(dir, '.nvmrc'), versionFile);
    const result = spawnSync('bash', ['--noprofile', '--norc', '-e', '-o', 'pipefail', '-c', `${stubs}\n${install.run}`], {
      cwd: dir,
      env: { ...process.env, BASH_ENV: '', RUNNER_TEMP: '.', GITHUB_PATH: 'github-path' },
      encoding: 'utf8',
      timeout: 5000,
      windowsHide: true,
    });
    expect(result.error).toBeUndefined();
    return result;
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

test.each([['CRLF', '\r\n'], ['LF', '\n']])('downloads the pinned Node URL for a %s version file', (_label, ending) => {
  const result = runInstall(version + ending);
  const expected = `https://nodejs.org/dist/v${version}/node-v${version}-linux-x64.tar.xz`;

  expect(result.status).toBe(0);
  expect(result.stdout.split('\n')).toContain(`curl-argument=${expected}`);
});

test('rejects a malformed Node version before invoking curl', () => {
  const result = runInstall('not-a-version\n');

  expect(result.status).toBe(1);
  expect(result.stdout).toContain('Expected an exact Node.js version in .nvmrc.');
  expect(result.stdout).not.toContain('curl-argument=');
});
