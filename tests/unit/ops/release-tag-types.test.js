const { execFileSync, spawnSync } = require('node:child_process');
const { mkdtempSync, readFileSync, rmSync } = require('node:fs');
const { tmpdir } = require('node:os');
const { join, resolve } = require('node:path');
const { parse } = require('yaml');

const workflow = parse(readFileSync(resolve(__dirname, '../../../.github/workflows/provenance-on-tag.yml'), 'utf8'));
const { verify, build } = workflow.jobs;
const tagChecks = verify.steps.find(step => step.id === 'verify').run.split('\nif ! sha=')[0];
const bash = process.platform === 'win32' ? join(process.env.ProgramFiles, 'Git', 'bin', 'bash.exe') : 'bash';
let repo;

function git(...args) {
  return execFileSync('git', args, { cwd: repo, encoding: 'utf8', windowsHide: true }).trim();
}

beforeAll(() => {
  repo = mkdtempSync(join(tmpdir(), 'release-tag-fixture-'));
  git('init', '--initial-branch=main');
  git('-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', '-c', 'commit.gpgsign=false',
    'commit', '--allow-empty', '-m', 'fixture');
  git('update-ref', 'refs/remotes/origin/main', 'HEAD');
});

afterAll(() => {
  if (repo) rmSync(repo, { recursive: true, force: true });
});

test.each([
  ['a version tag', 'v0.2.0', true, 0, 'kind=version'],
  ['a release-candidate tag', 'v0.2.0-rc.1', true, 0, 'kind=rc'],
  ['a lightweight tag', 'v0.2.1', false, 1, 'requires an annotated tag'],
  ['a version with a leading zero', 'v00.2.0', true, 1, 'requires a version tag or a numbered release-candidate tag'],
  ['an unnumbered candidate', 'v0.2.0-rc', true, 1, 'requires a version tag or a numbered release-candidate tag'],
])('checks and classifies %s', (_label, tag, annotated, status, output) => {
  git('-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', '-c', 'tag.gpgSign=false',
    'tag', ...(annotated ? ['-a', tag, '-m', 'fixture tag'] : [tag]));
  const result = spawnSync(bash, ['-c', `${tagChecks}\nprintf 'kind=%s\\n' "$kind"`], {
    cwd: repo,
    encoding: 'utf8',
    env: { ...process.env, GITHUB_REF: `refs/tags/${tag}`, GITHUB_REF_NAME: tag },
    windowsHide: true,
  });
  expect(result.error).toBeUndefined();
  expect(result.status).toBe(status);
  expect(result.stdout).toContain(output);
});

test('routes the attested candidate archive separately from version publication', () => {
  const attestation = build.steps.findIndex(step => step.uses?.startsWith('actions/attest-build-provenance@'));
  const staging = build.steps.findIndex(step => step.uses?.startsWith('actions/upload-artifact@'));
  expect(attestation).toBeGreaterThanOrEqual(0);
  expect(staging).toBeGreaterThan(attestation);
  expect(verify.outputs.kind).toBe('${{ steps.verify.outputs.kind }}');
  expect(verify.steps.find(step => step.id === 'verify').run).toContain(`printf 'kind=%s\\n' "$kind" >> "$GITHUB_OUTPUT"`);
  expect(build.steps[staging]).toMatchObject({
    if: "needs.verify.outputs.kind == 'rc'",
    with: { name: 'landing-${{ github.ref_name }}', path: 'release/', 'if-no-files-found': 'error' },
  });
  expect(build.steps.at(-1).if).toBe("needs.verify.outputs.kind == 'version'");
});
