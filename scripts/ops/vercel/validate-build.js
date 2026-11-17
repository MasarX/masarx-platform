const fs = require('node:fs');
const path = require('node:path');

function validatePublicKey(key = '') {
  if (/^sb_publishable_.+$/.test(key)) return;
  try {
    const parts = key.split('.');
    if (parts.length === 3 && parts.every(part => /^[A-Za-z0-9_-]+$/.test(part))) {
      const header = JSON.parse(Buffer.from(parts[0], 'base64url'));
      const payload = JSON.parse(Buffer.from(parts[1], 'base64url'));
      if (typeof header.alg === 'string' && header.alg && payload.role === 'anon') return;
    }
  } catch {}
  throw new Error('NEXT_PUBLIC_SUPABASE_ANON_KEY must be an anon JWT or sb_publishable_ key');
}

function verifyPrebuilt(root = process.cwd()) {
  root = path.resolve(root);
  const functions = path.join(root, '.vercel/output/functions');
  if (!fs.existsSync(functions)) throw new Error('Prebuilt functions directory is missing');
  const configs = [];
  const visited = new Set();
  function walk(directory) {
    const real = fs.realpathSync(directory);
    if (visited.has(real)) return;
    visited.add(real);
    for (const entry of fs.readdirSync(directory, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const file = path.join(directory, entry.name);
      if (entry.name.endsWith('.func')) configs.push(path.join(file, '.vc-config.json'));
      else if (entry.isDirectory() || (entry.isSymbolicLink() && fs.statSync(file).isDirectory())) walk(file);
    }
  }
  walk(functions);
  if (!configs.length) throw new Error('No prebuilt function configs found');
  const sources = new Set();
  for (const file of configs) {
    const config = JSON.parse(fs.readFileSync(file, 'utf8'));
    for (const source of Object.values(config.filePathMap || {})) sources.add(source);
  }
  if (!sources.size) throw new Error('No prebuilt file maps found');
  const missing = [];
  for (const source of sources) {
    if (typeof source !== 'string' || !source) throw new Error('Invalid prebuilt file-map source');
    const file = path.join(root, source);
    const relative = path.relative(root, file);
    if (relative.startsWith('..') || path.isAbsolute(relative)) throw new Error('Prebuilt file map escapes the deployment root');
    if (!fs.statSync(file, { throwIfNoEntry: false })?.isFile()) {
      missing.push(source);
      if (missing.length === 5) break;
    }
  }
  if (missing.length) throw new Error('Missing prebuilt files (first 5):\n' + missing.join('\n'));
  return { functions: configs.length, files: sources.size };
}

if (require.main === module) {
  try {
    if (process.argv[2] === 'public-key') validatePublicKey(process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY);
    else if (process.argv[2] === 'prebuilt') {
      const result = verifyPrebuilt();
      console.log(`Verified ${result.files} mapped files across ${result.functions} prebuilt functions`);
    } else throw new Error('Usage: validate-build.js public-key|prebuilt');
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
module.exports = { validatePublicKey, verifyPrebuilt };
