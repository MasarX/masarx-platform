#!/usr/bin/env node
/**
 * github-token-smoke.js
 *
 * Verifies that GITHUB_TOKEN can reach the GitHub REST API for the current repo.
 * Intended for CI preflight checks; dependency-free.
 */
/* eslint-disable no-console */

function die(msg) {
  console.error(`[github-token-smoke] ${msg}`);
  process.exit(1);
}

function parseRepo(full) {
  const v = String(full || '').trim();
  const m = /^([^/]+)\/([^/]+)$/.exec(v);
  return m ? { owner: m[1], repo: m[2] } : { owner: '', repo: '' };
}

async function main() {
  const { owner, repo } = parseRepo(process.env.GITHUB_REPOSITORY);
  if (!owner || !repo) die('Missing/invalid GITHUB_REPOSITORY (expected owner/repo).');

  const token = String(process.env.GITHUB_TOKEN || process.env.GH_TOKEN || '').trim();
  if (!token) die('Missing GITHUB_TOKEN (or GH_TOKEN).');

  const url = `https://api.github.com/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}`;
  const res = await fetch(url, {
    method: 'GET',
    headers: {
      accept: 'application/vnd.github+json',
      authorization: `Bearer ${token}`,
      'user-agent': 'masarx-github-token-smoke',
    },
  });

  if (!res.ok) {
    const text = await res.text().catch(() => '');
    die(`GitHub API ${res.status}: ${text || res.statusText}`);
  }

  console.log('[github-token-smoke] OK');
}

main().catch((e) => die(e && e.message ? e.message : String(e)));
