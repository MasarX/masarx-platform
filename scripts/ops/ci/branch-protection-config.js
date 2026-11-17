#!/usr/bin/env node
/* eslint-disable no-console */

const fs = require('fs');
const path = require('path');

const repoRoot = path.resolve(__dirname, '..', '..', '..');
const defaultConfigPath = path.join(repoRoot, 'config', 'ci', 'branch-protection.json');

function sortUnique(values) {
  return Array.from(new Set(
    (Array.isArray(values) ? values : [])
      .map((value) => String(value || '').trim())
      .filter(Boolean),
  )).sort();
}

function toBool(value, fallback = false) {
  const raw = String(value == null ? '' : value).trim().toLowerCase();
  if (!raw) return Boolean(fallback);
  if (['1', 'true', 'yes', 'y', 'on'].includes(raw)) return true;
  if (['0', 'false', 'no', 'n', 'off'].includes(raw)) return false;
  return Boolean(fallback);
}

function normalizeRequiredCheckAppIds(raw, requiredChecks, defaultAppIdRaw) {
  const source = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
  const allowed = new Set(requiredChecks);
  const hasDefault = defaultAppIdRaw != null && String(defaultAppIdRaw).trim() !== '';
  const defaultAppId = Number(defaultAppIdRaw);
  if (hasDefault && (!Number.isInteger(defaultAppId) || (defaultAppId < 1 && defaultAppId !== -1))) {
    throw new Error('required_check_app_id must be a positive integer or -1.');
  }
  const defaults = hasDefault
    ? requiredChecks.map((context) => [context, defaultAppId])
    : [];
  const overrides = Object.entries(source)
    .map(([context, appId]) => [String(context || '').trim(), Number(appId)])
    .filter(([context]) => Boolean(context))
    .map(([context, appId]) => {
      if (!allowed.has(context)) {
        throw new Error(`required_check_app_ids references non-required context "${context}".`);
      }
      if (!Number.isInteger(appId) || (appId < 1 && appId !== -1)) {
        throw new Error(`required_check_app_ids.${context} must be a positive integer or -1.`);
      }
      return [context, appId];
    })
    .sort(([left], [right]) => left.localeCompare(right));
  return Object.fromEntries([...defaults, ...overrides]
    .sort(([left], [right]) => left.localeCompare(right)));
}

function normalizeBranchRule(branch, rule = {}) {
  const approvals = Number.parseInt(String(rule.approvals == null ? '0' : rule.approvals).trim(), 10);
  const requiredChecks = sortUnique(rule.required_checks);
  return {
    branch: String(branch || '').trim(),
    approvals: Number.isFinite(approvals) ? Math.max(0, Math.min(6, approvals)) : 0,
    requireCodeOwnerReviews: toBool(rule.require_code_owner_reviews, false),
    requireConversationResolution: toBool(rule.require_conversation_resolution, false),
    requiredChecks,
    requiredCheckAppIds: normalizeRequiredCheckAppIds(
      rule.required_check_app_ids,
      requiredChecks,
      rule.required_check_app_id,
    ),
  };
}

function loadBranchProtectionConfig(configPath = defaultConfigPath) {
  const resolved = path.resolve(String(configPath || '').trim() || defaultConfigPath);
  const parsed = JSON.parse(fs.readFileSync(resolved, 'utf8'));
  const version = Number(parsed?.version || 0);
  if (version !== 1) {
    throw new Error(`Unsupported branch-protection config version ${version}. Expected version=1.`);
  }
  const branches = parsed?.branches && typeof parsed.branches === 'object' ? parsed.branches : {};
  if (!Object.keys(branches).length) {
    throw new Error('branch-protection config must define at least one branch.');
  }
  return {
    configPath: resolved,
    version,
    branches,
  };
}

function loadExpectedBranchProtection(config, branch) {
  const branches = config?.branches && typeof config.branches === 'object' ? config.branches : {};
  const key = String(branch || '').trim();
  if (!key || !branches[key]) {
    throw new Error(`Missing branch-protection config for branch "${key || '<empty>'}".`);
  }
  return normalizeBranchRule(key, branches[key]);
}

module.exports = {
  defaultConfigPath,
  loadBranchProtectionConfig,
  loadExpectedBranchProtection,
  normalizeBranchRule,
  normalizeRequiredCheckAppIds,
  sortUnique,
  toBool,
};
