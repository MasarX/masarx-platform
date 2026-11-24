const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const yaml = require('yaml');

const body = fs.readFileSync(path.resolve(__dirname, '../../../.github/workflows/provenance-on-tag.yml'), 'utf8');
const workflow = yaml.parse(body);
const { verify, build } = workflow.jobs;
const gate = verify.steps.find(step => step.id === 'verify').run;
const sharedPath = 'scripts/deploy/require-ci-gate.sh';
const sharedGate = fs.readFileSync(path.resolve(__dirname, '../../../', sharedPath), 'utf8');

function git(repo, ...args) {
  const result = spawnSync('git', args, { cwd: repo, encoding: 'utf8', timeout: 10000, windowsHide: true });
  if (result.status !== 0) throw new Error(result.error?.message || result.stderr.trim());
  return result.stdout.trim();
}

function jq(args, input) {
  return spawnSync('jq', args, { input, encoding: 'utf8', timeout: 10000, windowsHide: true });
}

describe('release workflow contract', () => {
  test('runs only on version tag pushes', () => {
    expect(workflow.on).toEqual({ push: { tags: ['v*'] } });
    expect(workflow.on.workflow_dispatch).toBeUndefined();
    expect(workflow.concurrency).toEqual({
      group: 'release-${{ github.ref }}',
      'cancel-in-progress': false,
    });
    expect(gate).toContain('"$GITHUB_REF" != refs/tags/v*');
  });

  test('gives the two bounded jobs only the permissions they use', () => {
    expect(workflow.permissions).toEqual({ contents: 'read' });
    expect(Object.keys(workflow.jobs)).toEqual(['verify', 'build']);
    expect(verify.permissions).toEqual({ contents: 'read', checks: 'read', actions: 'read' });
    expect(build.permissions).toEqual({ contents: 'write', 'id-token': 'write', attestations: 'write' });
    for (const job of [verify, build]) {
      expect(job.strategy).toBeUndefined();
      expect(job['timeout-minutes']).toBeGreaterThan(0);
    }
  });

  test('binds the build and public CI queries to the verified tag commit', () => {
    expect(gate).toContain('git rev-parse --verify "$GITHUB_REF^{commit}"');
    expect(gate).toContain('"$sha" != "$(git rev-parse HEAD)"');
    expect(gate).toContain(`bash ${sharedPath} "$GITHUB_REPOSITORY" "$sha"`);
    expect(verify.steps[0].with['sparse-checkout'].split('\n')).toContain(sharedPath);
    expect(sharedGate).toContain('actions/workflows/public-ci.yml/runs?head_sha=$sha');
    expect(sharedGate).toContain('commits/$sha/check-runs?check_name=ci-gate&filter=all');
    expect(build.needs).toBe('verify');
    expect(build.steps[0].with.ref).toBe('${{ needs.verify.outputs.sha }}');
  });

  test('pins GitHub-owned actions and attests the artifact before publishing', () => {
    const actions = [verify, build].flatMap(job => job.steps.filter(step => step.uses));
    for (const { uses } of actions) {
      expect(uses).toMatch(/^(actions|github)\/[\w/-]+@[a-f0-9]{40}$/);
      expect(body.split('\n').find(line => line.includes(uses))).toMatch(/ # v\d/);
    }
    const attest = build.steps.find(step => step.uses?.startsWith('actions/attest-build-provenance@'));
    expect(attest?.with['subject-checksums']).toBe('release/SHA256SUMS');
    const publish = build.steps.at(-1);
    expect(build.steps.indexOf(attest)).toBeLessThan(build.steps.indexOf(publish));
    expect(publish.run).toContain('"$current_sha" != "$RELEASE_SHA"');
    expect(publish.run).toContain('gh release create "$RELEASE_TAG" release/landing.tar.gz release/SHA256SUMS');
    expect(publish.run).toContain('--verify-tag');
  });

  test('normalizes archive order, ownership and timestamps before checksumming', () => {
    const pack = build.steps.find(step => step.run?.includes('sha256sum landing.tar.gz'));
    expect(pack.run).toContain('git show -s --format=%ct HEAD');
    expect(pack.run).toContain('tar --sort=name --mtime="@$commit_time" --owner=0 --group=0 --numeric-owner');
    expect(pack.run).toContain('gzip -n > release/landing.tar.gz');
    expect(pack.run).toContain('sha256sum landing.tar.gz > SHA256SUMS');
  });

  test('avoids deployment, environment bindings and repository secrets', () => {
    expect(body.replaceAll(sharedPath, 'require-ci-gate.sh'))
      .not.toMatch(/\b(?:deploy(?:ment)?|npm\s+publish|gh-pages|pages\s+deploy|vercel|cloudflare|wrangler|secrets)\b|^\s*environment:/im);
    const tokenBindings = [verify, build].flatMap(job => job.steps.map(step => step.env?.GH_TOKEN).filter(Boolean));
    expect(tokenBindings).toEqual(['${{ github.token }}', '${{ github.token }}']);
  });
});

describe('release admission behavior', () => {
  test('accepts the main merge commit and rejects its PR-branch parent', () => {
    const command = gate.match(/^if ! (.+); then\n +echo .*first-parent history/m)?.[1];
    expect(command).toBeDefined();
    const temp = fs.realpathSync(os.tmpdir());
    const repo = fs.mkdtempSync(path.join(temp, 'masarx-release-gate-'));
    try {
      git(repo, 'init', '--initial-branch=main');
      git(repo, 'config', 'user.name', 'Release gate test');
      git(repo, 'config', 'user.email', 'release-fixture@example.invalid');
      git(repo, 'config', 'commit.gpgsign', 'false');
      git(repo, 'commit', '--allow-empty', '-m', 'base');
      git(repo, 'switch', '-c', 'pr-branch');
      git(repo, 'commit', '--allow-empty', '-m', 'PR commit');
      const pr = git(repo, 'rev-parse', 'HEAD');
      git(repo, 'switch', 'main');
      git(repo, 'merge', '--no-ff', 'pr-branch', '-m', 'merge PR branch');
      const main = git(repo, 'rev-parse', 'HEAD');
      expect(git(repo, 'rev-parse', 'HEAD^2')).toBe(pr);
      git(repo, 'update-ref', 'refs/remotes/origin/main', main);

      const bash = process.platform === 'win32'
        ? path.resolve(git(repo, '--exec-path'), '../../../bin/bash.exe')
        : 'bash';
      const run = sha => spawnSync(bash, ['--noprofile', '--norc', '-e', '-o', 'pipefail', '-c', command], {
        cwd: repo, env: { ...process.env, sha }, encoding: 'utf8', timeout: 10000, windowsHide: true,
      });
      expect(run(main)).toMatchObject({ status: 0, stderr: '' });
      expect(run(pr)).toMatchObject({ status: 1, stderr: '' });
    } finally {
      expect(path.dirname(fs.realpathSync(repo))).toBe(temp);
      fs.rmSync(repo, { recursive: true, force: true });
    }
  });

  const jqMissing = jq(['--version']).error?.code === 'ENOENT';
  if (jqMissing && process.env.CI !== undefined) {
    throw new Error('jq is required on PATH for release admission tests in CI.');
  }
  if (jqMissing) console.warn('Skipping release admission jq tests because jq is missing from PATH.');
  const testJq = jqMissing ? test.skip : test;
  const sha = 'a'.repeat(40);
  const mergeGroup = { event: 'merge_group', head_branch: 'gh-readonly-queue/main/pr-1-fixture', head_sha: sha, check_suite_id: 11 };
  const newer = { ...mergeGroup, check_suite_id: 12 };
  const pullRequest = { ...newer, event: 'pull_request', head_branch: 'pr-branch' };
  const differentSha = { ...mergeGroup, head_sha: 'b'.repeat(40) };
  const success = {
    id: 1, name: 'ci-gate', head_sha: sha, app: { slug: 'github-actions' },
    check_suite: { id: mergeGroup.check_suite_id }, status: 'completed', conclusion: 'success',
  };
  const newerFailure = { ...success, id: 2, check_suite: { id: newer.check_suite_id }, conclusion: 'failure' };

  testJq.each([
    ['pull-request-only success', [pullRequest], [{ ...newerFailure, conclusion: 'success' }], false],
    ['merge-group success for a different SHA', [differentSha], [{ ...success, head_sha: differentSha.head_sha }], false],
    ['empty evidence', [], [], false],
    ['pending gate', [mergeGroup], [{ ...success, status: 'in_progress', conclusion: null }], false],
    ['failed gate', [mergeGroup], [{ ...success, conclusion: 'failure' }], false],
    ['newer failure over older success', [mergeGroup, newer], [success, newerFailure], false],
    ['merge-group success on the tagged SHA', [mergeGroup], [success], true],
    ['push to main success', [{ ...mergeGroup, event: 'push', head_branch: 'main' }], [success], true],
    ['merge-group success on a different queue', [{ ...mergeGroup, head_branch: 'gh-readonly-queue/dev/pr-1-fixture' }], [success], false],
    ['merge-group success with a missing queue', [{ ...mergeGroup, head_branch: null }], [success], false],
    ['push to a different branch', [{ ...mergeGroup, event: 'push', head_branch: 'dev' }], [success], false],
    ['wrong GitHub App', [mergeGroup], [{ ...success, app: { slug: 'fixture' } }], false],
    ['newer PR failure alongside trusted success', [pullRequest, mergeGroup], [newerFailure, success], true],
  ])('evaluates %s through the shared CI gate', (_label, runs, checks, accepted) => {
    const bash = process.platform === 'win32' ? path.join(process.env.ProgramFiles, 'Git', 'bin', 'bash.exe') : 'bash';
    const fixture = `
      fake_gh() {
        case "\${*: -1}" in
          "repos/example/platform/actions/workflows/public-ci.yml/runs?head_sha=$FIXTURE_SHA&per_page=100")
            printf '%s' "$FIXTURE_RUNS" ;;
          "repos/example/platform/commits/$FIXTURE_SHA/check-runs?check_name=ci-gate&filter=all&per_page=100")
            printf '%s' "$FIXTURE_CHECKS" ;;
          *) return 2 ;;
        esac
      }
      source "$1" example/platform "$FIXTURE_SHA" fake_gh
    `;
    const result = spawnSync(bash, ['-c', fixture, 'ci-gate-fixture', sharedPath], {
      cwd: path.resolve(__dirname, '../../..'),
      env: {
        ...process.env,
        FIXTURE_SHA: sha,
        FIXTURE_RUNS: JSON.stringify([{ workflow_runs: runs }]),
        FIXTURE_CHECKS: JSON.stringify([{ check_runs: checks }]),
      },
      encoding: 'utf8', timeout: 10000, windowsHide: true,
    });
    expect(result.error).toBeUndefined();
    expect(result.status).toBe(accepted ? 0 : 1);
    expect(result.stdout).toBe('');
    if (accepted) expect(result.stderr).toBe('');
    else expect(result.stderr).toContain('Release requires a successful ci-gate');
  });
});
