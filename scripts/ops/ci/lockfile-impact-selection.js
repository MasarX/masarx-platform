#!/usr/bin/env node
/* eslint-disable no-console */
'use strict';

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const LOCKFILE_PATH = 'package-lock.json';
const KNOWN_WORKSPACE_OWNERS = Object.freeze({
  'apps/console': 'apps/console/package.json',
  'apps/portal': 'apps/portal/package.json',
  'apps/fieldops': 'apps/fieldops/package.json',
  'packages/api': 'packages/api/package.json',
  'packages/auth': 'packages/auth/package.json',
  'packages/config': 'packages/config/package.json',
  'packages/ui': 'packages/ui/package.json',
  'packages/mobile-core': 'packages/mobile-core/package.json',
});
const MOBILE_OWNER_WORKSPACES = new Set(['apps/fieldops', 'packages/mobile-core']);
const NATIVE_PACKAGE_RE = /^(?:react-native(?:$|-)|@react-native\/|expo(?:$|-)|@expo\/|eas(?:$|-)|metro(?:$|-)|xcode$|gradle$|cocoapods$|@sentry\/react-native$|.*(?:darwin|linux|win32|android|ios|arm64|x64|ia32)(?:$|-))/i;

function normalizePath(value) {
  return String(value || '').trim().replace(/\\/g, '/').replace(/^\/+/, '');
}

function uniq(values) {
  return Array.from(new Set((Array.isArray(values) ? values : [])
    .map((value) => String(value || '').trim())
    .filter(Boolean)));
}

function stableStringify(value) {
  if (value == null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map((entry) => stableStringify(entry)).join(',')}]`;
  return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`).join(',')}}`;
}

function isLockfileOnlyChangeSet(changedFiles) {
  const files = uniq((Array.isArray(changedFiles) ? changedFiles : []).map(normalizePath));
  return files.length === 1 && files[0] === LOCKFILE_PATH;
}

function defaultGitShow({ ref, filePath = LOCKFILE_PATH, cwd = process.cwd() } = {}) {
  const resolvedRef = String(ref || '').trim();
  if (!resolvedRef) throw new Error('missing_ref');
  const res = spawnSync('git', ['show', `${resolvedRef}:${filePath}`], {
    cwd,
    encoding: 'utf8',
    windowsHide: true,
    maxBuffer: 64 * 1024 * 1024,
  });
  if (res.error) throw res.error;
  if (res.status !== 0) {
    throw new Error(String(res.stderr || '').trim() || `git show failed for ${resolvedRef}:${filePath}`);
  }
  return String(res.stdout || '');
}

function readLockfileAtRef({ ref, cwd = process.cwd(), gitShowImpl = defaultGitShow } = {}) {
  return gitShowImpl({ ref, cwd, filePath: LOCKFILE_PATH });
}

function parseNpmLockfileV3(raw) {
  let parsed;
  try {
    parsed = JSON.parse(String(raw || '').replace(/^\uFEFF/, ''));
  } catch (error) {
    return { ok: false, reason: 'parse_error', lockfile: null };
  }
  if (!parsed || typeof parsed !== 'object' || Number(parsed.lockfileVersion) !== 3) {
    return { ok: false, reason: 'non_v3_lockfile', lockfile: null };
  }
  if (!parsed.packages || typeof parsed.packages !== 'object' || Array.isArray(parsed.packages)) {
    return { ok: false, reason: 'missing_packages', lockfile: null };
  }
  return { ok: true, reason: '', lockfile: parsed };
}

function diffLockfilePackages({ baseLock, headLock } = {}) {
  const basePackages = baseLock?.packages && typeof baseLock.packages === 'object' ? baseLock.packages : {};
  const headPackages = headLock?.packages && typeof headLock.packages === 'object' ? headLock.packages : {};
  const keys = Array.from(new Set([...Object.keys(basePackages), ...Object.keys(headPackages)])).sort();
  return keys.filter((key) => stableStringify(basePackages[key]) !== stableStringify(headPackages[key]));
}

function isRootOrGlobalLockEntry(packageKey) {
  const key = normalizePath(packageKey);
  return key === '' || key.startsWith('node_modules/');
}

function resolveOwnerWorkspaceForLockEntry(packageKey) {
  const key = normalizePath(packageKey);
  if (!key || isRootOrGlobalLockEntry(key)) return '';
  const workspaceKeys = Object.keys(KNOWN_WORKSPACE_OWNERS).sort((a, b) => b.length - a.length);
  for (const workspace of workspaceKeys) {
    if (key === workspace || key.startsWith(`${workspace}/node_modules/`)) return workspace;
  }
  return '';
}

function packageNameFromLockEntry(packageKey, entry = {}) {
  const explicitName = String(entry?.name || '').trim();
  if (explicitName) return explicitName;
  const key = normalizePath(packageKey);
  const marker = '/node_modules/';
  const markerIndex = key.lastIndexOf(marker);
  const local = markerIndex >= 0 ? key.slice(markerIndex + marker.length) : key;
  const parts = local.split('/').filter(Boolean);
  if (!parts.length) return '';
  if (parts[0].startsWith('@') && parts[1]) return `${parts[0]}/${parts[1]}`;
  return parts[0];
}

function isNativePackageName(packageName) {
  return NATIVE_PACKAGE_RE.test(String(packageName || '').trim());
}

function resolveSyntheticImpactFilesForLockfileOwners(owners) {
  return uniq((Array.isArray(owners) ? owners : [])
    .map((owner) => KNOWN_WORKSPACE_OWNERS[normalizePath(owner)] || ''))
    .sort();
}

function fullFallback(reason, details = {}) {
  return {
    applicable: true,
    mode: 'full_fallback',
    optimized: false,
    forceFull: true,
    reason,
    classificationFiles: [LOCKFILE_PATH],
    ownerWorkspaces: [],
    changedPackageKeys: uniq(details.changedPackageKeys || []),
    nativePackageKeys: uniq(details.nativePackageKeys || []),
  };
}

function resolveLockfileOnlyImpact({
  changedFiles,
  baseRef,
  headRef,
  cwd = process.cwd(),
  gitShowImpl = defaultGitShow,
} = {}) {
  if (!isLockfileOnlyChangeSet(changedFiles)) {
    return {
      applicable: false,
      mode: 'not_applicable',
      optimized: false,
      forceFull: false,
      reason: 'not_lockfile_only',
      classificationFiles: uniq(changedFiles || []),
      ownerWorkspaces: [],
      changedPackageKeys: [],
      nativePackageKeys: [],
    };
  }

  const base = String(baseRef || '').trim();
  const head = String(headRef || '').trim();
  if (!base || !head) return fullFallback('missing_ref');

  let baseParsed;
  let headParsed;
  try {
    baseParsed = parseNpmLockfileV3(readLockfileAtRef({ ref: base, cwd, gitShowImpl }));
    headParsed = parseNpmLockfileV3(readLockfileAtRef({ ref: head, cwd, gitShowImpl }));
  } catch (error) {
    return fullFallback('read_error');
  }
  if (!baseParsed.ok) return fullFallback(baseParsed.reason || 'base_parse_error');
  if (!headParsed.ok) return fullFallback(headParsed.reason || 'head_parse_error');

  const changedPackageKeys = diffLockfilePackages({
    baseLock: baseParsed.lockfile,
    headLock: headParsed.lockfile,
  });
  if (!changedPackageKeys.length) {
    return {
      applicable: true,
      mode: 'optimized',
      optimized: true,
      forceFull: false,
      reason: 'no_lockfile_package_delta',
      classificationFiles: [],
      ownerWorkspaces: [],
      changedPackageKeys: [],
      nativePackageKeys: [],
    };
  }

  const ownerWorkspaces = new Set();
  const nativePackageKeys = [];
  for (const key of changedPackageKeys) {
    if (isRootOrGlobalLockEntry(key)) {
      return fullFallback('root_global_entry', { changedPackageKeys });
    }
    const owner = resolveOwnerWorkspaceForLockEntry(key);
    if (!owner) {
      return fullFallback('unknown_workspace_entry', { changedPackageKeys });
    }
    const headEntry = headParsed.lockfile.packages[key] || {};
    const baseEntry = baseParsed.lockfile.packages[key] || {};
    const packageName = packageNameFromLockEntry(key, headEntry) || packageNameFromLockEntry(key, baseEntry);
    if (isNativePackageName(packageName)) {
      nativePackageKeys.push(key);
      if (!MOBILE_OWNER_WORKSPACES.has(owner)) {
        return fullFallback('native_ambiguous', { changedPackageKeys, nativePackageKeys });
      }
    }
    ownerWorkspaces.add(owner);
  }

  const owners = Array.from(ownerWorkspaces).sort();
  return {
    applicable: true,
    mode: 'optimized',
    optimized: true,
    forceFull: false,
    reason: 'workspace_scoped',
    classificationFiles: resolveSyntheticImpactFilesForLockfileOwners(owners),
    ownerWorkspaces: owners,
    changedPackageKeys,
    nativePackageKeys: uniq(nativePackageKeys),
  };
}

module.exports = {
  LOCKFILE_PATH,
  KNOWN_WORKSPACE_OWNERS,
  normalizePath,
  stableStringify,
  isLockfileOnlyChangeSet,
  readLockfileAtRef,
  parseNpmLockfileV3,
  diffLockfilePackages,
  isRootOrGlobalLockEntry,
  resolveOwnerWorkspaceForLockEntry,
  packageNameFromLockEntry,
  isNativePackageName,
  resolveSyntheticImpactFilesForLockfileOwners,
  resolveLockfileOnlyImpact,
};
