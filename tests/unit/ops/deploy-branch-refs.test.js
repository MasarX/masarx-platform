const { extractBranchReferences, missingBranches } = require('../../../scripts/ci-hosted/deploy-branch-refs.cjs');

const workflow = '.github/workflows/deploy.yml';
const guard = 'scripts/deploy/apply-guard.cjs';
const extract = (file, lines) => extractBranchReferences(file, lines.join('\r\n'));
const branchLines = references => references.map(({ branch, line }) => [branch, line]);

test('finds literal push branches in flow and block lists', () => {
  expect(branchLines(extract(workflow, [
    "'on':",
    '  push:',
    '    branches: [main, "release/next",',
    "      'hotfix/one', 'feature/**', '!feature/skip'] # filter",
    '  pull_request:',
    '    branches: [ignored]',
  ]))).toEqual([['main', 3], ['release/next', 3], ['hotfix/one', 4]]);

  expect(branchLines(extract(workflow, [
    'on:',
    '  push:',
    '    branches:',
    '      # This comment is ignored.',
    "      - 'main'",
    '      - stable/one # filter',
    '    paths:',
    '      - ignored',
  ]))).toEqual([['main', 5], ['stable/one', 6]]);
});

test('finds branch comparisons, including a folded expression, and literal refs in workflow commands', () => {
  expect(branchLines(extract(workflow, [
    'jobs:',
    '  deploy:',
    '    if: >-',
    "      github.ref_name == 'release/next' &&",
    "      'release/old' != github.base_ref &&",
    "      github.ref == 'refs/heads/main' && inputs.environment == 'staging'",
    '    steps:',
    '      - run: |',
    '          case "$GITHUB_REF" in',
    '            refs/heads/canary|refs/heads/hotfix/one) ;;',
    '          esac',
    "          echo 'refs/heads/${DYNAMIC}'",
  ]))).toEqual([['release/next', 4], ['release/old', 5], ['main', 6], ['canary', 10], ['hotfix/one', 10]]);
});

test('finds literal refs and branch lists in deploy scripts', () => {
  expect(branchLines(extract('scripts/deploy/nested/release.js', [
    'const allowedBranches = [',
    "  'main', // active trunk",
    '  "feature/next",',
    "  'release/old',",
    '];',
    "// get('/git/ref/heads/ignored');",
    "get('/git/ref/heads/release/latest');",
    "checkout('refs/heads/hotfix/one');",
    'get(`/git/ref/heads/${branch}`);',
  ]))).toEqual([['main', 2], ['feature/next', 3], ['release/old', 4], ['release/latest', 7], ['hotfix/one', 8]]);
});

test('reports absent branches at their source locations and uses exact remote names', () => {
  const refs = extract(guard, ["get('/git/ref/heads/missing');", "get('/git/ref/heads/main');"]);
  expect(missingBranches(refs, new Set(['main', 'missing/child']))).toEqual([
    expect.objectContaining({ file: guard, line: 1, branch: 'missing' }),
  ]);
});

test('allows only the historical dev branch entry, regardless of its line number', () => {
  const tolerated = extract(guard, [
    '',
    '// G2 apply history',
    "const deploymentBranches = ['main', 'dev'];",
  ]);
  const rejected = [
    ...extract(workflow, [
      'on:',
      '  push:',
      '    branches: [dev, main]',
      'jobs:',
      '  deploy:',
      '    steps:',
      '      - run: |',
      '          case "$DEPLOY_ENV:$GITHUB_REF" in',
      '            dev:refs/heads/dev|dev:refs/heads/main) ;;',
      '          esac',
    ]),
    ...extract(guard, [
      "const devRef = await get('/git/ref/heads/dev', { allowNotFound: true });",
      "const devTip = (await get('/git/ref/heads/dev')).object.sha;",
    ]),
    ...extract('scripts/deploy/nested/new.cjs', ["const deploymentBranches = ['main', 'dev'];"]),
  ];
  const remote = new Set(['main']);
  expect(branchLines(missingBranches(tolerated, remote, new Map()))).toEqual([['dev', 3]]);
  expect(missingBranches(tolerated, remote)).toEqual([]);
  expect(missingBranches([...tolerated, ...rejected], remote)).toEqual(rejected.filter(({ branch }) => branch === 'dev'));
});
