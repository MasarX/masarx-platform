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

const resolveLabelRendererInvokeUrl = () => {
  const supabaseUrl = process.env.EDGE_SUPABASE_URL || process.env.SUPABASE_URL || null;
  if (!supabaseUrl) {
    throw new Error('EDGE_SUPABASE_URL or SUPABASE_URL is required for label renderer invoke URL');
  }
  return `${supabaseUrl.replace(/\/$/, '')}/functions/v1/label-renderer`;
};

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

const withAuthenticatedUser = async (
  client,
  userId,
  fn,
  { deadlineAt = null } = {},
) => {
  const normalizedUserId = String(userId || '').trim();
  if (!normalizedUserId) {
    throw new Error('withAuthenticatedUser requires userId');
  }

  const requestedDeadlineAt = Number(deadlineAt);
  const hasDeadline = Number.isFinite(requestedDeadlineAt) && requestedDeadlineAt > 0;
  const applyRemainingStatementTimeout = async () => {
    if (!hasDeadline) return;
    const remainingMs = Math.floor(requestedDeadlineAt - Date.now());
    if (remainingMs <= 0) {
      throw new Error('label_authenticated_query_deadline_exceeded');
    }
    await client.query(
      `SELECT set_config('statement_timeout', $1::text, true)`,
      [`${remainingMs}ms`],
    );
  };

  if (hasDeadline && requestedDeadlineAt - Date.now() <= 0) {
    throw new Error('label_authenticated_query_deadline_exceeded');
  }

  await client.query('BEGIN');
  try {
    await applyRemainingStatementTimeout();
    await client.query('SET LOCAL ROLE authenticated');
    await client.query(`SELECT set_config('request.jwt.claim.role', 'authenticated', true)`);
    await client.query(`SELECT set_config('request.jwt.claim.sub', $1::text, true)`, [normalizedUserId]);
    await client.query(`SELECT set_config('request.jwt.claims', $1::text, true)`, [
      JSON.stringify({
        role: 'authenticated',
        sub: normalizedUserId,
      }),
    ]);
    const deadlineClient = {
      query: async (...args) => {
        await applyRemainingStatementTimeout();
        return client.query(...args);
      },
    };
    const output = await fn(deadlineClient);
    await client.query('COMMIT');
    return output;
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  }
};

const completeBundleAsync = async (client, runId, requestId, options = {}) => {
  const {
    maxAttempts = 12,
    sleepMs = 500,
    batchSize = 10,
    progressRunOnComplete = true,
    dispatchApiCallerBatchEnabled = true,
    deadlineAt = Number.POSITIVE_INFINITY,
    returnPendingAtDeadline = false,
  } = options;

  let lastResponse = { completed: false };

  for (
    let attempt = 0;
    attempt < maxAttempts && Date.now() < deadlineAt;
    attempt += 1
  ) {
    await runOutboundWorker(client);
    if (dispatchApiCallerBatchEnabled) {
      await dispatchApiCallerBatch(client, batchSize);
    }

    const { rows } = await client.query(
      'SELECT check_async_response($1::bigint) AS response',
      [requestId],
    );
    const response = rows[0]?.response || {};
    lastResponse = response;
    if (response.completed) {
      if (progressRunOnComplete) {
        await progressWorkflowRun(client, runId);
      }
      return response;
    }

    const remainingSleepMs = Math.max(0, deadlineAt - Date.now());
    if (sleepMs > 0 && remainingSleepMs > 0) {
      await sleep(Math.min(sleepMs, remainingSleepMs));
    }
  }

  if (returnPendingAtDeadline) {
    return lastResponse;
  }

  throw new Error(
    `Async bundle request ${requestId} did not complete after ${maxAttempts} attempts`,
  );
};

const summarizeAsyncReceipt = (kind, response = {}) => {
  const status = Number(response?.status || 0);
  const completed = response?.completed === true;
  const timedOut = response?.body?.timed_out === true;
  const hasError = Boolean(response?.body?.error);
  return {
    kind,
    completed,
    status,
    error_class: timedOut
      ? 'timed_out'
      : hasError
        ? 'provider_error'
        : completed && (status < 200 || status >= 300)
          ? 'http_error'
          : null,
  };
};

const readLabelPrintRun = async (client, workflowRunId) => {
  const { rows } = await client.query(
    `SELECT workflow_status, context, failure_reason, last_error
       FROM workflow_runs
      WHERE id = $1::uuid`,
    [workflowRunId],
  );
  const runRow = rows[0] || null;
  const labelPrintContext = runRow?.context?.label_print || {};
  return {
    runRow,
    workflowStatus: runRow?.workflow_status || null,
    labelPrintContext,
    bundleResp: labelPrintContext.bundle_response || null,
  };
};

const readBundleStepFallback = async (client, workflowRunId, handlerKey) => {
  const { rows } = await client.query(
    `SELECT operation_result
       FROM workflow_run_steps
      WHERE workflow_run_id = $1::uuid
        AND handler_key = $2
      ORDER BY sequence_order DESC
      LIMIT 1`,
    [workflowRunId, handlerKey],
  );
  const operationResult = rows[0]?.operation_result || {};
  return operationResult.bundle || operationResult || null;
};

const hasBundleArtifact = (bundle) => Boolean(
  bundle?.bundle_id && (bundle?.file_path || bundle?.file_url || bundle?.output_path),
);

const waitForCompletedBundleRun = async ({
  client,
  workflowRunId,
  progressBudgetMs = 1200,
  maxAttempts = 50,
  settleAttempts = 20,
  sleepMs = 500,
  deadlineMs = null,
  deadlineAt = null,
  drivePending = null,
  dispatchApiCallerBatchEnabled = true,
}) => {
  const cycleBudget = Math.max(1, maxAttempts + settleAttempts);
  const compatibilityDeadlineMs = cycleBudget * (
    Math.max(1, progressBudgetMs) + Math.max(0, sleepMs) + 1000
  );
  const relativeDeadlineAt = Date.now() + Math.max(
    1,
    Number(deadlineMs || compatibilityDeadlineMs),
  );
  const requestedDeadlineAt = Number(deadlineAt);
  const effectiveDeadlineAt = Number.isFinite(requestedDeadlineAt) && requestedDeadlineAt > 0
    ? Math.min(relativeDeadlineAt, requestedDeadlineAt)
    : relativeDeadlineAt;

  let snapshot = {
    runRow: null,
    workflowStatus: null,
    labelPrintContext: {},
    bundleResp: null,
  };
  let asyncReceipt = null;
  let lastProgress = null;

  for (
    let cycle = 0;
    cycle < cycleBudget && Date.now() < effectiveDeadlineAt;
    cycle += 1
  ) {
    const remainingProgressMs = Math.max(
      0,
      Math.floor(effectiveDeadlineAt - Date.now()),
    );
    if (remainingProgressMs <= 0) break;
    const { rows: progressRows } = await client.query(
      `SELECT public.progress_workflow_run_until_wait_v1($1::uuid, '{}'::jsonb, $2::int, 1) AS progress`,
      [
        workflowRunId,
        Math.min(progressBudgetMs, remainingProgressMs, 25),
      ],
    );
    const progress = progressRows[0]?.progress;
    lastProgress = progress;
    if (progress?.status === 'failed') {
      // Never echo SQL/provider error text: it can contain credentials or payloads.
      throw new Error('label_workflow_progress_failed');
    }

    if (drivePending) {
      await drivePending({ workflowRunId, cycle });
    }

    snapshot = await readLabelPrintRun(client, workflowRunId);
    if (snapshot.workflowStatus === 'failed') {
      return { ...snapshot, settlement: 'failed', asyncReceipt };
    }
    if (snapshot.workflowStatus === 'completed' && hasBundleArtifact(snapshot.bundleResp)) {
      return { ...snapshot, settlement: 'completed', asyncReceipt };
    }

    const executeRequestId = Number(snapshot.labelPrintContext.execute_async?.request_id);
    const bundleRequestId = Number(snapshot.labelPrintContext.bundle_async?.request_id);
    if (Number.isFinite(bundleRequestId) && bundleRequestId > 0) {
      const response = await completeBundleAsync(
        client,
        workflowRunId,
        bundleRequestId,
        {
          maxAttempts: 1,
          sleepMs: 0,
          progressRunOnComplete: false,
          dispatchApiCallerBatchEnabled,
          deadlineAt: effectiveDeadlineAt,
          returnPendingAtDeadline: true,
        },
      );
      asyncReceipt = summarizeAsyncReceipt('bundle_async', response);
    } else if (Number.isFinite(executeRequestId) && executeRequestId > 0) {
      const { rows } = await client.query(
        'SELECT public.check_async_response($1::bigint) AS response',
        [executeRequestId],
      );
      asyncReceipt = summarizeAsyncReceipt(
        'execute_async',
        rows[0]?.response || {},
      );
    }

    const remainingSleepMs = Math.max(0, effectiveDeadlineAt - Date.now());
    if (sleepMs > 0 && remainingSleepMs > 0) {
      await client.query(
        'SELECT pg_sleep($1::double precision)',
        [Math.min(sleepMs, remainingSleepMs) / 1000],
      );
    }
  }

  snapshot = await readLabelPrintRun(client, workflowRunId);
  let bundleResp = snapshot.bundleResp;
  if (!hasBundleArtifact(bundleResp)) {
    bundleResp = await readBundleStepFallback(client, workflowRunId, 'label_bundle');
  }
  if (!hasBundleArtifact(bundleResp)) {
    bundleResp = await readBundleStepFallback(client, workflowRunId, 'label_print_finalize');
  }

  const settlement = snapshot.workflowStatus === 'failed'
    ? 'failed'
    : snapshot.workflowStatus === 'completed' && hasBundleArtifact(bundleResp)
      ? 'completed'
      : 'pending_deadline';

  if (settlement === 'pending_deadline') {
    console.warn('label_workflow_pending_state', {
      progress_waiting: ['waiting', 'pending'].includes(lastProgress?.status),
      progress_in_progress: lastProgress?.status === 'in_progress',
      progress_has_step: Boolean(lastProgress?.step_id),
      progress_has_next_run: Boolean(lastProgress?.next_run_at),
      run_completed: snapshot.workflowStatus === 'completed',
      has_execute_request: Boolean(snapshot.labelPrintContext.execute_async?.request_id),
      has_bundle_request: Boolean(snapshot.labelPrintContext.bundle_async?.request_id),
      async_completed: asyncReceipt?.completed === true,
      async_http_status: Number.isFinite(asyncReceipt?.status) ? asyncReceipt.status : null,
      async_error: Boolean(asyncReceipt?.error_class),
      has_bundle_artifact: hasBundleArtifact(bundleResp),
    });
  }
  return { ...snapshot, bundleResp, settlement, asyncReceipt };
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
    const text = response.bodyText;
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

  // The shared HTTP helper consumes the response once and retains its text.
  const body = response.bodyText;
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

const cleanupLabelPrintWorkflowRows = async (
  client,
  { workflowRunIds = [], shipmentIds = [], shipmentBoxIds = [] },
) => {
  if (!workflowRunIds.length && !shipmentIds.length && !shipmentBoxIds.length) return;

  try {
    await client.query('BEGIN');

    if (workflowRunIds.length) {
      await client.query(
        `SELECT pg_advisory_xact_lock(
           hashtext('label_jobs_workflow_step_nudge'),
           hashtext(step.id::text)
         )
         FROM (
           SELECT id
           FROM workflow_run_steps
           WHERE workflow_run_id = ANY($1::uuid[])
           ORDER BY id
         ) step`,
        [workflowRunIds],
      );
    }
    if (workflowRunIds.length) {
      await client.query(
        'SELECT id FROM workflow_runs WHERE id = ANY($1::uuid[]) ORDER BY id FOR UPDATE',
        [workflowRunIds],
      );
    }
    if (shipmentIds.length) {
      await client.query(
        'SELECT id FROM shipments WHERE id = ANY($1::uuid[]) ORDER BY id FOR UPDATE',
        [shipmentIds],
      );
    }

    const { rows: jobItemTable } = await client.query(
      "SELECT to_regclass('public.label_job_items') IS NOT NULL AS exists",
    );
    if (jobItemTable[0]?.exists) {
      await client.query(
        `DELETE FROM label_job_items
          WHERE label_job_id IN (
            SELECT lj.id
            FROM label_jobs lj
            LEFT JOIN workflow_run_steps wrs ON wrs.id = lj.workflow_run_step_id
            WHERE wrs.workflow_run_id = ANY($1::uuid[])
               OR lj.shipment_id = ANY($2::uuid[])
          )`,
        [workflowRunIds, shipmentIds],
      );
    }
    await client.query(
      `DELETE FROM label_jobs
        WHERE shipment_id = ANY($2::uuid[])
           OR workflow_run_step_id IN (
             SELECT id
             FROM workflow_run_steps
             WHERE workflow_run_id = ANY($1::uuid[])
           )`,
      [workflowRunIds, shipmentIds],
    );
    await client.query(
      'DELETE FROM workflow_run_steps WHERE workflow_run_id = ANY($1::uuid[])',
      [workflowRunIds],
    );
    await client.query('DELETE FROM workflow_runs WHERE id = ANY($1::uuid[])', [workflowRunIds]);
    await client.query(
      'DELETE FROM shipment_actions WHERE shipment_id = ANY($1::uuid[])',
      [shipmentIds],
    );
    await client.query('DELETE FROM labels WHERE shipment_id = ANY($1::uuid[])', [shipmentIds]);
    await client.query(
      `DELETE FROM shipment_boxes
        WHERE id = ANY($1::uuid[])
           OR shipment_id = ANY($2::uuid[])`,
      [shipmentBoxIds, shipmentIds],
    );
    await client.query('DELETE FROM shipments WHERE id = ANY($1::uuid[])', [shipmentIds]);
    await client.query('COMMIT');
  } catch (error) {
    try {
      await client.query('ROLLBACK');
    } catch (_rollbackError) {
      // Preserve the cleanup failure that triggered rollback.
    }
    throw error;
  }
};

module.exports = {
  cleanupLabelPrintWorkflowRows,
  resolveApiCallerAuthToken,
  resolveApiCallerAuthTokenCandidates,
  resolveLabelProviderSecret,
  resolveLabelRendererInvokeUrl,
  resolveEdgeConfig,
  runOutboundWorker,
  dispatchApiCallerBatch,
  progressWorkflowRun,
  withAuthenticatedUser,
  completeBundleAsync,
  summarizeAsyncReceipt,
  waitForCompletedBundleRun,
  fetchWithRetry,
  ensureLabelPdf,
  generateSignedUrl,
  resolveStorageAdminKey,
  verifySignedUrl,
  waitForMetricRow,
};
