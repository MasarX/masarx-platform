#!/usr/bin/env node
/* eslint-disable no-console */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { resolveBaseRef } = require('./changed-migrations-regex');
const { listChangedActiveMigrations } = require('./migration-fixture-guard');
const policy = require('../../../config/ci/supabase-managed-grants.json');

function withoutComments(source) {
  let result = ''; let index = 0; let quoted = false; let block = 0;
  while (index < source.length) {
    const pair = source.slice(index, index + 2);
    if (block) {
      if (pair === '/*') { block += 1; result += '  '; index += 2; }
      else if (pair === '*/') { block -= 1; result += '  '; index += 2; }
      else { result += source[index] === '\n' ? '\n' : ' '; index += 1; }
    } else if (quoted) {
      result += source[index++];
      if (source[index - 1] === "'") {
        if (source[index] === "'") { result += source[index++]; }
        else quoted = false;
      }
    } else if (pair === '--') {
      while (index < source.length && source[index] !== '\n') { result += ' '; index += 1; }
    } else if (pair === '/*') { block = 1; result += '  '; index += 2; }
    else { quoted = source[index] === "'"; result += source[index++]; }
  }
  if (block) throw new Error('Unterminated SQL block comment');
  return result;
}

function findManagedMutations(source, rules = policy) {
  const sql = withoutComments(source).replace(/''/g, "'");
  const schemaNames = rules.managed_schemas.join('|');
  const managedSchema = new RegExp(`(?:^|[^a-z_0-9])"?(${schemaNames})"?\\s*\\.`, 'i');
  const managedNamespace = new RegExp(`\\b(?:SCHEMA|SCHEMAS)\\s+[^;]*?\\b"?(${schemaNames})"?(?=[^a-z_0-9]|$)`, 'i');
  const managedRole = /^(?:supabase_[a-z_0-9]+|pgsodium_[a-z_0-9]+|authenticator)$/i;
  const findings = []; const seen = new Set();
  function add(match, target, kind) {
    const cleaned = target.replace(/\([^)]*\)/g, ' ');
    const dynamic = /%(?:\d+\$)?[sIL]|\|\||\$\d+/.test(cleaned);
    const namespace = kind === 'namespace' && new RegExp(`(?:^|[^a-z_0-9])"?(${schemaNames})"?(?=[^a-z_0-9]|$)`, 'i').test(cleaned);
    if (!dynamic && !namespace && !managedSchema.test(cleaned) && kind !== 'managed-role' && kind !== 'managed-extension') return;
    const line = sql.slice(0, match.index).split('\n').length;
    const key = `${line}:${match[0]}`;
    if (!seen.has(key)) { seen.add(key); findings.push({ line, kind: dynamic ? 'unresolved-dynamic-target' : kind, statement: match[0].replace(/\s+/g, ' ').trim() }); }
  }
  for (const match of sql.matchAll(/\b(?:GRANT|REVOKE)\b[^;]*?\bON\s+([^;]*?)\s+(?:TO|FROM)\b/gi)) {
    add(match, match[1], /\bSCHEMAS?\b/i.test(match[1]) ? 'namespace' : 'object');
  }
  const object = /\b(?:CREATE\s+(?:OR\s+REPLACE\s+)?(?:UNIQUE\s+|UNLOGGED\s+|TEMP(?:ORARY)?\s+)?|ALTER\s+|DROP\s+|COMMENT\s+ON\s+)(FUNCTION|PROCEDURE|ROUTINE|TABLE|VIEW|MATERIALIZED\s+VIEW|SEQUENCE|COLUMN|INDEX|TYPE|DOMAIN|SCHEMA|EXTENSION)\s+(?:IF\s+(?:NOT\s+)?EXISTS\s+)?(?:ONLY\s+)?((?:"[^"]+"|[a-z_][a-z_0-9]*|%(?:\d+\$)?[sIL])(?:\s*\.\s*(?:"[^"]+"|[a-z_][a-z_0-9]*|%(?:\d+\$)?[sIL]))*)/gi;
  for (const match of sql.matchAll(object)) {
    const kind = match[1].toUpperCase();
    if (kind === 'EXTENSION' && rules.managed_extensions.includes(match[2].replace(/"/g, '').toLowerCase())) add(match, match[2], 'managed-extension');
    else add(match, match[2], kind === 'SCHEMA' ? 'namespace' : 'object');
  }
  for (const match of sql.matchAll(/\b(?:CREATE|ALTER)\s+(?:CONSTRAINT\s+)?(?:POLICY|TRIGGER|RULE)\b[^;]*?\bON\s+([^\s;]+)/gi)) add(match, match[1], 'object');
  for (const match of sql.matchAll(/\bCREATE\s+(?:UNIQUE\s+)?INDEX\b[^;]*?\bON\s+(?:ONLY\s+)?([^\s;]+)/gi)) add(match, match[1], 'object');
  for (const match of sql.matchAll(/\bALTER\s+DEFAULT\s+PRIVILEGES\b[^;]*/gi)) {
    if (managedNamespace.test(match[0]) || /%(?:\d+\$)?[sIL]|\|\|/.test(match[0]) || /\bFOR\s+(?:ROLE|USER)\s+"?(?:supabase_\w+|pgsodium_\w+|authenticator)\b/i.test(match[0])) add(match, match[0], 'managed-role');
  }
  for (const match of sql.matchAll(/\b(?:OWNER\s+TO|AUTHORIZATION|SET\s+(?:LOCAL\s+)?ROLE|(?:CREATE|ALTER|DROP)\s+(?:ROLE|USER)|COMMENT\s+ON\s+ROLE|GRANT|REVOKE)\s+"?([a-z_][a-z_0-9]*)"?(?=\s|;|$)/gi)) {
    if (managedRole.test(match[1])) add(match, match[1], 'managed-role');
  }
  // Role lists can contain a managed role after an ordinary first role.
  for (const match of sql.matchAll(/\b(?:GRANT|REVOKE)\s+([^;]*?)\s+(?:TO|FROM)\b/gi)) {
    if (!/\bON\b/i.test(match[1]) && /\b(?:supabase_\w+|pgsodium_\w+|authenticator)\b/i.test(match[1])) add(match, match[1], 'managed-role');
  }
  for (const match of sql.matchAll(/\bALTER\s+DEFAULT\s+PRIVILEGES\s+FOR\s+(?:ROLE|USER)\s+([^;]*?)(?=\bIN\s+SCHEMA\b|\bGRANT\b|\bREVOKE\b|;)/gi)) {
    if (/\b(?:supabase_\w+|pgsodium_\w+|authenticator)\b/i.test(match[1])) add(match, match[1], 'managed-role');
  }
  return findings;
}

function scanFile(filePath, source, rules = policy) {
  const normalized = source.replace(/\r\n/g, '\n');
  const digest = crypto.createHash('sha256').update(normalized).digest('hex');
  const findings = findManagedMutations(normalized, rules);
  const exception = rules.allowlist.find(entry => entry.file === filePath && entry.sha256 === digest && entry.reason?.trim());
  const baseline = rules.baseline.files[filePath];
  return { file: filePath, findings, allowed: findings.length === 0 || digest === baseline || Boolean(exception), reason: digest === baseline ? rules.baseline.reason : exception?.reason || '' };
}

function eventBaseSha(event) {
  const base = event.pull_request?.base?.sha || event.merge_group?.base_sha || event.inputs?.base_sha || '';
  if (base && !/^[0-9a-f]{40}$/i.test(base)) throw new Error('Invalid exact base SHA in GitHub event.');
  return base;
}

function main(argv = process.argv.slice(2)) {
  const index = argv.indexOf('--base');
  const event = index < 0 && process.env.GITHUB_EVENT_PATH
    ? JSON.parse(fs.readFileSync(process.env.GITHUB_EVENT_PATH, 'utf8')) : {};
  const eventBase = eventBaseSha(event);
  const baseRef = index >= 0 ? argv[index + 1] : resolveBaseRef(eventBase ? { baseArg: eventBase } : {});
  if (!baseRef) throw new Error('A proven PR/base ref is required; pass --base for a local check.');
  const root = path.resolve(__dirname, '../../..');
  const files = listChangedActiveMigrations({ baseRef });
  const failures = [];
  for (const file of files) {
    const result = scanFile(file, fs.readFileSync(path.join(root, file), 'utf8'));
    if (!result.allowed) for (const finding of result.findings) failures.push(`${file}:${finding.line}: ${finding.kind}: ${finding.statement}`);
  }
  if (failures.length) throw new Error(failures.join('\n'));
  console.log(`[supabase-managed-grants] OK: ${files.length} changed migrations; historical baseline and hash-bound reviewed exceptions only.`);
}
if (require.main === module) {
  try { main(); } catch (error) { console.error(`[supabase-managed-grants] ${error.message}`); process.exitCode = 1; }
}
module.exports = { withoutComments, findManagedMutations, scanFile, eventBaseSha, main };
