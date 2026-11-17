#!/usr/bin/env node
/* eslint-disable no-console */

const fs = require('fs');
const path = require('path');

const RETRYABLE_STATUS_CODES = new Set([408, 500, 502, 503, 504]);
const RETRYABLE_ERROR_RE = /fetch failed|server error|timed out|socket hang up|econnreset|econnrefused|etimedout|eai_again|enotfound|aborted|aborterror/i;
const RETRYABLE_NETWORK_ERROR_CODES = new Set([
  'UND_ERR_SOCKET',
  'UND_ERR_CONNECT_TIMEOUT',
  'ECONNRESET',
  'ECONNREFUSED',
  'ETIMEDOUT',
  'EAI_AGAIN',
  'ENOTFOUND',
]);
const MAX_RETRY_CAUSE_DEPTH = 8;
const RATE_LIMIT_MESSAGE_RE = /secondary rate limit|rate limit exceeded|abuse detection/i;
const DEFAULT_MAX_BINARY_BYTES = 100 * 1024 * 1024;
const DEFAULT_SECONDARY_RATE_LIMIT_DELAY_MS = 60_000;

function parsePositiveInt(value, fallback) {
  const parsed = Number.parseInt(String(value == null ? '' : value).trim(), 10);
  if (!Number.isFinite(parsed) || parsed <= 0) return fallback;
  return parsed;
}

function headerValue(headers, name) {
  if (!headers) return '';
  if (typeof headers.get === 'function') return String(headers.get(name) || '').trim();
  const target = String(name || '').trim().toLowerCase();
  for (const [key, value] of Object.entries(headers)) {
    if (String(key).toLowerCase() === target) return String(value || '').trim();
  }
  return '';
}

function parseRetryAfterMs(value, nowMs) {
  const raw = String(value || '').trim();
  if (!raw) return null;
  const seconds = Number(raw);
  if (Number.isFinite(seconds) && seconds >= 0) return Math.ceil(seconds * 1000);
  const retryAt = Date.parse(raw);
  if (!Number.isFinite(retryAt)) return null;
  return Math.max(0, Math.ceil(retryAt - nowMs));
}

function resolveGithubRateLimitRetry({ status, message, headers, nowMs = Date.now() } = {}) {
  const numericStatus = Number.parseInt(String(status == null ? '' : status).trim(), 10);
  if (numericStatus !== 429 && numericStatus !== 403) return null;

  const retryAfter = headerValue(headers, 'retry-after');
  const remaining = headerValue(headers, 'x-ratelimit-remaining');
  const reset = headerValue(headers, 'x-ratelimit-reset');
  const messageProvesRateLimit = RATE_LIMIT_MESSAGE_RE.test(String(message || ''));
  const retryAfterMs = parseRetryAfterMs(retryAfter, nowMs);
  const resetSeconds = reset ? Number(reset) : Number.NaN;
  const resetProvesRateLimit = remaining === '0' && Number.isFinite(resetSeconds) && resetSeconds >= 0;

  if (numericStatus === 403 && retryAfterMs == null && !resetProvesRateLimit && !messageProvesRateLimit) {
    return null;
  }

  const delayMs = retryAfterMs != null
    ? retryAfterMs
    : resetProvesRateLimit
      ? Math.max(0, Math.ceil((resetSeconds * 1000) - nowMs))
      : DEFAULT_SECONDARY_RATE_LIMIT_DELAY_MS;
  return { delayMs };
}

function isRetryableGithubApiFailure({ status, message, rateLimited }) {
  const numericStatus = Number.parseInt(String(status == null ? '' : status).trim(), 10);
  if (Number.isFinite(numericStatus) && RETRYABLE_STATUS_CODES.has(numericStatus)) {
    return true;
  }
  if (numericStatus === 429 || (numericStatus === 403 && rateLimited === true)) return true;
  return RETRYABLE_ERROR_RE.test(String(message || ''));
}

function isRetryableGithubBinaryBufferFailure(error) {
  const numericStatus = Number.parseInt(String(error?.status == null ? '' : error.status).trim(), 10);
  if (Number.isFinite(numericStatus) && RETRYABLE_STATUS_CODES.has(numericStatus)) return true;
  if (numericStatus === 429 || (numericStatus === 403 && error?.rateLimited === true)) return true;

  const seen = new Set();
  let current = error;

  for (let depth = 0; depth < MAX_RETRY_CAUSE_DEPTH && current != null; depth += 1) {
    if ((typeof current === 'object' || typeof current === 'function') && seen.has(current)) break;
    if (typeof current === 'object' || typeof current === 'function') seen.add(current);

    const code = String(current?.code || '').trim().toUpperCase();
    if (RETRYABLE_NETWORK_ERROR_CODES.has(code)) return true;

    current = current?.cause;
  }

  return false;
}

function buildHeaders({ token, userAgent, contentType, accept, apiVersion }) {
  return {
    accept: String(accept || 'application/vnd.github+json'),
    authorization: `Bearer ${String(token || '').trim()}`,
    'user-agent': String(userAgent || 'masarx-github-api-retry'),
    'x-github-api-version': String(apiVersion || '2022-11-28'),
    ...(contentType ? { 'content-type': String(contentType) } : {}),
  };
}

function assertNotAborted(signal) {
  if (signal?.aborted) throw new Error('GitHub API operation aborted');
}

function sleep(ms, { signal } = {}) {
  assertNotAborted(signal);
  return new Promise((resolve, reject) => {
    const cleanup = () => signal?.removeEventListener('abort', onAbort);
    const timer = setTimeout(() => {
      cleanup();
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      cleanup();
      reject(new Error('GitHub API operation aborted'));
    };
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

function remainingDeadlineMs(deadlineAtMs, nowFn = Date.now) {
  const deadline = Number(deadlineAtMs);
  if (!Number.isFinite(deadline)) return Number.POSITIVE_INFINITY;
  return Math.max(0, Math.floor(deadline - nowFn()));
}

function deadlineExceededError() {
  return new Error('GitHub API deadline exceeded');
}

function abortErrorForSignal(signal) {
  if (signal?.reason && typeof signal.reason === 'object') return signal.reason;
  const error = new Error('GitHub API operation aborted');
  error.name = 'AbortError';
  return error;
}

function cancelReaderBestEffort(reader, reason) {
  try {
    const cancellation = reader?.cancel?.(reason);
    Promise.resolve(cancellation).catch(() => {});
  } catch {
    // The owning request abort remains authoritative when reader cancellation is unavailable.
  }
}

function runGithubBinaryPhase({ run, signal, deadlineAtMs, nowFn = Date.now, onDeadline }) {
  assertNotAborted(signal);
  const remaining = remainingDeadlineMs(deadlineAtMs, nowFn);
  if (remaining <= 0) {
    const error = deadlineExceededError();
    onDeadline?.();
    return Promise.reject(error);
  }

  return new Promise((resolve, reject) => {
    let settled = false;
    let timer = null;
    const cleanup = () => {
      if (timer) clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
    };
    const settle = (callback, value) => {
      if (settled) return;
      settled = true;
      cleanup();
      callback(value);
    };
    const onAbort = () => settle(reject, abortErrorForSignal(signal));

    signal?.addEventListener('abort', onAbort, { once: true });
    if (signal?.aborted) {
      onAbort();
      return;
    }
    if (Number.isFinite(remaining)) {
      timer = setTimeout(() => {
        const error = deadlineExceededError();
        settle(reject, error);
        onDeadline?.();
      }, remaining);
    }

    const settleFromRun = (callback, value) => {
      if (remainingDeadlineMs(deadlineAtMs, nowFn) <= 0) {
        const error = deadlineExceededError();
        settle(reject, error);
        onDeadline?.();
        return;
      }
      settle(callback, value);
    };

    Promise.resolve()
      .then(run)
      .then(
        (value) => settleFromRun(resolve, value),
        (error) => settleFromRun(reject, error),
      );
  });
}

function readGithubBinaryChunk({ reader, signal, deadlineAtMs, nowFn = Date.now, onDeadline }) {
  assertNotAborted(signal);
  const remaining = remainingDeadlineMs(deadlineAtMs, nowFn);
  if (remaining <= 0) {
    const error = deadlineExceededError();
    onDeadline?.();
    cancelReaderBestEffort(reader, error.message);
    return Promise.reject(error);
  }

  return new Promise((resolve, reject) => {
    let settled = false;
    let timer = null;

    const cleanup = () => {
      if (timer) clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
    };
    const settle = (callback, value) => {
      if (settled) return;
      settled = true;
      cleanup();
      callback(value);
    };
    const onAbort = () => {
      const error = abortErrorForSignal(signal);
      // Give an in-flight read one event-loop turn to surface its own abort error.
      // A reader that never settles is still rejected immediately afterward.
      setImmediate(() => {
        if (settled) return;
        settle(reject, error);
        cancelReaderBestEffort(reader, error.message);
      });
    };
    const onRead = (result) => {
      if (signal?.aborted) {
        onAbort();
        return;
      }
      if (remainingDeadlineMs(deadlineAtMs, nowFn) <= 0) {
        const error = deadlineExceededError();
        settle(reject, error);
        onDeadline?.();
        cancelReaderBestEffort(reader, error.message);
        return;
      }
      settle(resolve, result);
    };

    signal?.addEventListener('abort', onAbort, { once: true });
    if (Number.isFinite(remaining)) {
      timer = setTimeout(() => {
        const error = deadlineExceededError();
        settle(reject, error);
        onDeadline?.();
        cancelReaderBestEffort(reader, error.message);
      }, remaining);
    }

    Promise.resolve()
      .then(() => reader.read())
      .then(onRead, (error) => settle(reject, error));
  });
}

function boundedAttemptTimeout({ requestTimeoutMs, deadlineAtMs, nowFn = Date.now }) {
  const configured = parsePositiveInt(requestTimeoutMs, 0);
  const remaining = remainingDeadlineMs(deadlineAtMs, nowFn);
  if (remaining <= 0) throw new Error('GitHub API deadline exceeded');
  if (!Number.isFinite(remaining)) return configured || 0;
  return configured > 0 ? Math.min(configured, remaining) : remaining;
}

async function boundedRetrySleep(delayMs, { deadlineAtMs, nowFn = Date.now, sleepFn = sleep, signal } = {}) {
  assertNotAborted(signal);
  const remaining = remainingDeadlineMs(deadlineAtMs, nowFn);
  if (remaining <= 0 || delayMs >= remaining) throw new Error('GitHub API deadline exceeded');
  if (signal) await sleepFn(delayMs, { signal });
  else await sleepFn(delayMs);
  assertNotAborted(signal);
}

async function requestGithubJson({
  token,
  url,
  method = 'GET',
  body,
  userAgent,
  maxAttempts = process.env.GITHUB_API_MAX_ATTEMPTS,
  retryDelayMs = process.env.GITHUB_API_RETRY_DELAY_MS,
  accept,
  apiVersion,
  requestTimeoutMs,
  deadlineAtMs,
  nowFn = Date.now,
  sleepFn = sleep,
  signal,
}) {
  const t = String(token || '').trim();
  if (!t) throw new Error('Missing GitHub token');

  const attempts = parsePositiveInt(maxAttempts, 4);
  const delayMs = parsePositiveInt(retryDelayMs, 2000);
  let lastError = null;

  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    assertNotAborted(signal);
    const boundedRequestTimeoutMs = boundedAttemptTimeout({ requestTimeoutMs, deadlineAtMs, nowFn });
    const controller = new AbortController();
    const forwardAbort = () => controller.abort(signal?.reason);
    if (signal?.aborted) forwardAbort();
    else signal?.addEventListener('abort', forwardAbort, { once: true });
    const timeout = boundedRequestTimeoutMs > 0
      ? setTimeout(() => controller.abort(), boundedRequestTimeoutMs)
      : null;
    try {
      const res = await fetch(String(url || ''), {
        method,
        headers: buildHeaders({
          token: t,
          userAgent,
          contentType: body == null ? '' : 'application/json',
          accept,
          apiVersion,
        }),
        body: body == null ? undefined : JSON.stringify(body),
        signal: controller?.signal,
      });

      const text = await res.text();
      if (!res.ok) {
        let parsed = null;
        try {
          parsed = text ? JSON.parse(text) : null;
        } catch {
          parsed = null;
        }
        const message = parsed?.message || text || res.statusText || `HTTP ${res.status}`;
        const error = new Error(`GitHub API ${res.status} for ${url}: ${message}`);
        error.status = res.status;
        const rateLimitRetry = resolveGithubRateLimitRetry({
          status: res.status,
          message,
          headers: res.headers,
          nowMs: nowFn(),
        });
        if (rateLimitRetry) {
          error.rateLimited = true;
          error.retryAfterMs = rateLimitRetry.delayMs;
        }
        throw error;
      }

      if (!text) return null;
      try {
        return JSON.parse(text);
      } catch {
        return text;
      }
    } catch (error) {
      lastError = error;
      if (attempt >= attempts || !isRetryableGithubApiFailure(error || {})) {
        throw error;
      }
      // Use bounded linear backoff for transient GitHub-side failures.
      // This keeps control-plane jobs resilient without hiding persistent faults.
      // eslint-disable-next-line no-await-in-loop
      const boundedDelayMs = Number.isFinite(error?.retryAfterMs)
        ? error.retryAfterMs
        : delayMs * attempt;
      await boundedRetrySleep(boundedDelayMs, { deadlineAtMs, nowFn, sleepFn, signal });
    } finally {
      if (timeout) clearTimeout(timeout);
      signal?.removeEventListener('abort', forwardAbort);
    }
  }

  throw lastError || new Error(`GitHub API request failed for ${url}`);
}

async function downloadGithubBinary({
  token,
  url,
  targetPath,
  userAgent,
  maxAttempts = process.env.GITHUB_API_MAX_ATTEMPTS,
  retryDelayMs = process.env.GITHUB_API_RETRY_DELAY_MS,
  accept,
  apiVersion,
  requestTimeoutMs,
  deadlineAtMs,
  maxBytes = DEFAULT_MAX_BINARY_BYTES,
  nowFn = Date.now,
  sleepFn = sleep,
  signal,
}) {
  const t = String(token || '').trim();
  if (!t) throw new Error('Missing GitHub token');

  const attempts = parsePositiveInt(maxAttempts, 4);
  const delayMs = parsePositiveInt(retryDelayMs, 2000);
  const byteLimit = parsePositiveInt(maxBytes, DEFAULT_MAX_BINARY_BYTES);
  let lastError = null;

  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    assertNotAborted(signal);
    const boundedRequestTimeoutMs = boundedAttemptTimeout({ requestTimeoutMs, deadlineAtMs, nowFn });
    const controller = new AbortController();
    const forwardAbort = () => controller.abort(signal?.reason);
    if (signal?.aborted) forwardAbort();
    else signal?.addEventListener('abort', forwardAbort, { once: true });
    const timeout = boundedRequestTimeoutMs > 0 ? setTimeout(() => controller.abort(), boundedRequestTimeoutMs) : null;
    let fileHandle = null;
    let createdTarget = false;
    try {
      const res = await fetch(String(url || ''), {
        method: 'GET',
        redirect: 'follow',
        headers: buildHeaders({
          token: t,
          userAgent,
          accept,
          apiVersion,
        }),
        signal: controller?.signal,
      });

      if (!res.ok) {
        const text = await res.text();
        const error = new Error(`GitHub API ${res.status} for ${url}: ${text || res.statusText}`);
        error.status = res.status;
        const rateLimitRetry = resolveGithubRateLimitRetry({
          status: res.status,
          message: text || res.statusText,
          headers: res.headers,
          nowMs: nowFn(),
        });
        if (rateLimitRetry) {
          error.rateLimited = true;
          error.retryAfterMs = rateLimitRetry.delayMs;
        }
        throw error;
      }

      const contentLength = Number.parseInt(String(res.headers?.get?.('content-length') || ''), 10);
      if (Number.isFinite(contentLength) && contentLength > byteLimit) {
        throw new Error(`GitHub binary exceeds byte limit: ${byteLimit}`);
      }
      if (!res.body || typeof res.body.getReader !== 'function') {
        throw new Error('GitHub binary response stream unavailable');
      }
      fs.mkdirSync(path.dirname(targetPath), { recursive: true });
      fileHandle = fs.openSync(targetPath, 'wx', 0o600);
      createdTarget = true;
      const reader = res.body.getReader();
      let bytesWritten = 0;
      try {
        while (true) {
          // eslint-disable-next-line no-await-in-loop
          const { done, value } = await reader.read();
          if (done) break;
          const chunk = Buffer.from(value);
          bytesWritten += chunk.length;
          if (bytesWritten > byteLimit) {
            await reader.cancel('byte limit exceeded').catch(() => {});
            throw new Error(`GitHub binary exceeds byte limit: ${byteLimit}`);
          }
          fs.writeSync(fileHandle, chunk);
        }
      } finally {
        fs.closeSync(fileHandle);
        fileHandle = null;
      }
      return targetPath;
    } catch (error) {
      if (fileHandle != null) {
        try { fs.closeSync(fileHandle); } catch { /* best effort */ }
      }
      if (createdTarget) fs.rmSync(targetPath, { force: true });
      lastError = error;
      if (attempt >= attempts || !isRetryableGithubApiFailure(error || {})) {
        throw error;
      }
      // eslint-disable-next-line no-await-in-loop
      const boundedDelayMs = Number.isFinite(error?.retryAfterMs)
        ? error.retryAfterMs
        : delayMs * attempt;
      await boundedRetrySleep(boundedDelayMs, { deadlineAtMs, nowFn, sleepFn, signal });
    } finally {
      if (timeout) clearTimeout(timeout);
      signal?.removeEventListener('abort', forwardAbort);
    }
  }

  throw lastError || new Error(`GitHub binary download failed for ${url}`);
}

async function downloadGithubBinaryBuffer({
  token,
  url,
  userAgent,
  maxAttempts = process.env.GITHUB_API_MAX_ATTEMPTS,
  retryDelayMs = process.env.GITHUB_API_RETRY_DELAY_MS,
  accept,
  apiVersion,
  requestTimeoutMs,
  deadlineAtMs,
  maxBytes = DEFAULT_MAX_BINARY_BYTES,
  nowFn = Date.now,
  sleepFn = sleep,
  signal,
}) {
  const t = String(token || '').trim();
  if (!t) throw new Error('Missing GitHub token');

  const attempts = parsePositiveInt(maxAttempts, 4);
  const delayMs = parsePositiveInt(retryDelayMs, 2000);
  const byteLimit = parsePositiveInt(maxBytes, DEFAULT_MAX_BINARY_BYTES);
  let lastError = null;

  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    assertNotAborted(signal);
    const boundedRequestTimeoutMs = boundedAttemptTimeout({ requestTimeoutMs, deadlineAtMs, nowFn });
    const declaredDeadlineAtMs = Number(deadlineAtMs);
    const attemptDeadlineAtMs = boundedRequestTimeoutMs > 0
      ? Math.min(
        Number.isFinite(declaredDeadlineAtMs) ? declaredDeadlineAtMs : Number.POSITIVE_INFINITY,
        nowFn() + boundedRequestTimeoutMs,
      )
      : Number.isFinite(declaredDeadlineAtMs)
        ? declaredDeadlineAtMs
        : Number.POSITIVE_INFINITY;
    const controller = new AbortController();
    const forwardAbort = () => controller.abort(signal?.reason);
    if (signal?.aborted) forwardAbort();
    else signal?.addEventListener('abort', forwardAbort, { once: true });
    let attemptTimedOut = false;
    try {
      const onAttemptDeadline = () => {
        attemptTimedOut = true;
        controller.abort();
      };
      const res = await runGithubBinaryPhase({
        run: () => fetch(String(url || ''), {
          method: 'GET',
          redirect: 'follow',
          headers: buildHeaders({
            token: t,
            userAgent,
            accept,
            apiVersion,
          }),
          signal: controller.signal,
        }),
        signal: controller.signal,
        deadlineAtMs: attemptDeadlineAtMs,
        nowFn,
        onDeadline: onAttemptDeadline,
      });

      if (!res.ok) {
        const text = await runGithubBinaryPhase({
          run: () => res.text(),
          signal: controller.signal,
          deadlineAtMs: attemptDeadlineAtMs,
          nowFn,
          onDeadline: onAttemptDeadline,
        });
        const error = new Error(`GitHub API ${res.status} for ${url}: ${text || res.statusText}`);
        error.status = res.status;
        const rateLimitRetry = resolveGithubRateLimitRetry({
          status: res.status,
          message: text || res.statusText,
          headers: res.headers,
          nowMs: nowFn(),
        });
        if (rateLimitRetry) {
          error.rateLimited = true;
          error.retryAfterMs = rateLimitRetry.delayMs;
        }
        throw error;
      }

      const contentLength = Number.parseInt(String(res.headers?.get?.('content-length') || ''), 10);
      if (Number.isFinite(contentLength) && contentLength > byteLimit) {
        throw new Error(`GitHub binary exceeds byte limit: ${byteLimit}`);
      }
      if (!res.body || typeof res.body.getReader !== 'function') {
        throw new Error('GitHub binary response stream unavailable');
      }
      const reader = res.body.getReader();
      let bytesWritten = 0;
      const chunks = [];
      try {
        while (true) {
          // eslint-disable-next-line no-await-in-loop
          const { done, value } = await readGithubBinaryChunk({
            reader,
            signal: controller.signal,
            deadlineAtMs: attemptDeadlineAtMs,
            nowFn,
            onDeadline: onAttemptDeadline,
          });
          if (done) break;
          const chunk = Buffer.from(value);
          bytesWritten += chunk.length;
          if (bytesWritten > byteLimit) {
            cancelReaderBestEffort(reader, 'byte limit exceeded');
            throw new Error(`GitHub binary exceeds byte limit: ${byteLimit}`);
          }
          chunks.push(chunk);
        }
      } finally {
        try { reader.releaseLock?.(); } catch { /* request abort owns timed-out stream cleanup */ }
      }
      return Buffer.concat(chunks, bytesWritten);
    } catch (error) {
      lastError = error;
      if (signal?.aborted) throw error;
      if (attempt >= attempts || (!attemptTimedOut && !isRetryableGithubBinaryBufferFailure(error))) {
        throw error;
      }
      // eslint-disable-next-line no-await-in-loop
      const boundedDelayMs = Number.isFinite(error?.retryAfterMs)
        ? error.retryAfterMs
        : delayMs * attempt;
      await boundedRetrySleep(boundedDelayMs, { deadlineAtMs, nowFn, sleepFn, signal });
    } finally {
      signal?.removeEventListener('abort', forwardAbort);
    }
  }

  throw lastError || new Error(`GitHub binary download failed for ${url}`);
}

module.exports = {
  RETRYABLE_STATUS_CODES,
  RETRYABLE_NETWORK_ERROR_CODES,
  DEFAULT_MAX_BINARY_BYTES,
  boundedAttemptTimeout,
  buildHeaders,
  isRetryableGithubApiFailure,
  isRetryableGithubBinaryBufferFailure,
  resolveGithubRateLimitRetry,
  requestGithubJson,
  downloadGithubBinary,
  downloadGithubBinaryBuffer,
};
