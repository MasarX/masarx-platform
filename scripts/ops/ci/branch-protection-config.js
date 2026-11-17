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

function normalizeBranchRule(branch, rule = {}) {
  const approvals = Number.parseInt(String(rule.approvals == null ? '0' : rule.approvals).trim(), 10);
  return {
    branch: String(branch || '').trim(),
    approvals: Number.isFinite(approvals) ? Math.max(0, Math.min(6, approvals)) : 0,
    requireCodeOwnerReviews: toBool(rule.require_code_owner_reviews, false),
    requireConversationResolution: toBool(rule.require_conversation_resolution, false),
    requiredChecks: sortUnique(rule.required_checks),
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
  sortUnique,
  toBool,
};
