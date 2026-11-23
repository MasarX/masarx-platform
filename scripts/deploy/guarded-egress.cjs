const { createHash } = require('node:crypto');
const { appendFileSync } = require('node:fs');

const proxyNames = ['URL', 'USERNAME', 'PASSWORD'].map(suffix => `API_CALLER_GUARDED_EGRESS_PROXY_${suffix}`);

async function egressMode(env, values) {
  if (env.DEPLOY_ENV === 'dev' && values.every(value => !value)) return 'dev_direct';
  if (!env.DEPLOY_ENV || values.some(value => !value || value.trim() !== value || /[\x00-\x1f\x7f]/.test(value))) {
    return 'missing';
  }
  const { resolveGuardedProxyConfiguration } = await import('../../supabase/functions/api-caller/proxy.mjs');
  const [url, username, password] = values;
  try {
    return resolveGuardedProxyConfiguration({ url, username, password }).url === url ? 'proxy' : 'missing';
  } catch {
    return 'missing';
  }
}

function appendProxySecrets(file, values) {
  const { parse } = require('dotenv');
  const contents = proxyNames.map((name, index) => {
    const value = values[index];
    const quote = ["'", '"', '`'].find(delimiter => !value.includes(delimiter)) || '';
    return `${name}=${quote}${value}${quote}\n`;
  }).join('');
  // The pinned CLI uses dotenv. Verify the whole block before any write.
  const parsed = parse(contents);
  if (proxyNames.some((name, index) => parsed[name] !== values[index])) {
    throw new Error('Proxy setting cannot be written as a dotenv entry.');
  }
  appendFileSync(file, contents, { mode: 0o600 });
}

function verifyProxyDigests(mode, local, listed) {
  if (mode === 'dev_direct') return listed.every(entry => !proxyNames.includes(entry.name));
  if (mode !== 'proxy') return false;
  const values = require('dotenv').parse(local);
  return proxyNames.every(name => {
    const entries = listed.filter(entry => entry.name === name);
    return values[name] && entries.length === 1 && entries[0].value === createHash('sha256').update(values[name]).digest('hex');
  });
}

async function main(command, env) {
  const values = proxyNames.map(name => env[name]);
  const mode = await egressMode(env, values);
  if (command === 'append') {
    if (mode === 'proxy') appendProxySecrets(env.EDGE_SECRET_FILE, values);
    if (mode !== 'missing') console.log(mode);
  } else if (command === 'probe') {
    console.log(`egress_mode=${mode}`);
    if (mode === 'proxy') {
      const { executeProof, resolveConfig } = require('../ops/verify-api-caller-guarded-egress-proxy');
      const proof = await executeProof(resolveConfig(env, env.DEPLOY_ENV));
      for (const { id, status } of proof.checks) console.log(`egress_proxy_${id}=${status}`);
      if (proof.status !== 'passed') process.exitCode = 1;
    }
  } else {
    throw new Error('Unknown egress command.');
  }
  if (mode === 'missing') process.exitCode = 1;
}

if (require.main === module) {
  main(process.argv[2], process.env).catch(() => {
    console.error('::error::Guarded egress configuration or verification failed.');
    process.exitCode = 1;
  });
}

module.exports = { verifyProxyDigests };
