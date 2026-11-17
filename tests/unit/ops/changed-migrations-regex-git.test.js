const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const {
  listChangedMigrations,
  resolveBaseRef,
} = require('../../../scripts/ops/ci/changed-migrations-regex');

function git(cwd, args) {
  const result = spawnSync('git', args, { cwd, encoding: 'utf8' });
  if (result.status !== 0) {
    throw new Error(String(result.stderr || result.stdout || `git ${args.join(' ')} failed`).trim());
  }
}

describe('changed-migrations-regex real Git topology', () => {
  test('uses the first parent of a proven synthetic merge and finds its migration', () => {
    const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'masarx-changed-migrations-'));
    const previousCwd = process.cwd();
    const previousEnv = {
      GITHUB_ACTIONS: process.env.GITHUB_ACTIONS,
      GITHUB_EVENT_NAME: process.env.GITHUB_EVENT_NAME,
      GITHUB_REF: process.env.GITHUB_REF,
      GITHUB_BASE_REF: process.env.GITHUB_BASE_REF,
      LOCAL_GATE_BASE_SHA: process.env.LOCAL_GATE_BASE_SHA,
    };
    try {
      git(repo, ['init', '--initial-branch=main']);
      git(repo, ['config', 'user.name', 'MasarX Test']);
      git(repo, ['config', 'user.email', 'test@masarx.invalid']);
      fs.writeFileSync(path.join(repo, 'README.md'), 'base\n');
      git(repo, ['add', 'README.md']);
      git(repo, ['commit', '-m', 'base']);
      git(repo, ['checkout', '-b', 'candidate']);
      fs.mkdirSync(path.join(repo, 'supabase', 'migrations'), { recursive: true });
      const migration = 'supabase/migrations/20260808000100_candidate.sql';
      fs.writeFileSync(path.join(repo, migration), 'select 1;\n');
      git(repo, ['add', migration]);
      git(repo, ['commit', '-m', 'candidate migration']);
      git(repo, ['checkout', 'main']);
      git(repo, ['merge', '--no-ff', 'candidate', '-m', 'synthetic merge']);

      process.chdir(repo);
      delete process.env.LOCAL_GATE_BASE_SHA;
      process.env.GITHUB_ACTIONS = 'true';
      process.env.GITHUB_EVENT_NAME = 'merge_group';
      process.env.GITHUB_REF = 'refs/heads/gh-readonly-queue/main/pr-3330-test';
      process.env.GITHUB_BASE_REF = 'main';

      const baseRef = resolveBaseRef({ baseArg: '' });
      expect(baseRef).toBe('HEAD^1');
      expect(listChangedMigrations({ baseRef, headRef: 'HEAD' })).toEqual([migration]);
    } finally {
      process.chdir(previousCwd);
      for (const [name, value] of Object.entries(previousEnv)) {
        if (value === undefined) delete process.env[name];
        else process.env[name] = value;
      }
      fs.rmSync(repo, { recursive: true, force: true });
    }
  });
});
