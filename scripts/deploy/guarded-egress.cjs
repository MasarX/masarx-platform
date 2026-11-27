const { readFileSync } = require('node:fs');
const { createHash } = require('node:crypto');

const proxyNames = ['URL', 'USERNAME', 'PASSWORD'].map(suffix => `API_CALLER_GUARDED_EGRESS_PROXY_${suffix}`);
const emptyDigest = createHash('sha256').digest('hex');

function readEgressMode(environment) {
  let listed;
  try {
    listed = JSON.parse(readFileSync(0, 'utf8'));
  } catch {
    return null;
  }
  if (!Array.isArray(listed)) return null;

  const digests = new Map();
  for (const entry of listed) {
    if (typeof entry?.name !== 'string' || !entry.name.trim() || digests.has(entry.name)) return null;
    digests.set(entry.name, entry.value);
  }

  const present = proxyNames.filter(name => digests.has(name));
  if (present.length === 0 && environment === 'dev') return 'dev_direct';
  if (present.length !== proxyNames.length) return null;

  return present.every(name => {
    const digest = digests.get(name);
    if (typeof digest !== 'string') return false;
    const normalized = digest.trim().toLowerCase();
    return normalized !== '' && normalized !== emptyDigest;
  }) ? 'proxy' : null;
}

const mode = readEgressMode(process.env.DEPLOY_ENV);
if (mode) {
  console.log(`egress_mode=${mode}`);
} else {
  console.error('::error::Guarded egress secret read-back failed.');
  process.exitCode = 1;
}
