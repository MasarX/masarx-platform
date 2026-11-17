#!/usr/bin/env node
/**
 * Objectives Lint
 * Verifies code changes comply with project objectives:
 * - Zero hardcoding (no hard-coded DSNs/URLs in source or migrations)
 * - SIMPLE / best practice / SCALABLE / DYNAMIC (heuristic hints only)
 *
 * This is a heuristic scanner intended to catch obvious violations early.
 * It scans source (scripts/, supabase/functions/) and SQL migrations (supabase/migrations),
 * and ignores tests, docs, and environment templates.
 */

/* eslint-disable no-console */
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const root = process.cwd();

function shouldSkipDir(relPosix) {
  const parts = relPosix.split('/').filter(Boolean);
  const last = parts[parts.length - 1] || '';
  if (parts.includes('node_modules') || parts.includes('.git')) return true;
  // Skip Vercel build output + local linkage artifacts (.vercel/output). These are not source-of-truth
  // and commonly embed localhost/Supabase URL literals.
  if (parts.includes('.vercel')) return true;
  // Skip generated build artifacts (e.g., Vite build/, dist/) which can include
  // inlined localhost/Supabase URL literals and are not source-of-truth.
  if (last === 'build' || last === 'dist' || last === '.next') return true;
  if (last === '.turbo' || last === 'coverage' || last === 'storybook-static') return true;
  if (last === 'test-results' || last === 'playwright-report') return true;
  if (relPosix === 'docs' || relPosix.startsWith('docs/')) return true;
  if (relPosix === 'tests' || relPosix.startsWith('tests/')) return true;
  if (relPosix === 'supabase/tests' || relPosix.startsWith('supabase/tests/')) return true;
  if (relPosix === 'config/env' || relPosix.startsWith('config/env/')) return true;
  // Preserve prior behavior: ignore only root-level temp dirs, not nested scripts/tmp used by unit tests.
  if (relPosix === 'tmp' || relPosix === 'temp' || relPosix === '.tmp') return true;
  return false;
}

function walk(dir, acc = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, entry.name);
    const rel = path.relative(root, p).replace(/\\/g, '/');
    if (entry.isDirectory()) {
      if (shouldSkipDir(rel)) continue;
      acc = walk(p, acc);
    } else {
      acc.push(rel);
    }
  }
  return acc;
}

function readSafe(file) {
  try { return fs.readFileSync(file, 'utf8'); } catch { return ''; }
}

function isGeneratedSharedMirror(rel) {
  const relPosix = rel.replace(/\\/g, '/');
  if (!/^supabase\/functions\/[^/]+\/_shared\/.+$/.test(relPosix)) return false;
  // Explicitly keep tracked nested sources, even if an ignore pattern also matches.
  if (spawnSync('git', ['ls-files', '--error-unmatch', '--', relPosix], {
    cwd: root, stdio: 'ignore',
  }).status !== 1) return false;
  return spawnSync('git', ['check-ignore', '-q', '--', relPosix], {
    cwd: root, stdio: 'ignore',
  }).status === 0;
}

let files = walk(root)
  .filter((f) => /\.(js|ts|mjs|cjs|sql)$/i.test(f))
  .filter((f) => !/^(docs|tests|supabase\/tests|config\/env|emdash)\//.test(f))
  .filter((f) => !/^supabase\/migrations\/archive\//.test(f.replace(/\\/g, '/')));
files = files.filter((f) => !isGeneratedSharedMirror(f));
const includeRe = process.env.OBJECTIVES_LINT_INCLUDE ? new RegExp(process.env.OBJECTIVES_LINT_INCLUDE) : null;
if (includeRe) files = files.filter((f) => includeRe.test(f.replace(/\\/g, '/')));
const hasIncludeFilter = Boolean(includeRe);

const expectedFilesRaw = String(process.env.OBJECTIVES_LINT_EXPECTED_FILES_JSON || '').trim();
if (expectedFilesRaw) {
  let expectedFiles;
  try {
    expectedFiles = JSON.parse(expectedFilesRaw);
  } catch {
    console.error('[objectives-lint] Invalid OBJECTIVES_LINT_EXPECTED_FILES_JSON.');
    process.exit(1);
  }
  if (!Array.isArray(expectedFiles) || expectedFiles.some((file) => typeof file !== 'string')) {
    console.error('[objectives-lint] Expected-file coverage must be a JSON string array.');
    process.exit(1);
  }
  const expected = uniqSorted(expectedFiles.map((file) => file.replace(/\\/g, '/')));
  const scanned = uniqSorted(files.map((file) => file.replace(/\\/g, '/')));
  if (expected.length !== expectedFiles.length || JSON.stringify(expected) !== JSON.stringify(scanned)) {
    console.error(
      `[objectives-lint] Coverage mismatch: selected=${expected.length} scanned=${scanned.length}.`
    );
    console.error(`[objectives-lint] Selected: ${expected.join(', ') || '<none>'}`);
    console.error(`[objectives-lint] Scanned: ${scanned.join(', ') || '<none>'}`);
    process.exit(1);
  }
  console.log(`[objectives-lint] Coverage verified: selected=${expected.length} scanned=${scanned.length}.`);
}

const enforceRlsMissingLegacy = String(process.env.OBJECTIVES_ENFORCE_RLS_MISSING || '0') === '1' && hasIncludeFilter;
const enforcePolicyMissingLegacy = String(process.env.OBJECTIVES_ENFORCE_POLICY_MISSING || '0') === '1' && hasIncludeFilter;
const netNewMode = String(process.env.OBJECTIVES_LINT_NET_NEW_MODE || 'error').trim().toLowerCase();
const baselineFile = path.resolve(
  root,
  process.env.OBJECTIVES_LINT_BASELINE_FILE || path.join('config', 'ci', 'objectives-lint-baseline.json')
);
const writeBaseline = String(process.env.OBJECTIVES_LINT_WRITE_BASELINE || '0') === '1';
const allowMissingBaseline = String(process.env.OBJECTIVES_LINT_ALLOW_MISSING_BASELINE || '0') === '1';

function readBaselineFile(filePath) {
  try {
    const raw = fs.readFileSync(filePath, 'utf8');
    const parsed = JSON.parse(raw);
    const rls = Array.isArray(parsed.rls_missing) ? parsed.rls_missing : [];
    const policy = Array.isArray(parsed.policy_missing) ? parsed.policy_missing : [];
    return {
      exists: true,
      rls: new Set(rls.map((x) => String(x || '').trim()).filter(Boolean)),
      policy: new Set(policy.map((x) => String(x || '').trim()).filter(Boolean)),
    };
  } catch {
    return {
      exists: false,
      rls: new Set(),
      policy: new Set(),
    };
  }
}

function classifyFindings(findings, baselineSet) {
  const baseline = [];
  const netNew = [];
  for (const finding of findings) {
    const key = String(finding.key || '').trim();
    if (key && baselineSet.has(key)) baseline.push(finding);
    else netNew.push(finding);
  }
  return { baseline, netNew };
}

function uniqSorted(values) {
  return Array.from(new Set(values)).sort((a, b) => a.localeCompare(b));
}

const violations = [];
const rlsMissing = [];
const policyMissing = [];

const RULES = {
  DSN_URL: { msg: 'Hard-coded DSN (postgres://) detected' },
  SUPABASE_URL: { msg: 'Hard-coded Supabase URL detected' },
  LOCALHOST: { msg: 'Localhost literal detected in source' },
  TENANT_LITERAL: { msg: 'Hard-coded tenant/client/org/sender id literal detected' },
  RLS_OFF: { msg: 'RLS disabled or bypass detected (row_security off / DISABLE RLS)' },
  RLS_MISSING: { msg: 'CREATE TABLE without ENABLE ROW LEVEL SECURITY detected' },
  POLICY_MISSING: { msg: 'CREATE TABLE without CREATE POLICY detected' },
};

function isSuppressed(lines, idx, code) {
  // Look on this line or up to 3 lines above for a suppression with justification
  // JS/TS: // objectives:allow <CODE> Justification: ...
  // SQL   : -- objectives:allow <CODE> Justification: ...
  const re = new RegExp(`objectives:allow\\s+${code}\\b.*Justification:`, 'i');
  for (let i = Math.max(0, idx - 3); i <= idx; i++) {
    const raw = lines[i] || '';
    const l = raw.trim();
    // Accept both line comments and inline markers after code
    if (re.test(l)) return true;
    const commentIdx = raw.indexOf('--');
    if (commentIdx >= 0) {
      const comment = raw.slice(commentIdx).trim();
      if (re.test(comment)) return true;
    }
    const jsCommentIdx = raw.indexOf('//');
    if (jsCommentIdx >= 0) {
      const comment = raw.slice(jsCommentIdx).trim();
      if (re.test(comment)) return true;
    }
  }
  return false;
}

for (const rel of files) {
  const relPosix = rel.replace(/\\/g, '/');
  if (relPosix === 'scripts/ops/objectives-lint.js') continue;
  const full = path.join(root, rel);
  const content = readSafe(full);
  const lines = content.split(/\r?\n/);
  const createdTables = [];
  const rlsEnabledTables = new Set();
  // The canonical helper enables RLS and creates its service_role policy together.
  const serviceOnlyTables = new Set([...content.replace(/--[^\n]*|\/\*[\s\S]*?\*\//g, ' ')
    .matchAll(/^\s*(?:SELECT|PERFORM)\s+public\.enforce_service_only_rls_v1\s*\(\s*'("?[A-Za-z0-9_]+"?\."?[A-Za-z0-9_]+"?)'\s*::\s*regclass\s*\)\s*;/gmi)]
    .map((match) => match[1].replace(/"/g, '')));
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const isSql = /\.(sql)$/i.test(rel);

    // DSN URL
    if (/postgres(ql)?:\/\/(?!\[redacted\](?=['"`]|$))/i.test(line) && !isSuppressed(lines, i, 'DSN_URL')) {
      violations.push({ file: relPosix, line: i + 1, rule: 'DSN_URL', msg: RULES.DSN_URL.msg });
    }
    // Supabase URL
    if (/https?:\/\/[a-z0-9-]+\.supabase\.co\b/i.test(line) && !isSuppressed(lines, i, 'SUPABASE_URL')) {
      violations.push({ file: relPosix, line: i + 1, rule: 'SUPABASE_URL', msg: RULES.SUPABASE_URL.msg });
    }
    // Localhost literals (tests excluded by path filter)
    if (/(127\.0\.0\.1|https?:\/\/localhost(?:\:\d{2,5})?|localhost:\d{2,5})/i.test(line) && !isSuppressed(lines, i, 'LOCALHOST')) {
      violations.push({ file: relPosix, line: i + 1, rule: 'LOCALHOST', msg: RULES.LOCALHOST.msg });
    }
    if (isSql) {
      // RLS off (session-level)
      if (/\bSET\s+row_security\s*=\s*off\b/i.test(line) && !isSuppressed(lines, i, 'RLS_OFF')) {
        violations.push({ file: relPosix, line: i + 1, rule: 'RLS_OFF', msg: RULES.RLS_OFF.msg });
      }
      // RLS disabled at table-level
      if (/\bDISABLE\s+ROW\s+LEVEL\s+SECURITY\b/i.test(line) && !isSuppressed(lines, i, 'RLS_OFF')) {
        violations.push({ file: relPosix, line: i + 1, rule: 'RLS_OFF', msg: RULES.RLS_OFF.msg });
      }
      // Track created tables (schema-qualified or plain)
      const mCreate = line.match(/\bCREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?(?:"?([A-Za-z0-9_]+)"?\.)?"?([A-Za-z0-9_]+)"?(?=\s|\(|$)/i);
      if (mCreate) {
        const schema = (mCreate[1] || '').replace(/"/g, '');
        const table = (mCreate[2] || '').replace(/"/g, '');
        if (table) createdTables.push({ schema, table });
      }
      // Track RLS enablement for created tables
      const mRls = line.match(/\bALTER\s+TABLE\s+(?:IF\s+EXISTS\s+)?(?:ONLY\s+)?(?:"?([A-Za-z0-9_]+)"?\.)?"?([A-Za-z0-9_]+)"?(?=\s|\(|$)\s+ENABLE\s+ROW\s+LEVEL\s+SECURITY\b/i);
      if (mRls) {
        const schema = (mRls[1] || '').replace(/"/g, '');
        const table = (mRls[2] || '').replace(/"/g, '');
        if (table) {
          const name = (schema ? `${schema}.` : '') + table;
          rlsEnabledTables.add(name);
          rlsEnabledTables.add(table);
        }
      }
      // Tenant/Org/Client/Sender id hard-coded literals (heuristic, SQL)
      // Require the field name itself (not just a substring on variables like v_client_id)
      // to reduce false positives while still catching inline literals. Allow scope_id-style
      // fields when paired with an objectives:allow TENANT_LITERAL comment (handled via suppression).
      if (/\b(tenant_id|client_id|organization_id|sender_id)\b\s*(=|,|::)\s*('?[0-9a-fA-F-]{36}'?|\d+)/i.test(line)) {
        if (!isSuppressed(lines, i, 'TENANT_LITERAL')) {
          violations.push({ file: relPosix, line: i + 1, rule: 'TENANT_LITERAL', msg: RULES.TENANT_LITERAL.msg });
        }
      }
    } else {
      // Tenant/Org/Client/Sender id hard-coded literals (heuristic, JS/TS)
      if (/\b(tenant_id|client_id|organization_id|sender_id)\b\s*[:=]\s*['"][0-9a-fA-F-]{10,}['"]/i.test(line)
          && !isSuppressed(lines, i, 'TENANT_LITERAL')) {
        violations.push({ file: relPosix, line: i + 1, rule: 'TENANT_LITERAL', msg: RULES.TENANT_LITERAL.msg });
      }
    }
  }
  // Post-file SQL enforcement for ENABLE RLS on created tables
  if (/\.(sql)$/i.test(rel) && createdTables.length) {
    for (const t of createdTables) {
      const tName = (t.schema ? `${t.schema}.` : '') + t.table;
      const serviceOnly = serviceOnlyTables.has(tName);
      const suppressed = /objectives:allow\s+RLS_MISSING\b/i.test(content);
      if (!suppressed && !serviceOnly && !rlsEnabledTables.has(tName) && !rlsEnabledTables.has(t.table)) {
        rlsMissing.push({
          file: relPosix,
          line: 1,
          rule: 'RLS_MISSING',
          msg: `${RULES.RLS_MISSING.msg} (${tName})`,
          table: tName,
          key: `${relPosix}|${tName}`,
        });
      }
      // Policy presence (non-fatal by default; suppress with objectives:allow POLICY_MISSING)
      const supPol = /objectives:allow\s+POLICY_MISSING\b/i.test(content);
      const esc = tName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      const rePolicy = new RegExp(`CREATE\\s+POLICY[\\s\\S]*?\\bON\\s+(?:ONLY\\s+)?(?:"?${esc}"?)`, 'i');
      if (!serviceOnly && !rePolicy.test(content) && !supPol) {
        const rePolAlt = new RegExp(`CREATE\\s+POLICY[\\s\\S]*?\\bON\\s+[\\"\\w.]*${t.table}\\b`, 'i');
        if (!rePolAlt.test(content)) {
          policyMissing.push({
            file: relPosix,
            line: 1,
            rule: 'POLICY_MISSING',
            msg: `${RULES.POLICY_MISSING.msg} (${tName})`,
            table: tName,
            key: `${relPosix}|${tName}`,
          });
        }
      }
    }
  }
}

if (violations.length) {
  console.error('[objectives-lint] Violations found:');
  for (const v of violations) {
    const label = v.msg || v.rule;
    console.error(` - ${v.file}:${v.line}: [${v.rule}] ${label}`);
  }
  process.exit(1);
}

if (writeBaseline) {
  const baselinePayload = {
    version: 1,
    generated_at: new Date().toISOString(),
    rls_missing: uniqSorted(rlsMissing.map((item) => item.key)),
    policy_missing: uniqSorted(policyMissing.map((item) => item.key)),
  };
  fs.mkdirSync(path.dirname(baselineFile), { recursive: true });
  fs.writeFileSync(baselineFile, `${JSON.stringify(baselinePayload, null, 2)}\n`, 'utf8');
  console.log(`[objectives-lint] Baseline updated at ${path.relative(root, baselineFile)}`);
}

const baseline = readBaselineFile(baselineFile);
let hasErrors = false;

if (!enforceRlsMissingLegacy || !enforcePolicyMissingLegacy) {
  if (!baseline.exists && !allowMissingBaseline) {
    console.error(
      '[objectives-lint] Missing objectives baseline file. '
      + `Create ${path.relative(root, baselineFile)} or set OBJECTIVES_LINT_ALLOW_MISSING_BASELINE=1.`
    );
    process.exit(1);
  }
  if (!baseline.exists && allowMissingBaseline) {
    console.error('[objectives-lint] Baseline file missing; treating all findings as net-new (override enabled).');
  }
}

if (enforceRlsMissingLegacy) {
  if (rlsMissing.length) {
    console.error('[objectives-lint] RLS Missing (enforced):');
    for (const v of rlsMissing) {
      console.error(` - ${v.file}:${v.line}: [${v.rule}] ${v.msg}`);
    }
    hasErrors = true;
  }
} else {
  const rlsClassified = classifyFindings(rlsMissing, baseline.rls);
  console.error(
    `[objectives-lint] RLS Missing summary: baseline=${rlsClassified.baseline.length} net_new=${rlsClassified.netNew.length}`
  );
  if (rlsClassified.netNew.length) {
    for (const v of rlsClassified.netNew) {
      console.error(` - ${v.file}:${v.line}: [${v.rule}] ${v.msg}`);
    }
    if (netNewMode !== 'warn') hasErrors = true;
  }
}

if (enforcePolicyMissingLegacy) {
  if (policyMissing.length) {
    console.error('[objectives-lint] Policy Missing (enforced):');
    for (const v of policyMissing) {
      console.error(` - ${v.file}:${v.line}: [${v.rule}] ${v.msg}`);
    }
    hasErrors = true;
  }
} else {
  const policyClassified = classifyFindings(policyMissing, baseline.policy);
  console.error(
    `[objectives-lint] Policy Missing summary: baseline=${policyClassified.baseline.length} net_new=${policyClassified.netNew.length}`
  );
  if (policyClassified.netNew.length) {
    for (const v of policyClassified.netNew) {
      console.error(` - ${v.file}:${v.line}: [${v.rule}] ${v.msg}`);
    }
    if (netNewMode !== 'warn') hasErrors = true;
  }
}

if (hasErrors) {
  process.exit(1);
}

console.log('[objectives-lint] OK - no objective violations detected');
