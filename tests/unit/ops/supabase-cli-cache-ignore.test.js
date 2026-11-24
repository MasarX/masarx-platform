const { execFileSync } = require('node:child_process');
const { copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } = require('node:fs');
const { tmpdir } = require('node:os');
const { join, resolve } = require('node:path');

const repoRoot = resolve(__dirname, '../../..');

test.each(['.gitignore', 'supabase/.gitignore'])(
  '%s keeps the release checkout clean after the CLI writes its cache marker',
  ignoreFile => {
    const scratch = mkdtempSync(join(tmpdir(), 'supabase-cache-fixture-'));
    try {
      const checkout = join(scratch, 'checkout');
      const excludesFile = join(scratch, 'excludes');
      mkdirSync(join(checkout, 'supabase', '.temp'), { recursive: true });
      writeFileSync(excludesFile, '');
      const git = (...args) => execFileSync('git', [
        '-c', 'user.name=Unit fixture',
        '-c', 'user.email=unit-fixture@example.invalid',
        '-c', 'commit.gpgsign=false',
        '-c', `core.hooksPath=${join(scratch, 'hooks')}`,
        '-c', `core.excludesFile=${excludesFile}`,
        ...args,
      ], { cwd: checkout, encoding: 'utf8', windowsHide: true });

      git('init', '--template=');
      copyFileSync(join(repoRoot, ignoreFile), join(checkout, ignoreFile));
      git('add', '--', ignoreFile);
      git('commit', '-m', 'Fixture ignore rules');

      writeFileSync(join(checkout, 'supabase', '.temp', 'cli-latest'), '');
      expect(git('status', '--porcelain', '--untracked-files=all')).toBe('');
    } finally {
      rmSync(scratch, { recursive: true, force: true });
    }
  },
);
