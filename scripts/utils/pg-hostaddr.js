const { Resolver } = require('dns').promises;

function isSupabaseDirectHost(host) {
  const h = (host || '').trim().toLowerCase();
  return /^db\.[^.]+\.supabase\.co$/.test(h);
}

function isSupabasePoolerHost(host) {
  const h = (host || '').trim().toLowerCase();
  return h.endsWith('.pooler.supabase.com');
}

function isSupabaseHost(host) {
  return isSupabaseDirectHost(host) || isSupabasePoolerHost(host);
}

function isIpv4(host) {
  return /^\d{1,3}(\.\d{1,3}){3}$/.test(host || '');
}

function extractHost(dbUrl) {
  const v = (dbUrl || '').trim();
  if (!v) return '';
  try {
    const u = new URL(v);
    return (u.hostname || '').trim();
  } catch {
    const m = v.match(/^[a-z]+:\/\/[^@]+@([^/:?#]+)(?::\d+)?/i);
    return m && m[1] ? m[1].trim() : '';
  }
}

async function sleep(ms) {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

async function resolveIpv4Address(host, options = {}) {
  const resolver = new Resolver({ timeout: 1000, tries: 1 });
  const attemptsRaw = Number(options.attempts);
  const delayMsRaw = Number(options.delayMs);
  const attempts = Number.isFinite(attemptsRaw) && attemptsRaw > 0 ? Math.floor(attemptsRaw) : 3;
  const delayMs = Number.isFinite(delayMsRaw) && delayMsRaw >= 0 ? Math.floor(delayMsRaw) : 150;

  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      const resolved = await resolver.resolve4(host);
      if (Array.isArray(resolved) && resolved.length > 0) {
        const first = String(resolved[0] || '').trim();
        if (first) return first;
      }
    } catch {
      // Retry until attempts are exhausted.
    }

    if (attempt < attempts && delayMs > 0) {
      await sleep(delayMs);
    }
  }

  return '';
}

/**
 * Ensures a Postgres DSN has an IPv4 `hostaddr=` query param when the host is a
 * Supabase hostname. Some environments (CI runners) may not have working IPv6.
 *
 * Returns the original string when:
 *  - DSN is empty
 *  - `hostaddr` is already present
 *  - host is not a Supabase hostname
 *  - IPv4 resolution fails
 */
async function ensureHostaddr(dbUrl) {
  const url = (dbUrl || '').trim();
  if (!url) return url;
  if (/\bhostaddr=/i.test(url)) return url;

  const host = extractHost(url);
  if (!host) return url;
  if (!isSupabaseHost(host)) return url;
  if (isIpv4(host)) return url;

  try {
    const address = await resolveIpv4Address(host);
    if (!address) return url;

    const hashIndex = url.indexOf('#');
    const base = hashIndex >= 0 ? url.slice(0, hashIndex) : url;
    const frag = hashIndex >= 0 ? url.slice(hashIndex) : '';
    const sep = base.includes('?') ? '&' : '?';
    return `${base}${sep}hostaddr=${address}${frag}`;
  } catch {
    return url;
  }
}

/**
 * Rewrites a Supabase DSN hostname to an IPv4 literal when resolvable.
 * This provides a fallback for environments where IPv6 egress is unavailable.
 */
async function ensureIpv4Hostname(dbUrl) {
  const url = (dbUrl || '').trim();
  if (!url) return url;

  const host = extractHost(url);
  if (!host) return url;
  if (!isSupabaseHost(host)) return url;
  if (isIpv4(host)) return url;

  try {
    const address = await resolveIpv4Address(host);
    if (!address) return url;
    const parsed = new URL(url);
    parsed.hostname = address;
    return parsed.toString();
  } catch {
    return url;
  }
}

module.exports = {
  ensureHostaddr,
  ensureIpv4Hostname,
  extractHost,
  isSupabaseDirectHost,
  isSupabaseHost,
  isSupabasePoolerHost,
};
