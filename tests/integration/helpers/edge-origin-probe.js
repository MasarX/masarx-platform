function normalizeOrigin(value) {
  const raw = String(value || '').trim();
  if (!raw) return '';
  try {
    const url = new URL(raw);
    if (url.protocol !== 'https:' && url.protocol !== 'http:') return '';
    return url.origin;
  } catch {
    return '';
  }
}

function parseOriginTokens(raw) {
  const text = String(raw || '').trim();
  if (!text) return [];

  const normalizeToken = (token) =>
    String(token || '')
      .trim()
      .replace(/^['"]+|['"]+$/g, '');

  const out = [];
  const pushToken = (token) => {
    const normalized = normalizeToken(token);
    if (!normalized) return;
    out.push(normalized);
  };

  if (text.startsWith('[') && text.endsWith(']')) {
    try {
      const parsed = JSON.parse(text);
      if (Array.isArray(parsed)) {
        parsed.forEach(pushToken);
        return out;
      }
    } catch {
      // Fall through to delimiter parsing.
    }
  }

  text.split(/[\n,;]+/).forEach(pushToken);
  return out;
}

function expandWildcardOrigin(token, fallbackOrigins) {
  const raw = String(token || '').trim();
  if (!raw.includes('*')) return [raw];
  if (!Array.isArray(fallbackOrigins) || !fallbackOrigins.length) return [];

  const pattern = raw
    .replace(/[.+?^${}()|[\]\\]/g, '\\$&')
    .replace(/\*/g, '[^.]+');
  const regex = new RegExp(`^${pattern}$`, 'i');
  return fallbackOrigins.filter((origin) => regex.test(origin));
}

function dedupeOrigins(values) {
  const seen = new Set();
  const out = [];
  for (const value of values) {
    const origin = normalizeOrigin(value);
    if (!origin || seen.has(origin)) continue;
    seen.add(origin);
    out.push(origin);
  }
  return out;
}

function buildAllowedOriginCandidates({
  allowlistValues = [],
  envValues = [],
  canonicalHosts = [],
} = {}) {
  const fallbackOrigins = dedupeOrigins([...envValues, ...canonicalHosts]);
  const candidates = [];
  const seen = new Set();

  const addCandidate = (value) => {
    const origin = normalizeOrigin(value);
    if (!origin || seen.has(origin)) return;
    seen.add(origin);
    candidates.push(origin);
  };

  for (const raw of allowlistValues) {
    for (const token of parseOriginTokens(raw)) {
      const expanded = expandWildcardOrigin(token, fallbackOrigins);
      if (expanded.length) {
        expanded.forEach(addCandidate);
      } else {
        addCandidate(token);
      }
    }
  }

  fallbackOrigins.forEach(addCandidate);
  return candidates;
}

async function probeAllowedOrigin(candidates, requestFn) {
  const attempts = [];
  const list = Array.isArray(candidates) ? candidates : [];
  for (const origin of list) {
    if (!origin) continue;
    try {
      const result = await requestFn(origin);
      const status = Number(result?.status || 0);
      const errorCode = String(result?.body?.error?.code || '').trim();
      attempts.push({ origin, status, code: errorCode });
      if (status === 403) continue;
      // A server/auth/routing failure is not proof that CORS admitted this origin.
      if (!((status >= 200 && status < 300) ||
          (status === 400 && errorCode && errorCode !== 'server_misconfigured'))) continue;
      return { origin, attempts };
    } catch (error) {
      attempts.push({
        origin,
        status: 0,
        code: '',
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
  return { origin: '', attempts };
}

module.exports = {
  buildAllowedOriginCandidates,
  normalizeOrigin,
  parseOriginTokens,
  probeAllowedOrigin,
};
