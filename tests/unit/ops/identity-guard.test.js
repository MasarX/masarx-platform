const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

test('the identity guard checks both commit roles and the PR opener without printing identities', () => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'merge-group-identities-'));
  const options = { cwd, encoding: 'utf8' };
  const botLogin = ['fixture', 'bot'].join('-');
  const personLogin = ['fixture', 'person'].join('-');
  const botRow = { id: 101, login: botLogin, name: botLogin, reason: 'Synthetic bot fixture' };
  const webRow = { name: 'Fixture Committer', localPart: 'fixture-committer', host: 'example.test', reason: 'Synthetic web fixture' };
  const bot = { name: botRow.name, email: [`${botRow.id}+${botLogin}`, 'users.noreply.github.com'].join('@') };
  const person = { name: ['Fixture', 'Person'].join(' '), email: [personLogin, 'example.test'].join('@') };
  const web = { name: webRow.name, email: [webRow.localPart, webRow.host].join('@') };
  const guard = 'scripts/ci-hosted/identity-guard.cjs';
  const git = (args, env = process.env) => {
    const result = spawnSync('git', ['-c', 'commit.gpgsign=false', '-c', `core.hooksPath=${cwd}`, ...args], { ...options, env });
    expect(result.status).toBe(0);
    return result.stdout.trim();
  };
  const commit = (author, committer, subject) => {
    git(['commit', '--allow-empty', '-m', subject], {
      ...process.env,
      GIT_AUTHOR_NAME: author.name,
      GIT_AUTHOR_EMAIL: author.email,
      GIT_AUTHOR_DATE: '2000-01-01T00:00:00Z',
      GIT_COMMITTER_NAME: committer.name,
      GIT_COMMITTER_EMAIL: committer.email,
      GIT_COMMITTER_DATE: '2000-01-01T00:00:00Z',
    });
    return git(['rev-parse', 'HEAD']);
  };
  const check = (env, status, stdout, stderr) => {
    const result = spawnSync(process.execPath, [guard], {
      ...options, env: { ...process.env, ...env },
    });
    expect(result.status).toBe(status);
    expect(result.stdout === stdout).toBe(true);
    expect(result.stderr === stderr).toBe(true);
  };

  try {
    git(['init', '--quiet']);
    fs.mkdirSync(path.join(cwd, 'scripts/ci-hosted'), { recursive: true });
    fs.mkdirSync(path.join(cwd, 'config/ci'), { recursive: true });
    for (const file of [guard, 'scripts/ci-hosted/target-policy.cjs']) {
      fs.copyFileSync(path.join(__dirname, '../../..', file), path.join(cwd, file));
    }
    fs.writeFileSync(path.join(cwd, 'config/ci/commit-identities.json'),
      JSON.stringify([botRow, webRow]));

    const base = commit(person, person, 'Base');
    const mergeGroup = head => ({ GITHUB_EVENT_NAME: 'merge_group', GROUP_BASE: base, GROUP_HEAD: head });
    const allowed = commit(bot, web, 'Allowed');
    check(mergeGroup(allowed), 0, 'identity-guard: pass\n', '');
    commit({ ...person, email: bot.email }, bot, 'Disallowed author');
    commit(bot, { ...person, name: bot.name }, 'Disallowed committer');
    const head = commit(bot, bot, 'Tip');
    check(mergeGroup(head), 1, '', 'identity-guard: fail (2 commits)\n');
    check(mergeGroup(allowed), 1, '', 'identity-guard: fail (0 commits)\n');

    const eventPath = path.join(cwd, 'event.json');
    const pullRequest = { GITHUB_EVENT_NAME: 'pull_request', GITHUB_EVENT_PATH: eventPath };
    const writeOpener = (id, login, type) => {
      fs.writeFileSync(eventPath, JSON.stringify({ pull_request: { user: { id, login, type } } }));
    };
    writeOpener(botRow.id, botLogin, 'Bot');
    check(pullRequest, 0, 'identity-guard: pass\n', '');
    writeOpener(102, personLogin, 'User');
    check(pullRequest, 1, '', 'identity-guard: opener fail\n');
    writeOpener(botRow.id, botLogin, 'User');
    check(pullRequest, 1, '', 'identity-guard: opener fail\n');
    writeOpener(botRow.id, personLogin, 'Bot');
    check(pullRequest, 1, '', 'identity-guard: opener fail\n');
    writeOpener(102, botLogin, 'Bot');
    check(pullRequest, 1, '', 'identity-guard: opener fail\n');
  } finally {
    fs.rmSync(cwd, { recursive: true, force: true });
  }
});
