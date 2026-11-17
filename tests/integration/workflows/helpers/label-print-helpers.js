const { setTimeout: sleep } = require('timers/promises');
const {
  resolveStorageAdminKey,
  requestStorageWithAuthCandidates,
} = require('../../helpers/storage-admin');

const PDF_PLACEHOLDER_BASE64 =
  'JVBERi0xLjQKJb/3ov4KMSAwIG9iago8PAovVHlwZSAvQ2F0YWxvZwovUGFnZXMgMiAwIFIKPj4KZW5kb2JqCjIgMCBvYmoKPDwKL1R5cGUgL1BhZ2VzCi9LaWRzIFszIDAgUl0KL0NvdW50IDEKPj4KZW5kb2JqCjMgMCBvYmoKPDwKL1R5cGUgL1BhZ2UKL1BhcmVudCAyIDAgUgovTWVkaWFCb3ggWzAgMCA1OTUuMjggODQxLjg5XQovQ29udGVudHMgNCAwIFIKPj4KZW5kb2JqCjQgMCBvYmoKWy9QREYgLTEgL1RleHQgLTEgMCAwIF0KZW5kb2JqCnhyZWYKMCA1CjAwMDAwMDAwMDAgNjU1MzUgZiAKMDAwMDAwMDAxNyAwMDAwMCBuIAowMDAwMDAwMDUzIDAwMDAwIG4gCjAwMDAwMDAxMTMgMDAwMDAgbiAKMDAwMDAwMDE4MyAwMDAwMCBuIAp0cmFpbGVyCjw8Ci9Sb290IDEgMCBSCi9TaXplIDUKPj4Kc3RhcnR4cmVmCjI0NAolJUVPRgo=';

let cachedEdgeConfig = null;

function isRetryableHttpStatus(status) {
  return [408, 425, 429, 500, 502, 503, 504].includes(Number(status));
}

const resolveApiCallerAuthTokenCandidates = () => {
  const candidates = [
    process.env.EDGE_TASK_TOKEN,
    process.env.API_CALLER_SHARED_SECRET,
    process.env.API_CALLER_DB_JWT,
    process.env.LABEL_RENDERER_DB_JWT,
    process.env.LABEL_RENDERER_TOKEN,
    process.env.SUPABASE_SERVICE_ROLE_KEY,
    process.env.SERVICE_ROLE_KEY,
    process.env.SUPABASE_SERVICE_KEY,
  ]
    .map((value) => String(value || '').trim())
    .filter(Boolean);
  return Array.from(new Set(candidates));
};

const resolveApiCallerAuthToken = () => resolveApiCallerAuthTokenCandidates()[0] || null;

const resolveLabelProviderSecret = () =>
  process.env.LABEL_RENDERER_DB_JWT ||
  process.env.LABEL_RENDERER_TOKEN ||
  process.env.EDGE_TASK_TOKEN ||
  process.env.API_CALLER_DB_JWT ||
  process.env.SUPABASE_SECRET_KEY ||
  process.env.SUPABASE_SERVICE_ROLE_KEY ||
  process.env.SERVICE_ROLE_KEY ||
  process.env.SUPABASE_SERVICE_KEY ||
  null;

const isTransientFetchError = (error) => {
  if (!error) return false;
  const message = String(error.message || '').toLowerCase();
  const causeName = String(error.cause?.name || '').toLowerCase();
  const causeCode = String(error.cause?.code || '').toLowerCase();
  return (
    error.name === 'AbortError' ||
    message.includes('fetch failed') ||
    message.includes('timeout') ||
    causeName.includes('timeout') ||
    causeCode.includes('timeout')
  );
};

async function fetchWithRetry(url, init = {}, options = {}) {
  const attempts = Math.max(1, Number(options.attempts || process.env.LABEL_FETCH_MAX_ATTEMPTS || 4));
  const timeoutMs = Math.max(1000, Number(options.timeoutMs || process.env.LABEL_FETCH_TIMEOUT_MS || 20000));
  const baseDelayMs = Math.max(50, Number(options.baseDelayMs || process.env.LABEL_FETCH_RETRY_DELAY_MS || 300));

  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    let timeoutHandle;
    const controller = new AbortController();
    try {
      timeoutHandle = setTimeout(() => controller.abort(), timeoutMs);
      const response = await fetch(url, { ...init, signal: controller.signal });
      if (!isRetryableHttpStatus(response.status) || attempt >= attempts) {
        return response;
      }
    } catch (err) {
      if (attempt >= attempts || !isTransientFetchError(err)) {
        throw err;
      }
    } finally {
      if (timeoutHandle) clearTimeout(timeoutHandle);
    }

    await sleep(baseDelayMs * attempt);
  }

  throw new Error('fetchWithRetry exhausted attempts unexpectedly');
}

const resolveEdgeConfig = async (client) => {
  if (cachedEdgeConfig) {
    return cachedEdgeConfig;
  }

  // Prefer environment-driven resolution so tests work against modern
  // edge deployments where the api-caller function is addressed via the
  // standard Supabase functions URL pattern. This avoids coupling to
  // legacy helper functions that were removed in favour of settings-
  // driven provider defaults.
  const supabaseUrlEnv = process.env.SUPABASE_URL || process.env.EDGE_SUPABASE_URL || null;
  const sharedSecretEnv = resolveApiCallerAuthToken();
  const endpointFromEnv = supabaseUrlEnv
    ? `${supabaseUrlEnv.replace(/\/$/, '')}/functions/v1/api-caller`
    : null;

  let endpoint = endpointFromEnv;
  if (!endpoint) {
    const configRows = await client.query(
      `SELECT
         COALESCE(
           CASE
             WHEN to_regprocedure('public.resolve_api_caller_endpoint_v1()') IS NOT NULL
             THEN public.resolve_api_caller_endpoint_v1()
             ELSE NULL
           END,
           CASE
             WHEN to_regprocedure('public.resolve_api_caller_endpoint()') IS NOT NULL
             THEN public.resolve_api_caller_endpoint()
             ELSE NULL
           END
         ) AS endpoint`
    );
    endpoint = configRows.rows[0]?.endpoint || null;
  }
  const sharedSecret = sharedSecretEnv;
  const sharedSecrets = resolveApiCallerAuthTokenCandidates();

  if (!endpoint) {
    throw new Error(
      'Edge api-caller endpoint not configured (SUPABASE_URL/EDGE_SUPABASE_URL or resolve_api_caller_endpoint_v1)',
    );
  }

  if (!sharedSecret || !sharedSecrets.length) {
    throw new Error(
      'Edge api-caller auth token missing (EDGE_TASK_TOKEN/API_CALLER_SHARED_SECRET/API_CALLER_DB_JWT/SUPABASE_SERVICE_ROLE_KEY)',
    );
  }

  cachedEdgeConfig = { endpoint, sharedSecret, sharedSecrets };
  return cachedEdgeConfig;
};

const runOutboundWorker = async (client) => {
  await client.query('SELECT run_outbound_worker()');
};

const dispatchApiCallerBatch = async (client, batch = 10) => {
  const { endpoint, sharedSecret, sharedSecrets } = await resolveEdgeConfig(client);
  const authCandidates = Array.isArray(sharedSecrets) && sharedSecrets.length
    ? sharedSecrets
    : [sharedSecret].filter(Boolean);
  let lastError = null;

  for (const token of authCandidates) {
    const response = await fetchWithRetry(endpoint, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${token}`,
        ...(process.env.SUPABASE_ANON_KEY ? { apikey: process.env.SUPABASE_ANON_KEY } : {}),
      },
      body: JSON.stringify({ batch: Math.max(batch, 1) }),
    });

    const text = await response.text();
    let payload = {};
    if (text) {
      try {
        payload = JSON.parse(text);
      } catch (_err) {
        payload = { raw: text };
      }
    }

    if (response.ok) {
      return payload;
    }

    if ([401, 403].includes(response.status)) {
      lastError = new Error(`api-caller auth rejected token (status ${response.status})`);
      continue;
    }

    const reason = payload?.error || payload?.message || text || `status ${response.status}`;
    throw new Error(`api-caller batch failed: ${reason}`);
  }

  throw lastError || new Error('api-caller batch failed: no auth token candidates available');
};

const progressWorkflowRun = async (client, runId) => {
  const { rows } = await client.query(
    'SELECT progress_workflow_run($1::uuid) AS result',
    [runId],
  );
  return rows[0]?.result || null;
};

const completeBundleAsync = async (client, runId, requestId, options = {}) => {
  const {
    maxAttempts = 12,
    sleepMs = 500,
    batchSize = 10,
    progressRunOnComplete = true,
    dispatchApiCallerBatchEnabled = true,
  } = options;

  for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
    await runOutboundWorker(client);
    if (dispatchApiCallerBatchEnabled) {
      await dispatchApiCallerBatch(client, batchSize);
    }

    const { rows } = await client.query(
      'SELECT check_async_response($1::bigint) AS response',
      [requestId],
    );
    const response = rows[0]?.response || {};
    if (response.completed) {
      if (progressRunOnComplete) {
        await progressWorkflowRun(client, runId);
      }
      return response;
    }

    if (sleepMs > 0) {
      await sleep(sleepMs);
    }
  }

  throw new Error(
    `Async bundle request ${requestId} did not complete after ${maxAttempts} attempts`,
  );
};

const ensureLabelPdf = async (storagePath) => {
  const serviceRoleKey = resolveStorageAdminKey();
  const supabaseUrl = process.env.SUPABASE_URL || process.env.EDGE_SUPABASE_URL;
  const bucket =
    process.env.LABEL_RENDER_BUCKET ||
    process.env.LABEL_RENDERER_BUCKET ||
    'labels';

  if (!serviceRoleKey || !supabaseUrl) {
    throw new Error('SUPABASE_URL and a storage admin key (SUPABASE_SECRET_KEY/SUPABASE_SERVICE_ROLE_KEY) are required to seed label PDFs');
  }

  const uploadUrl = `${supabaseUrl}/storage/v1/object/${bucket}/${encodeURI(storagePath)}`;
  const pdfBytes = Buffer.from(PDF_PLACEHOLDER_BASE64, 'base64');
  const maxAttempts = Math.max(
    1,
    Number(
      process.env.LABEL_PDF_UPLOAD_MAX_ATTEMPTS ||
      process.env.LABEL_STORAGE_UPLOAD_MAX_ATTEMPTS ||
      5,
    ),
  );
  const retryDelayMs = Math.max(
    100,
    Number(
      process.env.LABEL_PDF_UPLOAD_RETRY_DELAY_MS ||
      process.env.LABEL_STORAGE_UPLOAD_RETRY_BASE_MS ||
      250,
    ),
  );

  const response = await requestStorageWithAuthCandidates({
    url: uploadUrl,
    init: {
      method: 'PUT',
      headers: {
        'content-type': 'application/pdf',
        'x-upsert': 'true',
      },
      body: pdfBytes,
    },
    options: {
      storageAdminKey: serviceRoleKey,
      allowFallbackOnStorageAuthError: true,
      fetchAttempts: maxAttempts,
      baseDelayMs: retryDelayMs,
      maxDelayMs: process.env.LABEL_STORAGE_UPLOAD_RETRY_MAX_MS
        ? Number(process.env.LABEL_STORAGE_UPLOAD_RETRY_MAX_MS)
        : undefined,
      purpose: 'ensureLabelPdf',
      errorLabel: `storagePath=${storagePath}`,
    },
  });

  if (!response.resp.ok) {
    const text = await response.resp.text().catch(() => '');
    throw new Error(`Failed to seed storage object ${storagePath} (${response.resp.status}): ${text}`);
  }
};

const generateSignedUrl = async (filePath, expiresSeconds = 600) => {
  const serviceRoleKey = resolveStorageAdminKey();
  const supabaseUrl = process.env.SUPABASE_URL || process.env.EDGE_SUPABASE_URL;
  const bucket =
    process.env.LABEL_RENDER_BUCKET ||
    process.env.LABEL_RENDERER_BUCKET ||
    'labels';

  if (!serviceRoleKey || !supabaseUrl) {
    throw new Error('SUPABASE_URL and a storage admin key (SUPABASE_SECRET_KEY/SUPABASE_SERVICE_ROLE_KEY) are required for signed URL minting');
  }

  const response = await requestStorageWithAuthCandidates({
    url: `${supabaseUrl}/storage/v1/object/sign/${bucket}`,
    init: {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        expiresIn: expiresSeconds,
        paths: [filePath],
      }),
    },
    options: {
      storageAdminKey: serviceRoleKey,
      allowFallbackOnStorageAuthError: true,
      purpose: 'generateSignedUrl',
      errorLabel: `filePath=${filePath}`,
    },
  });

  const body = await response.resp.text().catch(() => '');
  let parsed;
  try {
    parsed = body ? JSON.parse(body) : null;
  } catch (error) {
    throw new Error(`Signed URL response not JSON (${response.resp.status}): ${body}`);
  }

  if (!response.resp.ok) {
    const errorMessage = parsed?.error || parsed?.message || body || `status ${response.resp.status}`;
    throw new Error(`Failed to create signed URL: ${errorMessage}`);
  }

  const entry = Array.isArray(parsed) ? parsed[0] : parsed;
  if (!entry) {
    throw new Error('Signed URL response empty');
  }

  if (entry.error) {
    throw new Error(`Signed URL generation error: ${entry.error}`);
  }

  let signedUrl = entry.signedURL || entry.signedUrl || null;
  if (signedUrl) {
    // Supabase storage sign endpoint may return a relative path; normalize to absolute for fetch.
    if (signedUrl.startsWith('/')) {
      signedUrl = `${supabaseUrl.replace(/\/$/, '')}/storage/v1${signedUrl}`;
    } else if (!/^https?:\/\//i.test(signedUrl)) {
      signedUrl = `${supabaseUrl.replace(/\/$/, '')}/storage/v1/${signedUrl.replace(/^\/+/, '')}`;
    }
  }

  return {
    signedUrl,
    expiresAt: entry.expires_at || entry.expiration || null,
  };
};

const verifySignedUrl = async (signedUrl) => {
  if (!signedUrl) {
    throw new Error('Signed URL missing from bundle response');
  }

  const response = await fetchWithRetry(signedUrl);
  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Signed URL fetch failed (${response.status}): ${text}`);
  }

  const bytes = await response.arrayBuffer();
  return {
    status: response.status,
    contentLength: bytes.byteLength,
    contentType: response.headers.get('content-type') || '',
  };
};

const waitForMetricRow = async (
  client,
  {
    metric,
    whereSql = '',
    params = [],
    selectSql = 'labels, data',
    attempts = 10,
    sleepMs = 250,
  },
) => {
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    const { rows } = await client.query(
      `SELECT ${selectSql}
         FROM metrics_webhook_events
        WHERE metric = $1
        ${whereSql ? `AND ${whereSql}` : ''}
        ORDER BY created_at DESC
        LIMIT 1`,
      [metric, ...params],
    );
    if (rows.length > 0) {
      return rows[0];
    }
    if (attempt < attempts - 1) {
      await sleep(sleepMs);
    }
  }
  return null;
};

module.exports = {
  resolveApiCallerAuthToken,
  resolveApiCallerAuthTokenCandidates,
  resolveLabelProviderSecret,
  resolveEdgeConfig,
  runOutboundWorker,
  dispatchApiCallerBatch,
  progressWorkflowRun,
  completeBundleAsync,
  fetchWithRetry,
  ensureLabelPdf,
  generateSignedUrl,
  resolveStorageAdminKey,
  verifySignedUrl,
  waitForMetricRow,
};
