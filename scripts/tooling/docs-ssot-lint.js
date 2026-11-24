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
  if (!target || isExternalLink(target)) return null;
  if (target.startsWith('#')) return sourceFile;
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

function markdownAnchors(content) {
  const anchors = new Set();
  const headings = new Set();
  let fence = '';
  // shortcut: top-level ATX headings and named anchors, use a GFM parser for nested or Setext headings.
  for (const line of content.replace(/<!--[\s\S]*?-->/g, '').split(/\r?\n/)) {
    const delimiter = /^ {0,3}(`{3,}|~{3,})(.*)$/.exec(line);
    if (fence) {
      if (delimiter?.[1][0] === fence[0] && delimiter[1].length >= fence.length && !delimiter[2].trim()) {
        fence = '';
      }
      continue;
    }
    if (delimiter) {
      fence = delimiter[1];
      continue;
    }

    for (const match of line.matchAll(/<a\s+[^>]*?\bname=(["'])([^"']+)\1[^>]*>/gi)) {
      anchors.add(match[2]);
    }
    const heading = /^ {0,3}#{1,6}[ \t]+(.+?)(?:[ \t]+#+)?[ \t]*$/.exec(line)?.[1];
    if (!heading) continue;

    const slug = heading
      .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')
      .replace(/<[^>]*>/g, '')
      .replace(/(^|\W)(_+)([^_]+)\2(?=\W|$)/g, '$1$3')
      .trim()
      .toLowerCase()
      .replace(/[^\p{L}\p{M}\p{N}_ -]/gu, '')
      .replaceAll(' ', '-');
    let anchor = slug;
    for (let occurrence = 1; headings.has(anchor); occurrence++) {
      anchor = `${slug}-${occurrence}`;
    }
    headings.add(anchor);
    anchors.add(anchor);
  }
  return anchors;
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
      const fragment = normalizeLinkTarget(rawTarget).split('#', 2)[1];
      if (resolved && fragment && !/^L\d/.test(fragment)) {
        const target = !path.extname(resolved) && !fs.existsSync(resolved) ? `${resolved}.md` : resolved;
        if (/\.md$/i.test(target) && fs.statSync(target, { throwIfNoEntry: false })?.isFile()) {
          const markdown = target === fullPath ? content : fs.readFileSync(target, 'utf8');
          if (!markdownAnchors(markdown).has(decodeURIComponent(fragment))) {
            issues.push(`${relPath}: broken_section_link "${rawTarget}"`);
          }
        }
      }
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
