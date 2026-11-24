#!/usr/bin/env node
/* eslint-disable no-console */
const fs = require('fs');
const path = require('path');

const DEFAULT_REGISTRY_PATH = path.join(__dirname, '..', '..', 'config', 'edge', 'functions.json');

function loadRegistry(registryPath = DEFAULT_REGISTRY_PATH) {
  const resolved = path.resolve(registryPath);
  if (!fs.existsSync(resolved)) {
    throw new Error(`[edge/functions-registry] Registry file not found at ${resolved}`);
  }
  const raw = fs.readFileSync(resolved, 'utf8');
  let data;
  try {
    data = JSON.parse(raw);
  } catch (e) {
    throw new Error(`[edge/functions-registry] Failed to parse JSON from ${resolved}: ${e.message}`);
  }
  const items = Array.isArray(data) ? data : (Array.isArray(data.functions) ? data.functions : null);
  if (!items) {
    throw new Error('[edge/functions-registry] Expected an array or { functions: [...] }');
  }
  const entries = items.map((item) => {
    const name = String(item.name || '').trim();
    if (!name) {
      throw new Error('[edge/functions-registry] Function entry missing name');
    }
    const authMode = String(item.auth_mode || item.authMode || 'supabase_jwt').trim().toLowerCase();
    const enabled = item.enabled !== false;
    return { name, authMode, enabled, ...('environments' in item && { environments: item.environments }) };
  });
  if (resolved === DEFAULT_REGISTRY_PATH) {
    const functionsRoot = path.join(__dirname, '..', '..', 'supabase', 'functions');
    const registered = new Set(entries.map(({ name }) => name));
    const missing = fs.readdirSync(functionsRoot, { withFileTypes: true })
      .filter(entry => entry.isDirectory() && !entry.name.startsWith('_') && !registered.has(entry.name))
      .map(entry => entry.name)
      .sort();
    if (missing.length) {
      throw new Error(`[edge/functions-registry] Missing from config/edge/functions.json: ${missing.join(', ')}`);
    }
  }
  return entries;
}

function functionsForDeploy(entries, environment) {
  return entries.filter(entry => entry.enabled === true && (!('environments' in entry) ||
    (Array.isArray(entry.environments) && entry.environments.includes(environment))));
}

function planDeploy(entries, environment) {
  const enabled = functionsForDeploy(entries, environment);
  const withJwt = [];
  const noVerifyJwt = [];
  for (const entry of enabled) {
    const mode = entry.authMode;
    if (mode === 'public_no_jwt' || mode === 'none') {
      noVerifyJwt.push(entry);
    } else {
      withJwt.push(entry);
    }
  }
  return { withJwt, noVerifyJwt };
}

if (require.main === module) {
  try {
    const entries = loadRegistry();
    const { withJwt, noVerifyJwt } = planDeploy(entries, process.env.DEPLOY_ENV);
    console.log(
      '[edge/functions-registry] withJwt:',
      withJwt.map((f) => f.name).join(', ') || '(none)',
    );
    console.log(
      '[edge/functions-registry] noVerifyJwt:',
      noVerifyJwt.map((f) => f.name).join(', ') || '(none)',
    );
  } catch (e) {
    console.error('[edge/functions-registry] Failed:', e.message);
    process.exit(1);
  }
}

module.exports = {
  DEFAULT_REGISTRY_PATH,
  loadRegistry,
  functionsForDeploy,
  planDeploy,
};

