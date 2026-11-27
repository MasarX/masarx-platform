const { execFileSync, spawnSync } = require('node:child_process');
const { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } = require('node:fs');
const { tmpdir } = require('node:os');
const { join, resolve } = require('node:path');

const runbook = readFileSync(resolve(__dirname, '../../../docs/ops/production-release.md'), 'utf8');
const tagBlock = [...runbook.matchAll(/```bash\r?\n([\s\S]*?)\r?\n```/g)]
  .map(([, body]) => body.replaceAll('\r\n', '\n'))
  .find(body => body.includes('\ngit tag -a '));
const tagCommands = tagBlock?.split('\ntag_object=')[0];
const bash = process.platform === 'win32' ? join(process.env.ProgramFiles, 'Git', 'bin', 'bash.exe') : 'bash';

let repo;
let beforePolicy;
let policy;
let afterPolicy;
let withoutWorkflow;

beforeAll(() => {
  repo = mkdtempSync(join(tmpdir(), 'production-tag-fixture-'));
  const git = (...args) => execFileSync('git', [
    '-c', 'user.name=Unit fixture',
    '-c', 'user.email=unit-fixture@example.invalid',
    '-c', 'commit.gpgsign=false',
    '-c', `core.hooksPath=${join(repo, 'hooks')}`,
    ...args,
  ], { cwd: repo, encoding: 'utf8', windowsHide: true }).trim();
  const commit = message => {
    git('commit', '--allow-empty', '-m', message);
    return git('rev-parse', 'HEAD');
  };
  git('init', '--template=');
  beforePolicy = commit('Before the tag policy');
  const workflow = '.github/workflows/release-on-tag.yml';
  mkdirSync(join(repo, '.github/workflows'), { recursive: true });
  writeFileSync(join(repo, workflow), 'name: Synthetic tag workflow\n');
  git('add', workflow);
  policy = commit('Merge the tag policy');
  afterPolicy = commit('After the tag policy');
  git('rm', workflow);
  withoutWorkflow = commit('Remove the tag workflow');
  git('update-ref', 'refs/remotes/origin/main', withoutWorkflow);
});

afterAll(() => {
  if (repo) rmSync(repo, { recursive: true, force: true });
});

test.each([
  ['the policy commit', () => policy, () => policy, 0, 0, 'ci-gate\ntag\npush\n'],
  ['an eligible descendant', () => afterPolicy, () => policy, 0, 0, 'ci-gate\ntag\npush\n'],
  ['a green commit before the policy', () => beforePolicy, () => policy, 0, 1, ''],
  ['a descendant without the workflow', () => withoutWorkflow, () => policy, 0, 1, ''],
  ['a held candidate without CI evidence', () => afterPolicy, () => policy, 1, 1, 'ci-gate\n'],
  ['an unmerged policy', () => afterPolicy, () => '', 0, 1, ''],
  ['a malformed merge SHA', () => afterPolicy, () => 'invalid', 0, 1, ''],
])('checks tag eligibility for %s', (_name, releaseSha, policySha, ciStatus, status, output) => {
  expect(tagCommands).toContain('\ngit tag -a ');
  expect(tagCommands).toContain('\ngit push ');
  const fixture = `
    python() {
      [[ "$1" == -I && "$2" == fixture && "$7" == gh && "$8" == api &&
         "$9" == repos/MasarX/masarx-platform/pulls/566 ]] || return 2
      shift 9
      [[ "$1" == --jq && "$2" == 'select(.merged == true) | .merge_commit_sha' ]] || return 2
      printf '%s' "$FIXTURE_POLICY_SHA"
    }
    git() {
      case "$1" in
        fetch) [[ "$2" == origin && "$3" == main ]] ;;
        rev-list|merge-base|cat-file) command git "$@" ;;
        tag|push) printf '%s\\n' "$1" ;;
        *) return 2 ;;
      esac
    }
    bash() {
      [[ "$1" == scripts/deploy/require-ci-gate.sh && "$3" == "$RELEASE_SHA" ]] || return 2
      printf '%s\\n' ci-gate
      return "$FIXTURE_CI_STATUS"
    }
    ${tagCommands}
  `;
  const result = spawnSync(bash, ['-euo', 'pipefail', '-c', fixture], {
    cwd: repo,
    env: { ...process.env, APP_RUN: 'fixture', RELEASE_SHA: releaseSha(),
      FIXTURE_POLICY_SHA: policySha(), FIXTURE_CI_STATUS: String(ciStatus) },
    encoding: 'utf8',
    windowsHide: true,
  });
  expect(result.error).toBeUndefined();
  expect(result.status).toBe(status);
  expect(result.stdout.replaceAll('\r\n', '\n')).toBe(output);
});
