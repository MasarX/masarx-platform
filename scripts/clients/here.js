const { Pool } = require('pg');
const { loadEnv } = require('../utils/load-env');

loadEnv();

const fetchImpl = globalThis.fetch;
if (!fetchImpl) {
  throw new Error('[here-client] Global fetch is not available. Upgrade to Node 18+.');
}

const DEFAULT_BASE_URL = 'https://geocode.search.hereapi.com/v1';
const PROVIDER_NAME = 'here_geocoding';

const createPool = () => {
  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) return null;
  return new Pool({ connectionString });
};

let pool = createPool();
let poolClosed = false;

let CONFIG;

const getPool = () => {
  if (!pool) return null;
  if (poolClosed) {
    pool = createPool();
    poolClosed = false;
  }
  return pool;
};

const normalizeUrl = (value) => {
  if (!value) return DEFAULT_BASE_URL;
  return value.endsWith('/') ? value.slice(0, -1) : value;
};

const parseMockFlag = (value) => {
  if (typeof value === 'boolean') return value;
  if (typeof value === 'string') {
    const normalized = value.trim().toLowerCase();
    return ['true', '1', 'yes', 'mock'].includes(normalized);
  }
  return false;
};

const computeHash = (value) => {
  let hash = 0;
  const input = String(value ?? '');
  for (let index = 0; index < input.length; index += 1) {
    hash = (hash * 31 + input.charCodeAt(index)) >>> 0;
  }
  return hash;
};

const buildMockPosition = (seedValue) => {
  const hash = computeHash(seedValue);
  const lat = ((hash % 1800000) / 10000) - 90; // -90 .. <90
  const lng = ((((hash / 1800000) >>> 0) % 3600000) / 10000) - 180; // -180 .. <180
  return {
    lat: Number(lat.toFixed(6)),
    lng: Number(lng.toFixed(6)),
  };
};

const buildMockGeocodeResponse = (query) => {
  const position = buildMockPosition(query);
  return {
    mock: true,
    query,
    items: [
      {
        id: `mock-geocode-${computeHash(query)}`,
        title: `Mock geocode result for "${query}"`,
        resultType: 'mock',
        address: {
          label: `Mock address for "${query}"`
        },
        position,
        scoring: {
          fieldScore: {
            city: 1
          }
        }
      }
    ]
  };
};

const buildMockReverseResponse = (position) => {
  return {
    mock: true,
    position,
    items: [
      {
        id: `mock-reverse-${computeHash(`${position.lat},${position.lng}`)}`,
        title: `Mock reverse geocode for ${position.lat},${position.lng}`,
        resultType: 'mock',
        address: {
          label: `Mock address at ${position.lat},${position.lng}`
        },
        position: {
          lat: Number(Number(position.lat).toFixed(6)),
          lng: Number(Number(position.lng).toFixed(6))
        }
      }
    ]
  };
};

const fetchConfigFromEnv = () => {
  const metadataMock = parseMockFlag(process.env.HERE_GEOCODING_MOCK);
  const apiKey = process.env.HERE_GEOCODING_API_KEY || null;
  const fallbackApiKey = process.env.HERE_GEOCODING_FALLBACK_API_KEY ?? null;
  const baseUrl = normalizeUrl(process.env.HERE_GEOCODING_BASE_URL ?? DEFAULT_BASE_URL);

  if (!apiKey && !metadataMock) {
    return null;
  }

  return {
    baseUrl,
    apiKey,
    fallbackApiKey,
    mock: metadataMock,
  };
};

const fetchConfigFromDatabase = async () => {
  const activePool = getPool();
  if (!activePool) {
    throw new Error('[here-client] DATABASE_URL is required to load provider config from the database.');
  }
  const client = await getPool().connect();
  try {
    const { rows } = await client.query(
      `
        WITH provider_row AS (
          SELECT id, metadata
          FROM providers
          WHERE name = $1
          LIMIT 1
        ),
        auth_row AS (
          SELECT id AS auth_config_id
          FROM provider_auth_configs
          WHERE provider_id = (SELECT id FROM provider_row)
            AND NOT marketplace_explicit_only
          ORDER BY created_at DESC
          LIMIT 1
        )
        SELECT
          (SELECT id FROM provider_row) AS provider_id,
          (SELECT metadata FROM provider_row) AS metadata,
          CASE
            WHEN (SELECT auth_config_id FROM auth_row) IS NOT NULL
              THEN public.get_provider_auth_credentials((SELECT auth_config_id FROM auth_row))
            ELSE NULL
          END AS credentials
      `,
      [PROVIDER_NAME]
    );

    if (!rows.length || !rows[0].provider_id) {
      throw new Error(`[here-client] Provider configuration for "${PROVIDER_NAME}" is missing in the database.`);
    }

    const metadata = rows[0].metadata || {};
    const credentials = rows[0].credentials || {};
    const apiKey = credentials.api_key;

    const mock = parseMockFlag(metadata.mock);

    if (!apiKey && !mock) {
      throw new Error('[here-client] API key missing from provider_auth_configs.');
    }

    const fallbackApiKey = credentials.fallback_api_key ?? null;

    return {
      baseUrl: normalizeUrl(metadata.base_url ?? metadata.baseUrl ?? DEFAULT_BASE_URL),
      apiKey: apiKey || null,
      fallbackApiKey,
      mock,
    };
  } finally {
    client.release();
  }
};

const ensureConfig = async () => {
  if (!CONFIG) {
    const envConfig = fetchConfigFromEnv();

    // Prefer DB-backed config (SSOT). Fall back to env-only config when DATABASE_URL is not available
    // (useful for isolated live API tests that do not require a database).
    try {
      if (getPool()) {
        CONFIG = await fetchConfigFromDatabase();
      } else if (envConfig) {
        CONFIG = envConfig;
      } else {
        throw new Error('[here-client] DATABASE_URL is required. Set ENV_FILE or export DATABASE_URL.');
      }
    } catch (err) {
      if (envConfig) {
        CONFIG = envConfig;
      } else {
        throw err;
      }
    }
  }
  return CONFIG;
};

const buildUrl = async (path, params) => {
  const config = await ensureConfig();
  const url = new URL(`${config.baseUrl}${path}`);
  Object.entries(params).forEach(([key, value]) => {
    if (value !== undefined && value !== null) {
      url.searchParams.append(key, value);
    }
  });
  return { url, apiKey: config.apiKey };
};

const geocode = async (query, opts = {}) => {
  const config = await ensureConfig();
  if (config.mock) {
    return buildMockGeocodeResponse(query);
  }

  if (!config.apiKey) {
    throw new Error('[here-client] API key configuration missing for live geocode request.');
  }

  const { url, apiKey } = await buildUrl('/geocode', {
    q: query,
    in: opts.in ?? opts['in'],
    types: opts.types,
    limit: String(opts.limit ?? 1),
    lang: opts.lang || 'en',
  });
  url.searchParams.append('apiKey', opts.apiKey || apiKey);

  const response = await fetchImpl(url.toString());
  if (!response.ok) {
    const text = await response.text();
    throw new Error(`[here-client] Geocode failed: ${response.status} ${response.statusText} ${text}`);
  }
  return response.json();
};

const reverseGeocode = async ({ lat, lng }, opts = {}) => {
  const config = await ensureConfig();
  if (config.mock) {
    return buildMockReverseResponse({ lat, lng });
  }

  if (!config.apiKey) {
    throw new Error('[here-client] API key configuration missing for live reverse geocode request.');
  }

  const { url, apiKey } = await buildUrl('/revgeocode', {
    at: `${lat},${lng}`,
    limit: String(opts.limit ?? 1),
    lang: opts.lang,
  });
  url.searchParams.append('apiKey', opts.apiKey || apiKey);

  const response = await fetchImpl(url.toString());
  if (!response.ok) {
    const text = await response.text();
    throw new Error(`[here-client] Reverse geocode failed: ${response.status} ${response.statusText} ${text}`);
  }
  return response.json();
};

const getConfig = async () => {
  const config = await ensureConfig();
  return { ...config };
};

const shutdown = async () => {
  CONFIG = undefined;
  if (poolClosed) return;
  poolClosed = true;
  try {
    await pool.end();
  } catch (_error) {
    // Ignore pool shutdown errors during teardown.
  }
};

process.on('exit', () => {
  void shutdown();
});

module.exports = {
  geocode,
  reverseGeocode,
  getConfig,
  shutdown,
};
