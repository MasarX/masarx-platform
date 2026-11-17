async function readJsonOrText(response) {
  const raw = await response.text().catch(() => '');
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === 'object') return parsed;
    return { value: parsed };
  } catch (_err) {
    return { error: raw };
  }
}

async function sleepMs(ms) {
  const dur = Number(ms) || 0;
  if (dur <= 0) return;
  await new Promise((resolve) => setTimeout(resolve, dur));
}

function truncateText(text, maxChars = 1200) {
  const s = String(text || '');
  const max = Number(maxChars) || 1200;
  if (max <= 0) return '';
  if (s.length <= max) return s;
  return `${s.slice(0, max)}...[truncated ${s.length - max} chars]`;
}

function isCloudflareHtmlError(text) {
  const s = String(text || '').toLowerCase();
  return (
    s.includes('cloudflare') &&
    (s.includes('internal server error') || s.includes('ray id') || s.includes('error code'))
  );
}

function isRetryableHttpStatus(status) {
  const code = Number(status);
  return [408, 409, 425, 429, 500, 502, 503, 504, 546].includes(code);
}

function getInvokeErrorStatus(errorLike) {
  return Number(errorLike?.context?.status ?? errorLike?.status ?? 0);
}

function getInvokeErrorBodyText(errorLike) {
  const body = errorLike?.context?.body ?? errorLike?.body ?? null;
  if (typeof body === 'string') return body;
  if (body && typeof body === 'object') {
    try {
      return JSON.stringify(body);
    } catch (_err) {
      return String(body);
    }
  }
  return body == null ? '' : String(body);
}

function isRetryableInvokeError(errorLike) {
  if (!errorLike) return false;
  const status = getInvokeErrorStatus(errorLike);
  const message = String(errorLike?.message || '').toLowerCase();
  const bodyText = getInvokeErrorBodyText(errorLike).toLowerCase();
  return (
    isRetryableHttpStatus(status) ||
    message.includes('worker_limit') ||
    bodyText.includes('worker_limit') ||
    message.includes('resource limit') ||
    bodyText.includes('resource limit') ||
    message.includes('invalid response was received from the upstream server') ||
    bodyText.includes('invalid response was received from the upstream server')
  );
}

async function fetchTextWithRetry(url, init, opts = {}) {
  const attemptsRaw = opts.attempts ?? process.env.E2E_HTTP_RETRY_ATTEMPTS ?? '4';
  const baseDelayRaw = opts.baseDelayMs ?? process.env.E2E_HTTP_RETRY_BASE_DELAY_MS ?? '1000';
  const maxDelayRaw = opts.maxDelayMs ?? process.env.E2E_HTTP_RETRY_MAX_DELAY_MS ?? '8000';
  const attemptTimeoutRaw =
    opts.attemptTimeoutMs ?? process.env.E2E_HTTP_RETRY_ATTEMPT_TIMEOUT_MS ?? '0';

  const parsedAttempts = parseInt(String(attemptsRaw), 10);
  const parsedBaseDelayMs = parseInt(String(baseDelayRaw), 10);
  const parsedMaxDelayMs = parseInt(String(maxDelayRaw), 10);
  const parsedAttemptTimeoutMs = parseInt(String(attemptTimeoutRaw), 10);

  const attempts = Math.max(1, Number.isFinite(parsedAttempts) ? parsedAttempts : 4);
  const baseDelayMs = Math.max(0, Number.isFinite(parsedBaseDelayMs) ? parsedBaseDelayMs : 1000);
  const maxDelayMs = Math.max(
    baseDelayMs,
    Number.isFinite(parsedMaxDelayMs) ? parsedMaxDelayMs : 8000,
  );
  const attemptTimeoutMs = Math.max(
    0,
    Number.isFinite(parsedAttemptTimeoutMs) ? parsedAttemptTimeoutMs : 0,
  );
  const purpose = String(opts.purpose || 'request');

  let last = null;
  for (let attempt = 1; attempt <= attempts; attempt++) {
    const controller = attemptTimeoutMs > 0 ? new AbortController() : null;
    const timer =
      controller && attemptTimeoutMs > 0
        ? setTimeout(() => controller.abort(), attemptTimeoutMs)
        : null;

    try {
      const resp = await fetch(
        url,
        controller ? { ...(init || {}), signal: controller.signal } : init,
      );

      const bodyText = await resp.text().catch(() => '');
      const retryable = isRetryableHttpStatus(resp.status) || isCloudflareHtmlError(bodyText);

      last = { resp, bodyText };

      if (!retryable || attempt === attempts) return last;

      const delay = Math.min(baseDelayMs * Math.pow(2, attempt - 1), maxDelayMs);
      // eslint-disable-next-line no-console
      console.warn(
        `[http] ${purpose} retry ${attempt}/${attempts} after ${delay}ms (status ${resp.status})`,
      );
      await sleepMs(delay);
    } catch (err) {
      last = { error: err };
      if (attempt === attempts) throw err;
      const delay = Math.min(baseDelayMs * Math.pow(2, attempt - 1), maxDelayMs);
      // eslint-disable-next-line no-console
      console.warn(
        `[http] ${purpose} retry ${attempt}/${attempts} after ${delay}ms (${err?.message || err})`,
      );
      await sleepMs(delay);
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  if (last?.error) throw last.error;
  return last;
}

async function fetchJsonWithRetry(url, init, opts = {}) {
  const { resp, bodyText } = await fetchTextWithRetry(url, init, opts);
  if (!bodyText) return { resp, bodyText: '', json: {} };
  try {
    const json = JSON.parse(bodyText);
    return { resp, bodyText, json };
  } catch (err) {
    return { resp, bodyText, json: null, jsonError: err };
  }
}

async function invokeFunctionWithRetry(client, fnName, invokeOptions, opts = {}) {
  const attemptsRaw = opts.attempts ?? process.env.E2E_HTTP_RETRY_ATTEMPTS ?? '4';
  const baseDelayRaw = opts.baseDelayMs ?? process.env.E2E_HTTP_RETRY_BASE_DELAY_MS ?? '1000';
  const maxDelayRaw = opts.maxDelayMs ?? process.env.E2E_HTTP_RETRY_MAX_DELAY_MS ?? '8000';
  const parsedAttempts = parseInt(String(attemptsRaw), 10);
  const parsedBaseDelayMs = parseInt(String(baseDelayRaw), 10);
  const parsedMaxDelayMs = parseInt(String(maxDelayRaw), 10);
  const attempts = Math.max(1, Number.isFinite(parsedAttempts) ? parsedAttempts : 4);
  const baseDelayMs = Math.max(0, Number.isFinite(parsedBaseDelayMs) ? parsedBaseDelayMs : 1000);
  const maxDelayMs = Math.max(
    baseDelayMs,
    Number.isFinite(parsedMaxDelayMs) ? parsedMaxDelayMs : 8000,
  );
  const purpose = String(opts.purpose || `invoke ${fnName}`);

  let lastResult = null;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    const result = await client.functions.invoke(fnName, invokeOptions);
    lastResult = result;

    if (!result?.error || !isRetryableInvokeError(result.error) || attempt === attempts) {
      return result;
    }

    const delay = Math.min(baseDelayMs * Math.pow(2, attempt - 1), maxDelayMs);
    const status = getInvokeErrorStatus(result.error);
    // eslint-disable-next-line no-console
    console.warn(
      `[http] ${purpose} retry ${attempt}/${attempts} after ${delay}ms (status ${status || 'unknown'})`,
    );
    await sleepMs(delay);
  }

  return lastResult;
}

module.exports = {
  getInvokeErrorBodyText,
  getInvokeErrorStatus,
  invokeFunctionWithRetry,
  isRetryableInvokeError,
  readJsonOrText,
  fetchJsonWithRetry,
  fetchTextWithRetry,
  isCloudflareHtmlError,
  isRetryableHttpStatus,
  truncateText,
};
