'use strict';
const { spawnSync } = require('node:child_process');

function git(args, encoding = 'utf8', input, timeoutMs = 120000) {
  const result = spawnSync('git', ['-c', 'core.hooksPath=/dev/null', ...args], { encoding, input, timeout: timeoutMs, maxBuffer: (input ? 128 : 32) * 1024 * 1024 });
  if (result.error || result.status !== 0) throw new Error(`Target-policy Git read failed: ${args[0]}`);
  return result.stdout;
}
function targetBase(env = process.env, read = git) {
  if (env.GITHUB_EVENT_NAME === 'pull_request') return read(['rev-parse', 'HEAD^1']).trim();
  if (env.GITHUB_EVENT_NAME === 'merge_group') {
    if (!/^[a-f0-9]{40}$/.test(env.GROUP_BASE || '')) throw new Error('Invalid queue base SHA');
    read(['fetch', '--no-tags', '--depth=1', 'origin', env.GROUP_BASE]);
    return env.GROUP_BASE;
  }
  return read(['rev-parse', 'HEAD']).trim();
}
function targetFile(file, base = targetBase(), read = git) {
  if (!/^[a-f0-9]{40}$/.test(base) || !/^config\/ci\/[a-zA-Z0-9_.-]+$/.test(file)) throw new Error('Invalid target-policy blob identity');
  // An absent blob is empty policy; failure to read the base/tree is an error.
  const paths = read(['ls-tree', '-r', '--name-only', '-z', base, '--', file]).split('\0');
  return paths.includes(file) ? read(['show', `${base}:${file}`]) : '';
}
module.exports = { git, targetBase, targetFile };
