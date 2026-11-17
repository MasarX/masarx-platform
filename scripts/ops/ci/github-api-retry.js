#!/usr/bin/env node
/* eslint-disable no-console */

const fs = require('fs');
const path = require('path');

const RETRYABLE_STATUS_CODES = new Set([408, 500, 502, 503, 504]);
const RETRYABLE_ERROR_RE = /fetch failed|server error|timed out|socket hang up|econnreset|econnrefused|etimedout|eai_again|enotfound|aborted|aborterror/i;

function parsePositiveInt(value, fallback) {
  const parsed = Number.parseInt(String(value == null ? '' : value).trim(), 10);
  if (!Number.isFinite(parsed) || parsed <= 0) return fallback;
  return parsed;
}

function isRetryableGithubApiFailure({ status, message }) {
  const numericStatus = Number.parseInt(String(status == null ? '' : status).trim(), 10);
  if (Number.isFinite(numericStatus) && RETRYABLE_STATUS_CODES.has(numericStatus)) {
    return true;
  }
  return RETRYABLE_ERROR_RE.test(String(message || ''));
}

function buildHeaders({ token, userAgent, contentType, accept }) {
  return {
    accept: String(accept || 'application/vnd.github+json'),
    authorization: `Bearer ${String(token || '').trim()}`,
    'user-agent': String(userAgent || 'masarx-github-api-retry'),
    'x-github-api-version': '2022-11-28',
    ...(contentType ? { 'content-type': String(contentType) } : {}),
  };
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
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
}) {
  const t = String(token || '').trim();
  if (!t) throw new Error('Missing GitHub token');

  const attempts = parsePositiveInt(maxAttempts, 4);
  const delayMs = parsePositiveInt(retryDelayMs, 2000);
  let lastError = null;

  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      const res = await fetch(String(url || ''), {
        method,
        headers: buildHeaders({
          token: t,
          userAgent,
          contentType: body == null ? '' : 'application/json',
          accept,
        }),
        body: body == null ? undefined : JSON.stringify(body),
      });

      const text = await res.text().catch(() => '');
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
      await sleep(delayMs * attempt);
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
}) {
  const t = String(token || '').trim();
  if (!t) throw new Error('Missing GitHub token');

  const attempts = parsePositiveInt(maxAttempts, 4);
  const delayMs = parsePositiveInt(retryDelayMs, 2000);
  let lastError = null;

  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      const res = await fetch(String(url || ''), {
        method: 'GET',
        redirect: 'follow',
        headers: buildHeaders({
          token: t,
          userAgent,
          accept,
        }),
      });

      if (!res.ok) {
        const text = await res.text().catch(() => '');
        const error = new Error(`GitHub API ${res.status} for ${url}: ${text || res.statusText}`);
        error.status = res.status;
        throw error;
      }

      const buffer = Buffer.from(await res.arrayBuffer());
      fs.mkdirSync(path.dirname(targetPath), { recursive: true });
      fs.writeFileSync(targetPath, buffer);
      return targetPath;
    } catch (error) {
      lastError = error;
      if (attempt >= attempts || !isRetryableGithubApiFailure(error || {})) {
        throw error;
      }
      // eslint-disable-next-line no-await-in-loop
      await sleep(delayMs * attempt);
    }
  }

  throw lastError || new Error(`GitHub binary download failed for ${url}`);
}

module.exports = {
  RETRYABLE_STATUS_CODES,
  isRetryableGithubApiFailure,
  requestGithubJson,
  downloadGithubBinary,
};
