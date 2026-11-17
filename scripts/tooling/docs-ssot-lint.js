#!/usr/bin/env node
/* eslint-disable no-console */
const fs = require('fs');
const path = require('path');

const DEFAULT_CONFIG_PATH = 'config/docs/ssot-critical-docs.json';
const DAY_MS = 24 * 60 * 60 * 1000;

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

function parseLastUpdated(content) {
  const match = String(content || '').match(/^\s*>\s*\*\*Last Updated:\*\*\s*(.+)\s*$/m);
  if (!match) {
    return { value: '', date: null, error: 'missing_last_updated' };
  }
  const value = String(match[1] || '').trim();
  if (!value) {
    return { value, date: null, error: 'missing_last_updated_value' };
  }

  let date = null;
  if (/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    date = new Date(`${value}T00:00:00Z`);
  } else {
    const parsed = new Date(`${value} UTC`);
    if (!Number.isNaN(parsed.getTime())) {
      date = parsed;
    }
  }
  if (!date || Number.isNaN(date.getTime())) {
    return { value, date: null, error: 'invalid_last_updated_value' };
  }
  return { value, date, error: '' };
}

function normalizeLinkTarget(rawTarget) {
  const trimmed = String(rawTarget || '').trim().replace(/^<|>$/g, '');
  if (!trimmed) return '';
  // Drop optional markdown title (`path "title"`).
  const parts = trimmed.split(/\s+/);
  return parts[0] || '';
}

function isExternalLink(target) {
  return /^(https?:\/\/|mailto:|tel:|data:)/i.test(target);
}

function extractMarkdownLinks(content) {
  const links = [];
  const regex = /\[[^\]]+\]\(([^)]+)\)/g;
  let match = regex.exec(content);
  while (match) {
    links.push(String(match[1] || ''));
    match = regex.exec(content);
  }
  return links;
}

function resolveLocalLink(rootDir, sourceFile, rawTarget) {
  const target = normalizeLinkTarget(rawTarget);
  if (!target || target.startsWith('#') || isExternalLink(target)) return null;
  const [pathPart] = target.split('#', 1);
  if (!pathPart) return null;

  const withoutQuery = pathPart.split('?', 1)[0];
  const cleaned = decodeURIComponent(withoutQuery);
  if (!cleaned) return null;

  if (cleaned.startsWith('/')) {
    return path.resolve(rootDir, `.${cleaned}`);
  }
  return path.resolve(path.dirname(sourceFile), cleaned);
}

function linkExists(resolvedPath) {
  if (!resolvedPath) return true;
  if (fs.existsSync(resolvedPath)) return true;

  // Convenience fallback for extensionless markdown links.
  if (!path.extname(resolvedPath) && fs.existsSync(`${resolvedPath}.md`)) {
    return true;
  }
  return false;
}

function lintDocEntry(rootDir, docEntry, options = {}) {
  const now = options.now || new Date();
  const maxAgeDays = Number.isFinite(options.maxAgeDays)
    ? options.maxAgeDays
    : Number.MAX_SAFE_INTEGER;
  const issues = [];

  const relPath = docEntry.path;
  const fullPath = path.resolve(rootDir, relPath);
  if (!fs.existsSync(fullPath)) {
    issues.push(`${relPath}: file_missing`);
    return issues;
  }

  const content = fs.readFileSync(fullPath, 'utf8');

  for (const patternText of docEntry.requiredPatterns || []) {
    const pattern = new RegExp(patternText, 'm');
    if (!pattern.test(content)) {
      issues.push(`${relPath}: missing_required_pattern "${patternText}"`);
    }
  }

  for (const patternText of docEntry.forbiddenPatterns || []) {
    const pattern = new RegExp(patternText, 'm');
    if (pattern.test(content)) {
      issues.push(`${relPath}: matched_forbidden_pattern "${patternText}"`);
    }
  }

  if (docEntry.enforceFreshness) {
    const parsed = parseLastUpdated(content);
    if (parsed.error) {
      issues.push(`${relPath}: ${parsed.error}`);
    } else {
      const ageDays = Math.floor((now.getTime() - parsed.date.getTime()) / DAY_MS);
      if (ageDays > maxAgeDays) {
        issues.push(`${relPath}: stale_last_updated age_days=${ageDays} max_age_days=${maxAgeDays}`);
      }
    }
  }

  if (docEntry.checkLinks) {
    const links = extractMarkdownLinks(content);
    for (const rawTarget of links) {
      const resolved = resolveLocalLink(rootDir, fullPath, rawTarget);
      if (!linkExists(resolved)) {
        issues.push(`${relPath}: broken_local_link "${rawTarget}"`);
      }
    }
  }

  return issues;
}

function runLint(opts = {}) {
  const rootDir = opts.rootDir || process.cwd();
  const configPath = path.resolve(rootDir, opts.configPath || DEFAULT_CONFIG_PATH);
  const config = readJson(configPath);
  const maxAgeDays = Number(config.maxAgeDays || 0);
  const now = opts.now || new Date();

  const issues = [];
  for (const docEntry of config.docs || []) {
    issues.push(...lintDocEntry(rootDir, docEntry, { now, maxAgeDays }));
  }
  return { issues, configPath };
}

function main() {
  const result = runLint();
  if (result.issues.length > 0) {
    for (const issue of result.issues) {
      console.error(`[docs-ssot-lint] ${issue}`);
    }
    console.error(`[docs-ssot-lint] FAIL - ${result.issues.length} issue(s) found.`);
    process.exit(1);
  }
  console.log('[docs-ssot-lint] OK - critical docs are fresh and aligned.');
}

if (require.main === module) {
  main();
}

module.exports = {
  DEFAULT_CONFIG_PATH,
  extractMarkdownLinks,
  lintDocEntry,
  parseLastUpdated,
  resolveLocalLink,
  runLint,
};
