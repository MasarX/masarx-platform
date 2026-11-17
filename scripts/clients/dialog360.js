const { Pool } = require('pg');
const { loadEnv } = require('../utils/load-env');

loadEnv();

const fetchImpl = globalThis.fetch;
if (!fetchImpl) {
  throw new Error('[360dialog-client] Global fetch is not available. Upgrade to Node 18+.');
}

const PROVIDER_NAME = 'dialog360_whatsapp';
const PROVIDER_DEFAULTS_CATEGORY = 'provider_defaults';

const createPool = () => {
  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) {
    throw new Error('[360dialog-client] DATABASE_URL is required. Set ENV_FILE or export DATABASE_URL.');
  }
  return new Pool({ connectionString });
};

let pool = createPool();
let poolClosed = false;

let CONFIG;

const getPool = () => {
  if (poolClosed) {
    pool = createPool();
    poolClosed = false;
  }
  return pool;
};

const normalizeRecipient = (value) => {
  if (!value) return value;
  const digits = value.replace(/[^\d+]/g, '');
  if (!digits.length) return undefined;
  if (digits.startsWith('+')) {
    return digits.slice(1);
  }
  return digits;
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

const buildMockResponse = ({ recipient, type, templateName, body }) => {
  const seed = `${recipient || ''}:${type}:${templateName || ''}:${body || ''}`;
  const id = `mock-${type}-${computeHash(seed)}`;
  return {
    mock: true,
    messages: [
      {
        id,
      },
    ],
    recipient,
    type,
  };
};

const joinUrl = (baseUrl, path) => {
  const base = String(baseUrl || '').replace(/\/+$/, '');
  const suffix = String(path || '').replace(/^\/+/, '');
  if (!base || !suffix) return `${base}${suffix}`;
  return `${base}/${suffix}`;
};

const resolveObjectPath = (target, path) => {
  if (!path) return undefined;
  const segments = path.split('.').map((segment) => segment.trim()).filter(Boolean);
  let current = target;
  for (const segment of segments) {
    if (current === null || current === undefined) {
      return undefined;
    }
    if (Array.isArray(current)) {
      const index = Number(segment);
      if (Number.isNaN(index) || index < 0 || index >= current.length) {
        return undefined;
      }
      current = current[index];
      continue;
    }
    if (typeof current === 'object') {
      current = current[segment];
      continue;
    }
    return undefined;
  }
  return current;
};

const renderTemplate = (template, context) => {
  if (template === null || template === undefined) return template;

  if (Array.isArray(template)) {
    return template.map((item) => renderTemplate(item, context));
  }

  if (typeof template === 'object') {
    const result = {};
    for (const [key, value] of Object.entries(template)) {
      result[key] = renderTemplate(value, context);
    }
    return result;
  }

  if (typeof template !== 'string') {
    return template;
  }

  if (!template.includes('{{')) {
    return template;
  }

  const MUSTACHE_REGEX = /{{\s*([^}]+)\s*}}/g;
  return template.replace(MUSTACHE_REGEX, (_match, token) => {
    const resolved = resolveObjectPath(context, token);
    if (resolved === undefined || resolved === null) {
      return '';
    }
    return typeof resolved === 'object' ? JSON.stringify(resolved) : String(resolved);
  });
};

const fetchConfigFromDatabase = async () => {
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
        ),
        defaults_row AS (
          SELECT cached_value
          FROM settings
          WHERE category = $2
            AND scope_type = 'resource'
            AND scope_id = (SELECT id FROM provider_row)
          LIMIT 1
        )
        SELECT
          (SELECT id FROM provider_row) AS provider_id,
          (SELECT metadata FROM provider_row) AS metadata,
          CASE
            WHEN (SELECT auth_config_id FROM auth_row) IS NOT NULL
              THEN public.get_provider_auth_credentials((SELECT auth_config_id FROM auth_row))
            ELSE NULL
          END AS credentials,
          (SELECT cached_value FROM defaults_row) AS defaults
      `,
      [PROVIDER_NAME, PROVIDER_DEFAULTS_CATEGORY]
    );

    if (!rows.length || !rows[0].provider_id) {
      throw new Error('[360dialog-client] Provider configuration missing in database.');
    }

    const metadata = rows[0].metadata || {};
    const credentials = rows[0].credentials || {};
    const defaults = rows[0].defaults || {};

    const apiKey = credentials.api_key;
    const mock = parseMockFlag(metadata.mock);

    if (!apiKey && !mock) {
      throw new Error('[360dialog-client] API key missing from provider_auth_configs.');
    }

    const baseUrl = metadata.base_url ?? metadata.baseUrl ?? null;
    if (!baseUrl) {
      throw new Error('[360dialog-client] Provider base_url missing in providers.metadata.');
    }

    const messagingProduct = defaults.messaging_product ?? defaults.messagingProduct ?? null;
    if (!messagingProduct) {
      throw new Error('[360dialog-client] Provider defaults missing messaging_product.');
    }
    const defaultRecipient = normalizeRecipient(defaults.default_recipient);

    const whatsapp = defaults.whatsapp || {};

    const messagesPath = whatsapp.messages_path ?? whatsapp.messagesPath ?? null;
    if (!messagesPath) {
      throw new Error('[360dialog-client] Provider defaults missing whatsapp.messages_path.');
    }

    const apiKeyHeader = whatsapp.api_key_header ?? whatsapp.apiKeyHeader ?? null;
    if (!apiKeyHeader) {
      throw new Error('[360dialog-client] Provider defaults missing whatsapp.api_key_header.');
    }

    const headersTemplate = whatsapp.headers_template ?? whatsapp.headersTemplate ?? null;
    if (!headersTemplate || typeof headersTemplate !== 'object') {
      throw new Error('[360dialog-client] Provider defaults missing whatsapp.headers_template.');
    }

    const textBodyTemplate = whatsapp.text_body_template ?? whatsapp.textBodyTemplate ?? null;
    if (!textBodyTemplate || typeof textBodyTemplate !== 'object') {
      throw new Error('[360dialog-client] Provider defaults missing whatsapp.text_body_template.');
    }

    return {
      baseUrl: baseUrl.endsWith('/') ? baseUrl.slice(0, -1) : baseUrl,
      apiKey: apiKey || null,
      messagingProduct,
      defaultRecipient,
      mock,
      whatsapp: {
        messagesPath,
        apiKeyHeader,
        headersTemplate,
        textBodyTemplate,
      },
    };
  } finally {
    client.release();
  }
};

const ensureConfig = async () => {
  if (!CONFIG) {
    CONFIG = await fetchConfigFromDatabase();
  }
  return CONFIG;
};

const buildHeaders = async () => {
  const config = await ensureConfig();
  const rendered = renderTemplate(config.whatsapp.headersTemplate, {
    api_key: config.apiKey,
    messaging_product: config.messagingProduct,
    default_recipient: config.defaultRecipient,
  });

  const baseHeaders = {};
  for (const [key, value] of Object.entries(rendered || {})) {
    if (value === undefined || value === null) continue;
    baseHeaders[key] = String(value);
  }

  if (config.apiKey) {
    baseHeaders[config.whatsapp.apiKeyHeader] = config.apiKey;
  }

  if (config.mock) {
    return {
      ...baseHeaders,
      'x-mock-mode': 'true',
    };
  }

  return baseHeaders;
};

const sendTemplateMessage = async ({
  to,
  templateName,
  language = 'en_US',
  components = [],
  messagingProduct,
}) => {
  const config = await ensureConfig();
  const recipient = normalizeRecipient(to) || config.defaultRecipient;
  if (!recipient) {
    throw new Error('[360dialog-client] Recipient phone number is required. Configure provider defaults.');
  }
  if (!templateName) {
    throw new Error('[360dialog-client] Template name is required for template messages.');
  }

  if (config.mock) {
    return buildMockResponse({ recipient, type: 'template', templateName });
  }

  if (!config.apiKey) {
    throw new Error('[360dialog-client] API key configuration missing for live template message request.');
  }

  const payload = {
    to: recipient,
    type: 'template',
    messaging_product: messagingProduct || config.messagingProduct,
    template: {
      name: templateName,
      language: { code: language },
      components,
    },
  };

  const response = await fetchImpl(joinUrl(config.baseUrl, config.whatsapp.messagesPath), {
    method: 'POST',
    headers: await buildHeaders(),
    body: JSON.stringify(payload),
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`[360dialog-client] Template send failed: ${response.status} ${response.statusText} ${text}`);
  }

  return response.json();
};

const sendTextMessage = async ({ to, body, messagingProduct }) => {
  const config = await ensureConfig();
  const recipient = normalizeRecipient(to) || config.defaultRecipient;
  if (!recipient) {
    throw new Error('[360dialog-client] Recipient phone number is required. Configure provider defaults.');
  }
  if (!body) {
    throw new Error('[360dialog-client] Body is required for text messages.');
  }

  if (config.mock) {
    return buildMockResponse({ recipient, type: 'text', body });
  }

  if (!config.apiKey) {
    throw new Error('[360dialog-client] API key configuration missing for live text message request.');
  }

  const payload = renderTemplate(config.whatsapp.textBodyTemplate, {
    recipient,
    messaging_product: messagingProduct || config.messagingProduct,
    message_text: body,
  });

  const response = await fetchImpl(joinUrl(config.baseUrl, config.whatsapp.messagesPath), {
    method: 'POST',
    headers: await buildHeaders(),
    body: JSON.stringify(payload),
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`[360dialog-client] Text send failed: ${response.status} ${response.statusText} ${text}`);
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
  sendTemplateMessage,
  sendTextMessage,
  getConfig,
  shutdown,
};
