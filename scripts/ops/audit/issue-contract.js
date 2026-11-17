#!/usr/bin/env node
'use strict';

function norm(value) {
  return String(value || '').trim();
}

function escapeForRegex(value) {
  return String(value || '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function parseSection(text, headings) {
  const raw = String(text || '');
  const variants = Array.isArray(headings) ? headings : [headings];
  for (const heading of variants) {
    const inline = raw.match(new RegExp(`^\\s*${escapeForRegex(heading)}\\s*[:\\-]\\s*(.+)$`, 'im'));
    if (inline && inline[1]) return inline[1].trim();
  }

  const lines = raw.replace(/\r/g, '').split('\n');
  const headingPatterns = variants.map((heading) => new RegExp(`^\\s*#{1,6}\\s*${escapeForRegex(heading)}\\s*:?\\s*$`, 'i'));
  const start = lines.findIndex((line) => headingPatterns.some((pattern) => pattern.test(line)));
  if (start < 0) return '';

  const collected = [];
  for (let index = start + 1; index < lines.length; index += 1) {
    const line = lines[index];
    if (/^\s*#{1,6}\s+.+$/.test(line)) break;
    collected.push(line);
  }
  return collected.join('\n').trim();
}

function parseBulletItems(text) {
  return String(text || '')
    .replace(/\r/g, '')
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => /^[-*]\s+/.test(line) || /^\d+\.\s+/.test(line))
    .map((line) => line.replace(/^[-*]\s+/, '').replace(/^\d+\.\s+/, '').trim())
    .filter(Boolean);
}

function isExplicitlyOptional(text) {
  const value = norm(text).toLowerCase();
  if (!value) return true;
  return [
    'n/a',
    'na',
    'none',
    'not needed',
    'not required',
    'no docs',
    'no documentation updates',
    'no tests',
    'no additional tests',
    'no changes',
  ].includes(value);
}

function isMeaningfulRequirement(text) {
  const value = norm(text);
  if (!value) return false;
  return !isExplicitlyOptional(value);
}

function inferExpectedSurfaceIds(text, fallbackSurface = '') {
  const haystack = `${norm(text)} ${norm(fallbackSurface)}`.toLowerCase();
  const expected = [];
  if (!haystack) return expected;
  if (/\b(db|database|backend|workflow|edge|sql|migration|rls)\b/.test(haystack)) expected.push('db');
  if (/\b(console)\b/.test(haystack)) expected.push('console');
  if (/\b(portal)\b/.test(haystack)) expected.push('portal');
  if (/\b(field ?ops|fieldops|mobile|driver app)\b/.test(haystack)) expected.push('mobile_fieldops');
  if (/\b(api|webhook|ingress)\b/.test(haystack)) expected.push('api_ingress');
  if (/\b(landing|marketing|website)\b/.test(haystack)) expected.push('landing');
  if (/\b(docs|documentation|runbook|adr|openapi)\b/.test(haystack)) expected.push('docs');
  return Array.from(new Set(expected));
}

function parseIssueAuditContract(body) {
  const raw = String(body || '');
  return {
    surfaces: parseSection(raw, ['Surfaces / Systems', 'Surfaces', 'Systems']),
    acceptanceCriteria: parseSection(raw, ['Acceptance Criteria']),
    requiredDeliverables: parseSection(raw, ['Required deliverables', 'Required Deliverables']),
    requiredTests: parseSection(raw, ['Required tests', 'Required Tests']),
    requiredDocs: parseSection(raw, ['Required docs', 'Required Docs', 'Required documentation']),
    definitionOfDone: parseSection(raw, ['Definition of done', 'Definition of Done']),
  };
}

function remediationOriginalIssueNumber(text) {
  const match = String(text || '').match(/\bOriginal-Issue\s*:\s*#?(\d+)\b/i);
  return match && match[1] ? Number.parseInt(match[1], 10) : 0;
}

module.exports = {
  inferExpectedSurfaceIds,
  isExplicitlyOptional,
  isMeaningfulRequirement,
  parseBulletItems,
  parseIssueAuditContract,
  parseSection,
  remediationOriginalIssueNumber,
};
