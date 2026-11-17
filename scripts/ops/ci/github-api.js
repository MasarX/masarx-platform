'use strict';

const RETRYABLE_STATUS_CODES = new Set([408, 429, 500, 502, 503, 504]);

function parsePositiveInteger(value, fallback) {
  const parsed = Number.parseInt(String(value || '').trim(), 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function resolveRetryConfig(env = process.env) {
  const maxAttempts = parsePositiveInteger(env.GITHUB_API_RETRY_ATTEMPTS, 3);
  const baseDelayMs = parsePositiveInteger(
    env.GITHUB_API_RETRY_BASE_DELAY_MS || env.GITHUB_API_RETRY_DELAY_MS,
    1000,
  );
  const maxDelayMs = Math.max(
    baseDelayMs,
    parsePositiveInteger(env.GITHUB_API_RETRY_MAX_DELAY_MS, 5000),
  );
  return { maxAttempts, baseDelayMs, maxDelayMs };
}

function parseRetryAfterMs(retryAfter, nowMs = Date.now()) {
  const raw = String(retryAfter || '').trim();
  if (!raw) return 0;

  if (/^\d+$/.test(raw)) {
    return Number.parseInt(raw, 10) * 1000;
  }

  const parsedDateMs = Date.parse(raw);
  if (!Number.isFinite(parsedDateMs)) return 0;

  return Math.max(0, parsedDateMs - nowMs);
}

function computeBackoffDelayMs({
  attempt,
  retryAfter = '',
  baseDelayMs,
  maxDelayMs,
  nowMs = Date.now(),
}) {
  const retryAfterMs = parseRetryAfterMs(retryAfter, nowMs);
  if (retryAfterMs > 0) {
    return Math.min(maxDelayMs, retryAfterMs);
  }
  const expAttempt = Math.max(0, Number(attempt || 1) - 1);
  return Math.min(maxDelayMs, baseDelayMs * (2 ** expAttempt));
}

function delay(ms) {
  const waitMs = Math.max(0, Number(ms || 0));
  return new Promise((resolve) => setTimeout(resolve, waitMs));
}

function buildHttpError({ url, status, statusText, bodyText }) {
  const text = String(bodyText || '').trim();
  const message = `GitHub API ${status} ${url}: ${text || statusText || 'Request failed'}`;
  const error = new Error(message);
  error.status = status;
  error.url = url;
  error.retryable = RETRYABLE_STATUS_CODES.has(status);
  return error;
}

function buildTransportError({ url, error }) {
  const message = `GitHub API request failed for ${url}: ${error?.message || String(error)}`;
  const wrapped = new Error(message);
  wrapped.url = url;
  wrapped.retryable = true;
  wrapped.cause = error;
  return wrapped;
}

async function githubRequestJson({
  token,
  url,
  accept = 'application/vnd.github+json',
  method = 'GET',
  headers = {},
  body,
  userAgent = 'masarx-github-api',
  retryConfig,
  fetchImpl = global.fetch,
  sleepImpl = delay,
  consoleImpl = console,
}) {
  const authToken = String(token || '').trim();
  if (!authToken) throw new Error('Missing GitHub token');
  if (typeof fetchImpl !== 'function') {
    throw new Error('global fetch is unavailable for GitHub API requests');
  }

  const resolvedRetry = retryConfig || resolveRetryConfig();
  const requestHeaders = {
    authorization: `Bearer ${authToken}`,
    accept,
    'user-agent': userAgent,
    ...headers,
  };

  for (let attempt = 1; attempt <= resolvedRetry.maxAttempts; attempt += 1) {
    let response;
    try {
      response = await fetchImpl(url, {
        method,
        headers: requestHeaders,
        body,
      });
    } catch (error) {
      const wrappedError = buildTransportError({ url, error });
      if (attempt >= resolvedRetry.maxAttempts) throw wrappedError;

      const delayMs = computeBackoffDelayMs({
        attempt,
        baseDelayMs: resolvedRetry.baseDelayMs,
        maxDelayMs: resolvedRetry.maxDelayMs,
      });
      consoleImpl.warn(
        `[github-api] ${userAgent} retrying ${method} ${url} after transport failure ` +
        `(attempt ${attempt}/${resolvedRetry.maxAttempts}) in ${delayMs}ms: ${error?.message || String(error)}`,
      );
      // eslint-disable-next-line no-await-in-loop
      await sleepImpl(delayMs);
      continue;
    }

    if (response.ok) {
      return response.json();
    }

    const bodyText = await response.text().catch(() => '');
    const error = buildHttpError({
      url,
      status: response.status,
      statusText: response.statusText,
      bodyText,
    });
    if (!error.retryable || attempt >= resolvedRetry.maxAttempts) {
      throw error;
    }

    const delayMs = computeBackoffDelayMs({
      attempt,
      retryAfter: response.headers?.get?.('retry-after'),
      baseDelayMs: resolvedRetry.baseDelayMs,
      maxDelayMs: resolvedRetry.maxDelayMs,
    });
    consoleImpl.warn(
      `[github-api] ${userAgent} retrying ${method} ${url} after GitHub API ${response.status} ` +
      `(attempt ${attempt}/${resolvedRetry.maxAttempts}) in ${delayMs}ms.`,
    );
    // eslint-disable-next-line no-await-in-loop
    await sleepImpl(delayMs);
  }

  throw new Error(`GitHub API retry loop exhausted unexpectedly for ${url}`);
}

async function githubPaginate({
  token,
  url,
  accept,
  userAgent,
  maxPages = 20,
  requestImpl = githubRequestJson,
}) {
  const items = [];
  for (let page = 1; page <= maxPages; page += 1) {
    const separator = url.includes('?') ? '&' : '?';
    // eslint-disable-next-line no-await-in-loop
    const payload = await requestImpl({
      token,
      url: `${url}${separator}per_page=100&page=${page}`,
      accept,
      userAgent,
    });
    const pageItems = Array.isArray(payload) ? payload : [];
    items.push(...pageItems);
    if (pageItems.length < 100) break;
  }
  return items;
}

module.exports = {
  RETRYABLE_STATUS_CODES,
  resolveRetryConfig,
  parseRetryAfterMs,
  computeBackoffDelayMs,
  githubRequestJson,
  githubPaginate,
};
