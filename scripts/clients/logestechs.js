const crypto = require('node:crypto');
const { Pool } = require('pg');
const { loadEnv } = require('../utils/load-env');

loadEnv();

const fetchImpl = globalThis.fetch;
if (!fetchImpl) {
  throw new Error('[logestechs-client] Global fetch is not available. Upgrade to Node 18+.');
}

const DEFAULT_BASE_URL = 'https://apisv2.logestechs.com';
const PROVIDER_NAME = 'logestechs_3pl';
const PROVIDER_DEFAULTS_CATEGORY = 'provider_defaults';

if (!process.env.DATABASE_URL) {
  throw new Error('[logestechs-client] DATABASE_URL is required. Set ENV_FILE or export DATABASE_URL.');
}
const pool = new Pool({ connectionString: process.env.DATABASE_URL });

let CONFIG;

const cloneObject = (value) =>
  value && typeof value === 'object' ? JSON.parse(JSON.stringify(value)) : value;

const deepMerge = (base, override) => {
  const result = cloneObject(base) ?? {};
  if (!override) {
    return result;
  }

  for (const [key, value] of Object.entries(override)) {
    if (
      value &&
      typeof value === 'object' &&
      !Array.isArray(value) &&
      result[key] &&
      typeof result[key] === 'object' &&
      !Array.isArray(result[key])
    ) {
      result[key] = deepMerge(result[key], value);
    } else if (value !== undefined) {
      result[key] = value;
    }
  }

  return result;
};

const coerceNumber = (value) => {
  if (value === undefined || value === null || value === '') {
    return undefined;
  }
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
};

const mapDefaults = (input = {}) => ({
  companyId: coerceNumber(input.company_id ?? input.companyId),
  serviceType: input.service_type ?? input.serviceType ?? null,
  shipmentType: input.shipment_type ?? input.shipmentType ?? null,
  integrationSource: input.integration_source ?? input.integrationSource ?? null,
  senderName: input.sender_name ?? input.senderName ?? null,
  businessSenderName: input.business_sender_name ?? input.businessSenderName ?? null,
  senderPhone: input.sender_phone ?? input.senderPhone ?? null,
  receiverName: input.receiver_name ?? input.receiverName ?? null,
  receiverPhone: input.receiver_phone ?? input.receiverPhone ?? null,
  receiverPhone2: input.receiver_phone_secondary ?? input.receiverPhoneSecondary ?? '',
  notes: input.package_notes ?? input.notes ?? '',
  description: input.description ?? null,
  packageItemName: input.package_item_name ?? input.packageItemName ?? null,
  destinationVillage: input.destination_village ?? input.destinationVillage ?? null,
  pkgUnitType: input.unit_type ?? input.unitType ?? 'METRIC',
  packageTemplate: input.package_template ?? input.packageTemplate ?? null,
  originTemplate: input.origin_template ?? input.originTemplate ?? null,
  destinationTemplate: input.destination_template ?? input.destinationTemplate ?? null,
  packageItems: input.package_items ?? input.packageItems ?? null,
  packageWeight: coerceNumber(input.package_weight ?? input.packageWeight),
  packageWidth: coerceNumber(input.package_width ?? input.packageWidth),
  packageLength: coerceNumber(input.package_length ?? input.packageLength),
  packageHeight: coerceNumber(input.package_height ?? input.packageHeight),
  cod: coerceNumber(input.cod),
});

const fetchConfigFromDatabase = async () => {
  const client = await pool.connect();
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
      throw new Error(
        `[logestechs-client] Provider configuration for "${PROVIDER_NAME}" is missing in the database.`
      );
    }

    const metadata = rows[0].metadata || {};
    const credentials = rows[0].credentials || {};
    const defaults = mapDefaults(rows[0].defaults || {});

    const username = credentials.username;
    const password = credentials.password;
    if (!username || !password) {
      throw new Error(
        '[logestechs-client] Provider auth credentials (username/password) are missing from provider_auth_configs.'
      );
    }

    const companyIdRaw =
      metadata.company_id ??
      metadata.companyId ??
      defaults.companyId ??
      defaults.company_id ??
      defaults.company_id;
    const companyId = Number.isFinite(Number(companyIdRaw)) ? Number(companyIdRaw) : 1;

    return {
      baseUrl: metadata.base_url ?? metadata.baseUrl ?? DEFAULT_BASE_URL,
      companyId: companyId > 0 ? companyId : 1,
      username,
      password,
      defaults,
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

const resolvePackageItems = (override) => {
  if (override === null) {
    return null;
  }
  if (Array.isArray(override) && override.length) {
    return override;
  }

  if (
    CONFIG.defaults.packageTemplate &&
    Array.isArray(CONFIG.defaults.packageTemplate.packageItemsToDeliverList) &&
    CONFIG.defaults.packageTemplate.packageItemsToDeliverList.length
  ) {
    return cloneObject(CONFIG.defaults.packageTemplate.packageItemsToDeliverList);
  }

  if (Array.isArray(CONFIG.defaults.packageItems) && CONFIG.defaults.packageItems.length) {
    return cloneObject(CONFIG.defaults.packageItems);
  }

  if (CONFIG.defaults.packageItemName) {
    return [
      {
        name: CONFIG.defaults.packageItemName,
        cod: 0,
      },
    ];
  }

  return [];
};

const deriveSenderName = () => {
  if (CONFIG.defaults.senderName) return CONFIG.defaults.senderName;
  if (CONFIG.username) {
    const local = CONFIG.username.split('@')[0];
    return local.replace(/[^a-zA-Z0-9_-]/g, '') || undefined;
  }
  return undefined;
};

const ensureAtLeastOneField = (obj, message) => {
  if (!obj || Object.values(obj).every((value) => value === undefined || value === null || value === '')) {
    throw new Error(message);
  }
  return obj;
};

const assignIfDefined = (target, key, value) => {
  if (value !== undefined && value !== null) {
    target[key] = value;
  }
};

const buildDestinationAddress = (destination = {}) => {
  const template = cloneObject(CONFIG.defaults.destinationTemplate) ?? {};
  if (CONFIG.defaults.destinationVillage && !template.village) {
    template.village = CONFIG.defaults.destinationVillage;
  }
  const merged = deepMerge(template, destination);
  return ensureAtLeastOneField(
    merged,
    '[logestechs-client] destinationAddress must include at least one property. Configure provider_defaults.destination_template or provide a destination override.'
  );
};

const buildOriginAddress = (origin = {}) => {
  const template = cloneObject(CONFIG.defaults.originTemplate) ?? {};
  const merged = deepMerge(template, origin);
  return merged && Object.keys(merged).length ? merged : undefined;
};

const ensureFields = (pkg) => {
  const required = [
    ['serviceType', 'provider_defaults.service_type'],
    ['shipmentType', 'provider_defaults.shipment_type'],
    ['integrationSource', 'provider_defaults.integration_source'],
    ['senderName', 'provider_defaults.sender_name'],
    ['senderPhone', 'provider_defaults.sender_phone'],
    ['receiverName', 'provider_defaults.receiver_name'],
    ['receiverPhone', 'provider_defaults.receiver_phone'],
  ];

  for (const [field, source] of required) {
    if (!pkg[field]) {
      throw new Error(
        `[logestechs-client] Missing '${field}'. Configure ${source} in settings (provider scope) or provide the field in packagePayload.`
      );
    }
  }

  return pkg;
};

const request = async (path, { method = 'GET', body, headers = {} } = {}) => {
  const config = await ensureConfig();
  const response = await fetchImpl(`${config.baseUrl}${path}`, {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined,
  });

  const text = await response.text();
  let json;
  try {
    json = text ? JSON.parse(text) : {};
  } catch {
    json = text;
  }

  if (!response.ok) {
    throw new Error(
      `[logestechs-client] ${method} ${path} failed: ${response.status} ${response.statusText} ${text}`
    );
  }

  return json;
};

const buildHeaders = async (extra = {}) => {
  const config = await ensureConfig();
  return {
    'content-type': 'application/json',
    'company-id': String(config.companyId),
    ...extra,
  };
};

const buildShipmentPayload = async ({
  email,
  password,
  packagePayload = {},
  destination = {},
  origin,
  originAddress,
  pkgUnitType,
} = {}) => {
  await ensureConfig();

  const authEmail = email ?? CONFIG.username;
  const authPassword = password ?? CONFIG.password;

  if (!authEmail || !authPassword) {
    throw new Error(
      '[logestechs-client] Provider auth credentials missing. Ensure provider_auth_configs contains username/password.'
    );
  }

  const basePackage = {
    receiverName: CONFIG.defaults.receiverName,
    cod: typeof CONFIG.defaults.cod === 'number' ? CONFIG.defaults.cod : 0,
    notes: CONFIG.defaults.notes,
    supplierInvoice: `INV-${Date.now()}`,
    packageItemsToDeliverList: resolvePackageItems(packagePayload.packageItemsToDeliverList),
    senderName: deriveSenderName(),
    businessSenderName: CONFIG.defaults.businessSenderName ?? deriveSenderName(),
    senderPhone: CONFIG.defaults.senderPhone,
    receiverPhone: CONFIG.defaults.receiverPhone,
    receiverPhone2: CONFIG.defaults.receiverPhone2 ?? '',
    serviceType: CONFIG.defaults.serviceType,
    shipmentType: CONFIG.defaults.shipmentType,
    quantity: 1,
    description:
      packagePayload.description ??
      CONFIG.defaults.description ??
      `Automation shipment ${Date.now()}`,
    integrationSource: CONFIG.defaults.integrationSource,
  };
  assignIfDefined(basePackage, 'weight', CONFIG.defaults.packageWeight);
  assignIfDefined(basePackage, 'width', CONFIG.defaults.packageWidth);
  assignIfDefined(basePackage, 'length', CONFIG.defaults.packageLength);
  assignIfDefined(basePackage, 'height', CONFIG.defaults.packageHeight);

  const packageTemplate = cloneObject(CONFIG.defaults.packageTemplate) ?? {};
  if (!packageTemplate.packageItemsToDeliverList) {
    delete packageTemplate.packageItemsToDeliverList;
  }

  const pkg = deepMerge(basePackage, packageTemplate);
  if (packagePayload.packageItemsToDeliverList) {
    pkg.packageItemsToDeliverList = packagePayload.packageItemsToDeliverList;
  }
  const mergedPkg = deepMerge(pkg, packagePayload);
  const invoiceSeed =
    packagePayload.invoiceNumber || packagePayload.supplierInvoice || `INV-${Date.now()}`;
  mergedPkg.invoiceNumber = invoiceSeed;
  if (
    mergedPkg.supplierInvoice === undefined ||
    mergedPkg.supplierInvoice === null ||
    mergedPkg.supplierInvoice === ''
  ) {
    mergedPkg.supplierInvoice = invoiceSeed;
  }

  ensureFields(mergedPkg);

  const destinationAddress = buildDestinationAddress(destination);
  const originSource = origin ?? originAddress;
  const resolvedOrigin = buildOriginAddress(originSource);

  const payload = {
    email: authEmail,
    password: authPassword,
    pkg: mergedPkg,
    destinationAddress,
    pkgUnitType: pkgUnitType ?? CONFIG.defaults.pkgUnitType ?? 'METRIC',
  };
  if (resolvedOrigin) {
    payload.originAddress = resolvedOrigin;
  }
  return payload;
};

const login = async ({
  email,
  password,
  companyId,
} = {}) => {
  await ensureConfig();
  const headers = await buildHeaders();
  const authEmail = email ?? CONFIG.username;
  const authPassword = password ?? CONFIG.password;

  if (!authEmail || !authPassword) {
    throw new Error(
      '[logestechs-client] Provider auth credentials missing. Ensure provider_auth_configs contains username/password.'
    );
  }

  return request('/api/auth/customer/login', {
    method: 'POST',
    headers,
    body: {
      email: authEmail,
      password: authPassword,
      device: {
        operatingSystem: 'automation',
        UUID: crypto.randomUUID(),
      },
      companyId: companyId ?? CONFIG.companyId,
    },
  });
};

const createShipment = async (options = {}) => {
  const body = await buildShipmentPayload(options);
  const headers = await buildHeaders();
  return request('/api/ship/request/by-email', {
    method: 'POST',
    headers,
    body,
  });
};

const cancelShipment = async (packageId, options = {}) => {
  if (!packageId) {
    throw new Error('packageId is required to cancel a shipment.');
  }
  await ensureConfig();

  const headers = await buildHeaders();
  const authEmail = options.email ?? CONFIG.username;
  const authPassword = options.password ?? CONFIG.password;

  if (!authEmail || !authPassword) {
    throw new Error(
      '[logestechs-client] Provider auth credentials missing. Ensure provider_auth_configs contains username/password.'
    );
  }

  return request(`/api/guests/${CONFIG.companyId}/packages/${packageId}/cancel`, {
    method: 'PUT',
    headers,
    body: {
      email: authEmail,
      password: authPassword,
    },
  });
};

const printAwb = async (ids = []) => {
  await ensureConfig();
  const headers = await buildHeaders();
  return request(`/api/guests/${CONFIG.companyId}/packages/pdf`, {
    method: 'POST',
    headers,
    body: { ids },
  });
};

const getConfig = async () => {
  const config = await ensureConfig();
  return cloneObject(config);
};

process.on('exit', () => {
  void pool.end();
});

module.exports = {
  login,
  createShipment,
  cancelShipment,
  printAwb,
  buildShipmentPayload,
  buildHeaders,
  getConfig,
};
