const { ensureHostaddr, ensureIpv4Hostname } = require('./pg-hostaddr');

function normalizeCandidate(candidate) {
  if (!candidate || typeof candidate !== 'object') return null;
  const name = String(candidate.name || '').trim();
  const dsn = String(candidate.dsn || '').trim();
  if (!name || !dsn) return null;
  return { name, dsn };
}

function resolvePinnedDbSelectionName(env = process.env) {
  const sourceEnv = env && typeof env === 'object' ? env : {};
  return String(
    sourceEnv.DB_SMOKE_SELECTED_DSN_NAME
      || sourceEnv.DATABASE_URL_SELECTED_DSN_NAME
      || sourceEnv.SHARED_LANE_DB_PROBE_SELECTED_DSN_NAME
      || '',
  ).trim();
}

function buildPinnedDbSelectionCandidate(env = process.env) {
  const sourceEnv = env && typeof env === 'object' ? env : {};
  const name = resolvePinnedDbSelectionName(sourceEnv);
  const dsn = String(sourceEnv.PG_CONN_STRING || sourceEnv.DATABASE_URL || '').trim();
  if (!name || !dsn) return null;
  return { name, dsn };
}

function applyPinnedDbSelectionPreference(candidates, env = process.env) {
  const list = Array.isArray(candidates) ? candidates.filter(Boolean) : [];
  if (list.length <= 1) return list;

  const sourceEnv = env && typeof env === 'object' ? env : {};
  const selectedName = resolvePinnedDbSelectionName(sourceEnv);
  if (!selectedName) return list;

  const preferredIndex = list.findIndex((candidate) => {
    const candidateName = String(candidate?.name || '').trim();
    return candidateName === selectedName;
  });
  if (preferredIndex <= 0) return list;

  return [list[preferredIndex], ...list.slice(0, preferredIndex), ...list.slice(preferredIndex + 1)];
}

function buildSupabasePoolerHostVariants(dsn) {
  const raw = String(dsn || '').trim();
  if (!raw) return [];
  let parsed;
  try {
    parsed = new URL(raw);
  } catch {
    return [];
  }

  const host = String(parsed.hostname || '').trim().toLowerCase();
  const match = host.match(/^aws-(\d+)-([a-z0-9-]+)\.pooler\.supabase\.com$/);
  if (!match) return [];

  const currentIdx = Number.parseInt(match[1], 10);
  const region = match[2];
  const orderedIndexes = [];
  if (currentIdx === 0) {
    orderedIndexes.push(1);
  } else if (currentIdx === 1) {
    orderedIndexes.push(0);
  } else if (Number.isFinite(currentIdx)) {
    orderedIndexes.push(1, 0);
  }

  const variants = [];
  for (const idx of orderedIndexes) {
    const variantHost = `aws-${idx}-${region}.pooler.supabase.com`;
    const next = new URL(raw);
    next.hostname = variantHost;
    variants.push({
      nameSuffix: `poolerhost:aws-${idx}`,
      dsn: next.toString(),
    });
  }
  return variants;
}

function buildSupabasePoolerPortVariants(dsn) {
  const raw = String(dsn || '').trim();
  if (!raw) return [];
  let parsed;
  try {
    parsed = new URL(raw);
  } catch {
    return [];
  }
  if (!isSupabasePoolerHost(parsed.hostname)) return [];

  const currentPort = String(parsed.port || '').trim();
  const candidates = currentPort === '6543'
    ? ['5432']
    : currentPort === '5432'
      ? ['6543']
      : ['5432', '6543'];

  const variants = [];
  for (const port of candidates) {
    const next = new URL(raw);
    next.port = port;
    variants.push({
      nameSuffix: `poolerport:${port}`,
      dsn: next.toString(),
    });
  }
  return variants;
}

function inferSupabaseProjectRef(options = {}) {
  const explicit = String(options.projectRef || '').trim();
  if (explicit) return explicit;
  const envProjectRef = String(process.env.SUPABASE_PROJECT_ID || '').trim();
  if (envProjectRef) return envProjectRef;
  const supabaseUrl = String(process.env.SUPABASE_URL || '').trim();
  if (!supabaseUrl) return '';
  try {
    const parsed = new URL(supabaseUrl);
    const host = String(parsed.hostname || '').trim().toLowerCase();
    const match = host.match(/^([a-z0-9-]+)\.supabase\.co$/);
    return match ? match[1] : '';
  } catch {
    return '';
  }
}

function isSupabasePoolerHost(hostname) {
  const host = String(hostname || '').trim().toLowerCase();
  if (!host) return false;
  if (/^aws-\d+-[a-z0-9-]+\.pooler\.supabase\.com$/.test(host)) return true;
  if (/^pooler\.[a-z0-9-]+\.supabase\.co$/.test(host)) return true;
  return false;
}

function buildSupabasePoolerUserVariant(dsn, options = {}) {
  const raw = String(dsn || '').trim();
  if (!raw) return null;
  let parsed;
  try {
    parsed = new URL(raw);
  } catch {
    return null;
  }
  const username = decodeURIComponent(String(parsed.username || '').trim());
  if (username !== 'postgres') return null;
  if (!isSupabasePoolerHost(parsed.hostname)) return null;

  const projectRef = inferSupabaseProjectRef(options);
  if (!projectRef) return null;

  const next = new URL(raw);
  next.username = `postgres.${projectRef}`;
  return {
    nameSuffix: 'pooleruser',
    dsn: next.toString(),
  };
}

async function buildDbConnectionCandidates(rawCandidates, options = {}) {
  const ensureHostaddrFn = options.ensureHostaddrFn || ensureHostaddr;
  const ensureIpv4HostnameFn = options.ensureIpv4HostnameFn || ensureIpv4Hostname;

  const normalized = Array.isArray(rawCandidates)
    ? rawCandidates.map(normalizeCandidate).filter(Boolean)
    : [];

  const seen = new Set();
  const candidates = [];

  const addCandidate = (name, dsn) => {
    const normalizedName = String(name || '').trim();
    const normalizedDsn = String(dsn || '').trim();
    if (!normalizedName || !normalizedDsn || seen.has(normalizedDsn)) return;
    seen.add(normalizedDsn);
    candidates.push({ name: normalizedName, dsn: normalizedDsn });
  };

  async function addCandidateLadder(baseName, baseDsn) {
    const poolerVariants = buildSupabasePoolerHostVariants(baseDsn);
    const poolerPortVariants = buildSupabasePoolerPortVariants(baseDsn);

    let ipv4HostDsn = baseDsn;
    try {
      ipv4HostDsn = (await ensureIpv4HostnameFn(baseDsn)) || baseDsn;
    } catch {
      ipv4HostDsn = baseDsn;
    }
    addCandidate(ipv4HostDsn === baseDsn ? baseName : `${baseName}+ipv4host`, ipv4HostDsn);

    let hostaddrDsn = baseDsn;
    try {
      hostaddrDsn = (await ensureHostaddrFn(baseDsn)) || baseDsn;
    } catch {
      hostaddrDsn = baseDsn;
    }
    addCandidate(hostaddrDsn === baseDsn ? baseName : `${baseName}+hostaddr`, hostaddrDsn);

    addCandidate(baseName, baseDsn);

    // Keep shard-host variants last so standard candidate ladders remain the
    // primary path and shard/port probing is best-effort only.
    for (const variant of poolerVariants) {
      addCandidate(`${baseName}+${variant.nameSuffix}`, variant.dsn);
      const variantPorts = buildSupabasePoolerPortVariants(variant.dsn);
      for (const variantPort of variantPorts) {
        addCandidate(
          `${baseName}+${variant.nameSuffix}+${variantPort.nameSuffix}`,
          variantPort.dsn,
        );
      }
    }
    for (const variant of poolerPortVariants) {
      addCandidate(`${baseName}+${variant.nameSuffix}`, variant.dsn);
    }
  }

  for (const candidate of normalized) {
    const { name, dsn } = candidate;
    const poolerUserVariant = buildSupabasePoolerUserVariant(dsn, options);
    if (poolerUserVariant) {
      await addCandidateLadder(`${name}+${poolerUserVariant.nameSuffix}`, poolerUserVariant.dsn);
      // Keep the original DSN as a final fallback if pooler-user normalization
      // cannot be used by the target project.
      addCandidate(name, dsn);
      continue;
    }
    await addCandidateLadder(name, dsn);
  }

  return candidates;
}

module.exports = {
  applyPinnedDbSelectionPreference,
  buildDbConnectionCandidates,
  buildPinnedDbSelectionCandidate,
  resolvePinnedDbSelectionName,
  buildSupabasePoolerHostVariants,
  buildSupabasePoolerPortVariants,
  buildSupabasePoolerUserVariant,
};
