const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { functions } = require('../../config/edge/functions.json');

const root = path.resolve(__dirname, '../..');
const enabled = functions.filter(entry => entry.enabled === true).map(entry => entry.name);

function verify() {
  if (!enabled.length || new Set(enabled).size !== enabled.length
      || enabled.some(name => typeof name !== 'string' || !/^[a-z0-9-]+$/.test(name))) {
    throw new Error('Invalid enabled Edge function registry');
  }
  if (!fs.statSync(path.join(root, 'deno.lock'), { throwIfNoEntry: false })?.isFile()) {
    throw new Error('Missing root deno.lock');
  }

  // Deno checks npm integrity on download, so each gate needs a fresh cache.
  const cache = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'edge-frozen-lock-'));
  try {
    for (const name of enabled) {
      const dir = `supabase/functions/${name}`;
      const args = ['cache', '--frozen', '--lock=deno.lock', '--no-config', '--node-modules-dir=none'];
      if (fs.existsSync(path.join(root, dir, 'deno.json'))) args.push('--import-map', `${dir}/deno.json`);
      const result = spawnSync('deno', [...args, `${dir}/index.ts`], {
        cwd: root,
        encoding: 'utf8',
        env: { ...process.env, DENO_DIR: cache, NO_COLOR: '1' },
        stdio: ['ignore', 'ignore', 'pipe'],
      });
      if (result.status !== 0) {
        const error = result.stderr?.replace(/^[\s\S]*?(?=^error:)/m, '').trimEnd();
        console.error(`${name}: ${error || result.error?.message || `Deno exited with ${result.signal ?? result.status}`}`);
        return result.status || 1;
      }
    }
    console.log(`Edge frozen lock verified. Enabled functions: ${enabled.length}.`);
    return 0;
  } finally {
    fs.rmSync(cache, { recursive: true });
  }
}

try {
  process.exitCode = verify();
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
