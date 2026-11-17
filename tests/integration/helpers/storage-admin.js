const { loadEnv } = require('../../../scripts/utils/load-env');
const { fetchTextWithRetry } = require('./http');

loadEnv();

const JWT_COMPACT_PATTERN = /^[A-Za-z0-9\-_]+\.[A-Za-z0-9\-_]+\.[A-Za-z0-9\-_]+$/;

const normalizeCandidate = (value) => String(value || '').trim();

const resolveStorageAdminKey = () =>
  resolveStorageAdminKeyCandidates().find((candidate) => Boolean(candidate)) || null;

const resolveStorageAdminKeyCandidates = (storageAdminKey = null) => {
  const candidates = [];
  const pushUnique = (value) => {
    const normalized = normalizeCandidate(value);
    if (!normalized || candidates.includes(normalized)) return;
    candidates.push(normalized);
  };
  const addCandidates = (value) => {
    if (Array.isArray(value)) {
      value.forEach((entry) => addCandidates(entry));
      return;
    }
    pushUnique(value);
  };

  addCandidates(storageAdminKey);
  pushUnique(process.env.SUPABASE_SECRET_KEY);
  pushUnique(process.env.SUPABASE_SERVICE_ROLE_KEY);
  pushUnique(process.env.SERVICE_ROLE_KEY);
  pushUnique(process.env.SUPABASE_SERVICE_KEY);

  const compactJwtCandidates = candidates.filter(isCompactJwtToken);
  if (compactJwtCandidates.length > 0) {
    const compactSet = new Set(compactJwtCandidates);
    const others = candidates.filter((candidate) => !compactSet.has(candidate));
    return [...compactJwtCandidates, ...others];
  }

  return candidates;
};

const isCompactJwtToken = (token) => JWT_COMPACT_PATTERN.test(normalizeCandidate(token));

function isStorageAuthFailure(status, bodyText) {
  const code = Number(status || 0);
  const text = String(bodyText || '').toLowerCase();
  return (
    [400, 401, 403].includes(code) &&
    (text.includes('signature verification failed') ||
      text.includes('invalid compact jws') ||
      text.includes('invalid jwt') ||
      text.includes("required property 'authorization'") ||
      text.includes('required property "authorization"') ||
      text.includes('unauthorized'))
  );
}

function shouldTolerateStorageStatus(options, status, bodyText) {
  const code = Number(status || 0);
  const toleratedStatuses = Array.isArray(options?.tolerateStatuses)
    ? options.tolerateStatuses
      .map((value) => Number(value))
      .filter((value) => Number.isFinite(value))
    : [];

  if (toleratedStatuses.includes(code)) {
    return true;
  }

  if (typeof options?.tolerateStatusBody === 'function') {
    try {
      return Boolean(options.tolerateStatusBody(code, String(bodyText || '')));
    } catch (_err) {
      return false;
    }
  }

  return false;
}

async function requestStorageWithAuthCandidates({ url, init = {}, options = {} }) {
  const candidates = Array.isArray(options.storageAdminKeyCandidates)
    ? options.storageAdminKeyCandidates
    : resolveStorageAdminKeyCandidates(options.storageAdminKey);

  if (!candidates.length) {
    throw new Error('No storage admin key candidates available');
  }

  const attempts = Math.max(
    1,
    Number(
      options.fetchAttempts ||
        process.env.STORAGE_FETCH_ATTEMPTS ||
        process.env.E2E_HTTP_RETRY_ATTEMPTS ||
        4,
    ),
  );

  const baseDelayMs = Math.max(
    0,
    Number(
      options.baseDelayMs ||
        process.env.STORAGE_FETCH_BASE_DELAY_MS ||
        process.env.E2E_HTTP_RETRY_BASE_DELAY_MS ||
        250,
    ),
  );

  const maxDelayMs = Math.max(
    baseDelayMs,
    Number(
      options.maxDelayMs ||
        process.env.STORAGE_FETCH_MAX_DELAY_MS ||
        process.env.E2E_HTTP_RETRY_MAX_DELAY_MS ||
        4000,
    ),
  );

  let lastBodyText = '';
  let lastStatus = 0;

  for (let idx = 0; idx < candidates.length; idx += 1) {
    const storageAdminKey = candidates[idx];
    const explicitAuthorization =
      init.headers?.authorization ||
      init.headers?.Authorization ||
      '';
    const requestInit = {
      ...init,
      headers: {
        ...(init.headers || {}),
        apikey: init.headers?.apikey || storageAdminKey,
        authorization: explicitAuthorization || `Bearer ${storageAdminKey}`,
      },
    };

    const { resp, bodyText } = await fetchTextWithRetry(
      url,
      requestInit,
      {
        attempts,
        baseDelayMs,
        maxDelayMs,
        purpose: options.purpose || 'storage request',
      },
    );

    lastBodyText = bodyText;
    lastStatus = Number(resp.status);

    if (resp.ok) {
      return { resp, bodyText, storageAdminKey };
    }

    if (shouldTolerateStorageStatus(options, lastStatus, bodyText)) {
      return { resp, bodyText, storageAdminKey, toleratedStatus: true };
    }

    if ([400, 401, 403].includes(lastStatus) && options.allowFallbackOnStorageAuthError && idx < candidates.length - 1) {
      if (isStorageAuthFailure(lastStatus, bodyText)) {
        continue;
      }
    }

    const err = new Error(
      `Storage request failed (${lastStatus})${options.errorLabel ? ` for ${options.errorLabel}` : ''}: ${lastBodyText}`,
    );
    err.storageStatus = lastStatus;
    err.storageAdminKey = storageAdminKey;
    throw err;
  }

  const err = new Error(
    `Storage request failed for all auth candidates${options.errorLabel ? ` (${options.errorLabel})` : ''}: ${lastStatus} ${lastBodyText}`,
  );
  err.storageStatus = lastStatus;
  throw err;
}

async function ensureStorageBucket({
  supabaseUrl,
  bucket,
  storageAdminKey,
  storageAdminKeyCandidates,
  options = {},
}) {
  const baseUrl = String(supabaseUrl || process.env.SUPABASE_URL || '').trim().replace(/\/+$/, '');
  if (!baseUrl || !bucket) {
    throw new Error('ensureStorageBucket requires SUPABASE_URL and bucket name');
  }

  const url = `${baseUrl}/storage/v1/bucket`;
  const response = await requestStorageWithAuthCandidates({
    url,
    init: {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
      },
      body: JSON.stringify({ name: bucket, public: false }),
    },
    options: {
      storageAdminKey,
      storageAdminKeyCandidates,
      errorLabel: `bucket ${bucket}`,
      allowFallbackOnStorageAuthError: true,
      fetchAttempts: options.fetchAttempts,
      baseDelayMs: options.baseDelayMs,
      maxDelayMs: options.maxDelayMs,
      purpose: options.purpose || 'ensureStorageBucket',
      tolerateStatuses: [409],
      tolerateStatusBody: (status, bodyText) =>
        status === 400 && /duplicate/i.test(String(bodyText || '')),
    },
  });

  const text = String(response.bodyText || '');
  if ([200, 409].includes(response.resp.status)) {
    return;
  }

  if (response.resp.status === 400 && /duplicate/i.test(text)) {
    return;
  }

  const err = new Error(`Failed to ensure bucket ${bucket}: ${response.resp.status} ${text}`);
  err.storageStatus = response.resp.status;
  throw err;
}

async function uploadStorageObject({
  supabaseUrl,
  bucket,
  storagePath,
  body,
  contentType = 'application/octet-stream',
  storageAdminKey,
  storageAdminKeyCandidates,
  options = {},
}) {
  const baseUrl = String(supabaseUrl || process.env.SUPABASE_URL || '').trim().replace(/\/+$/, '');
  if (!baseUrl || !bucket || !storagePath) {
    throw new Error('uploadStorageObject requires SUPABASE_URL, bucket, and storagePath');
  }

  const url = `${baseUrl}/storage/v1/object/${bucket}/${encodeURI(storagePath)}`;
  const response = await requestStorageWithAuthCandidates({
    url,
    init: {
      method: 'PUT',
      headers: {
        'content-type': contentType,
        'x-upsert': 'true',
      },
      body,
    },
    options: {
      storageAdminKey,
      storageAdminKeyCandidates,
      errorLabel: `object ${storagePath}`,
      allowFallbackOnStorageAuthError: true,
      fetchAttempts: options.fetchAttempts,
      baseDelayMs: options.baseDelayMs,
      maxDelayMs: options.maxDelayMs,
      purpose: options.purpose || 'uploadStorageObject',
    },
  });

  if (!response.resp.ok) {
    const text = response.bodyText;
    const err = new Error(
      `Failed to upload storage object ${bucket}/${storagePath}: ${response.resp.status} ${text}`,
    );
    err.storageStatus = response.resp.status;
    throw err;
  }

  return response;
}

module.exports = {
  resolveStorageAdminKey,
  resolveStorageAdminKeyCandidates,
  isCompactJwtToken,
  isStorageAuthFailure,
  requestStorageWithAuthCandidates,
  ensureStorageBucket,
  uploadStorageObject,
};
