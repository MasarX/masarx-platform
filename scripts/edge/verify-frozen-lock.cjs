const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { spawnSync } = require('node:child_process');
const registry = require('../../config/edge/functions.json');

const root = path.resolve(__dirname, '../..');
const enabled = registry.functions.filter(entry => entry.enabled === true).map(entry => entry.name);

function runDeno(name, args, cwd, cache) {
  const result = spawnSync('deno', args, {
    cwd,
    encoding: 'utf8',
    env: { ...process.env, DENO_DIR: cache, NO_COLOR: '1' },
    stdio: ['ignore', 'ignore', 'pipe'],
  });
  if (result.status === 0) return 0;
  const error = result.stderr?.replace(/^[\s\S]*?(?=^error:)/m, '').trimEnd();
  console.error(`${name}: ${error || result.error?.message || `Deno exited with ${result.signal ?? result.status}`}`);
  return result.status || 1;
}

function verify(
  workdir = process.env.EDGE_FROZEN_WORKDIR,
  summaryPath = require.main === module ? process.env.GITHUB_STEP_SUMMARY : undefined,
) {
  if (!enabled.length || new Set(enabled).size !== enabled.length
      || enabled.some(name => typeof name !== 'string' || !/^[a-z0-9-]+$/.test(name))) {
    throw new Error('Invalid enabled Edge function registry');
  }
  if (!fs.statSync(path.join(root, 'deno.lock'), { throwIfNoEntry: false })?.isFile()) {
    throw new Error('Missing root deno.lock');
  }
  if (workdir) workdir = path.resolve(root, workdir);

  // Deno checks npm integrity on download, so each gate needs a fresh cache.
  const cache = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'edge-frozen-lock-'));
  const checksums = [];
  const sizes = [];
  const oversized = [];
  try {
    const limitBytes = registry.use_api_bundle_limit_bytes;
    if (!Number.isSafeInteger(limitBytes) || limitBytes <= 0) {
      throw new Error('config/edge/functions.json: use_api_bundle_limit_bytes must be a positive safe integer');
    }
    if (workdir) fs.mkdirSync(workdir, { mode: 0o700 });
    for (const name of enabled) {
      const dir = `supabase/functions/${name}`;
      const entry = `${dir}/index.ts`;
      const args = [workdir ? 'bundle' : 'cache', '--frozen', '--lock=deno.lock', '--no-config', '--node-modules-dir=none'];
      if (fs.existsSync(path.join(root, dir, 'deno.json'))) args.push('--import-map', `${dir}/deno.json`);
      if (workdir) {
        fs.mkdirSync(path.join(workdir, dir), { recursive: true });
        args.push('--platform=deno', '--packages=bundle', '--minify', '--keep-names', '--output', path.join(workdir, entry));
      }
      const status = runDeno(name, [...args, entry], root, cache);
      if (status !== 0) return status;
      if (workdir) {
        const bundle = fs.readFileSync(path.join(workdir, entry));
        const sizeBytes = bundle.length;
        const measurement = `${name}: ${sizeBytes} bytes (limit ${limitBytes} bytes)`;
        console.log(`Edge bundle ${measurement}`);
        sizes.push({ name, sizeBytes, limitBytes });
        if (sizeBytes > limitBytes) oversized.push(measurement);
        if (!sizeBytes) throw new Error(`Empty frozen Edge bundle: ${name}`);
        // Resolve the output without the build cache, import map or package registry.
        const offline = runDeno(name, ['cache', '--no-config', '--no-lock', '--no-remote', '--no-npm',
          '--node-modules-dir=none', `./${entry}`], workdir, path.join(cache, 'offline'));
        if (offline !== 0) return offline;
        checksums.push(`${createHash('sha256').update(bundle).digest('hex')}  ${entry}`);
      }
    }
    if (oversized.length) {
      throw new Error(`Edge bundle size limit exceeded:\n${oversized.join('\n')}`);
    }
    if (workdir) {
      const config = 'project_id = "frozen-edge"\n';
      fs.writeFileSync(path.join(workdir, 'supabase/config.toml'), config);
      checksums.push(`${createHash('sha256').update(config).digest('hex')}  supabase/config.toml`);
      fs.writeFileSync(path.join(workdir, 'SHA256SUMS'), `${checksums.join('\n')}\n`);
    }
    console.log(`${workdir ? 'Frozen Edge bundles built and resolved offline' : 'Edge frozen lock verified'}. Enabled functions: ${enabled.length}.`);
    return 0;
  } finally {
    fs.rmSync(cache, { recursive: true });
    if (workdir && summaryPath) {
      fs.appendFileSync(summaryPath, `## Edge bundle sizes\n\n\`\`\`json\n${JSON.stringify(sizes, null, 2)}\n\`\`\`\n`);
    }
  }
}

if (require.main === module) {
  try {
    process.exitCode = verify();
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}

module.exports = { verify };
