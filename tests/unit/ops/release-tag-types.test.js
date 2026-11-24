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

const formatError = 'requires a version tag or a numbered release-candidate tag';

test.each([
  ['a version tag', 'v0.2.0', true, 0, 'kind=version'],
  ['a release-candidate tag', 'v0.2.0-rc.1', true, 0, 'kind=rc'],
  ['a lightweight tag', 'v0.2.1', false, 1, 'requires an annotated tag'],
  ['a version with a leading zero', 'v00.2.0', true, 1, formatError],
  ['an unnumbered candidate', 'v0.2.0-rc', true, 1, formatError],
  ['a candidate numbered zero', 'v0.2.0-rc.0', true, 1, formatError],
  ['a candidate number with a leading zero', 'v0.2.0-rc.01', true, 1, formatError],
  ['a beta tag', 'v0.2.0-beta.1', true, 1, formatError],
  ['a four-part version', 'v0.2.0.1', true, 1, formatError],
  ['a lightweight candidate tag', 'v0.2.0-rc.2', false, 1, 'requires an annotated tag'],
  ['a branch named like a tag', 'v0.2.2', true, 1, 'requires a v* tag ref', { ref: 'refs/heads/v0.2.2' }],
  ['a mismatch between ref and ref name', 'v0.2.3', true, 1, formatError, { refName: 'v0.2.4' }],
  ['an annotation with a different tag name', 'v0.2.5', true, 1, 'Annotated tag name must match',
    { ref: 'refs/tags/v0.2.6', refName: 'v0.2.6' }],
])('checks and classifies %s', (_label, tag, annotated, status, output, overrides = {}) => {
  const { ref = `refs/tags/${tag}`, refName = tag } = overrides;
  git('-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', '-c', 'tag.gpgSign=false',
    'tag', ...(annotated ? ['-a', tag, '-m', 'fixture tag'] : [tag]));
  if (ref !== `refs/tags/${tag}`) {
    git('update-ref', ref, git('rev-parse', ref.startsWith('refs/heads/') ? 'HEAD' : `refs/tags/${tag}`));
  }
  const result = spawnSync(bash, ['-e', '-o', 'pipefail', '-c', `${tagChecks}\nprintf 'kind=%s\\n' "$kind"`], {
    cwd: repo,
    encoding: 'utf8',
    env: { ...process.env, GITHUB_REF: ref, GITHUB_REF_NAME: refName },
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
