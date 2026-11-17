#!/usr/bin/env node
/* eslint-disable no-console */
const fs = require('fs');
const path = require('path');
const { readEnvFile } = require('../../utils/env-file');

const DEFAULT_CALLBACK_PATH = '/auth/callback';
const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '0.0.0.0', '::1']);

function splitList(value) {
  if (Array.isArray(value)) return value.flatMap((entry) => splitList(entry));
  const raw = String(value || '').trim();
  if (!raw) return [];
  if (raw.startsWith('[')) {
    try {
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed)) return splitList(parsed);
    } catch {
      // Fall through to delimiter parsing.
    }
  }
  return raw
    .split(/[\s,;]+/)
    .map((entry) => String(entry || '').trim())
    .filter(Boolean);
}

function parseArgs(argv = process.argv.slice(2)) {
  const out = { _: [] };
  for (let index = 0; index < argv.length; index += 1) {
    const token = String(argv[index] || '').trim();
    if (!token) continue;
    if (!token.startsWith('--')) {
      out._.push(token);
      continue;
    }
    const withoutPrefix = token.slice(2);
    const [rawKey, ...inlineParts] = withoutPrefix.split('=');
    const key = rawKey.trim();
    const alias = key.replace(/-/g, '_');
    let value = inlineParts.length ? inlineParts.join('=') : null;
    if (value == null) {
      const next = argv[index + 1];
      if (next == null || String(next).startsWith('--')) {
        value = true;
      } else {
        value = String(next);
        index += 1;
      }
    }
    for (const targetKey of Array.from(new Set([key, alias]))) {
      if (out[targetKey] === undefined) {
        out[targetKey] = value;
      } else if (Array.isArray(out[targetKey])) {
        out[targetKey].push(value);
      } else {
        out[targetKey] = [out[targetKey], value];
      }
    }
  }
  return out;
}

function isTruthy(value) {
  return /^(1|true|yes|on|enabled)$/i.test(String(value || '').trim());
}

function firstValue(value) {
  return Array.isArray(value) ? value[0] : value;
}

function isLocalHost(hostname) {
  const normalized = String(hostname || '').trim().toLowerCase().replace(/^\[|\]$/g, '');
  return LOCAL_HOSTS.has(normalized);
}

function normalizeLocalRuntimeUrl(value) {
  const raw = String(firstValue(value) || '').trim();
  if (!raw) return '';
  try {
    const parsed = new URL(raw);
    if (!['http:', 'https:'].includes(parsed.protocol)) return '';
    if (!isLocalHost(parsed.hostname)) return '';
    parsed.username = '';
    parsed.password = '';
    parsed.search = '';
    parsed.hash = '';
    return parsed.toString().replace(/\/+$/g, '');
  } catch {
    return '';
  }
}

function readEnvFileSafe(filePath) {
  try {
    return readEnvFile(filePath) || {};
  } catch {
    return {};
  }
}

function mergeExplicitEnvFiles({ cwd = process.cwd(), env = process.env, args = {} } = {}) {
  const envFiles = splitList(args['env-file'] || args.env_file);
  const merged = {};
  for (const entry of envFiles) {
    const filePath = path.isAbsolute(entry) ? entry : path.resolve(cwd, entry);
    Object.assign(merged, readEnvFileSafe(filePath));
  }
  return {
    ...merged,
    ...env,
  };
}

function resolveApprovedRuntimeUrl({ args = {}, env = process.env } = {}) {
  return normalizeLocalRuntimeUrl(
    args['approved-supabase-url'] ||
      args.approved_supabase_url ||
      args['supabase-url'] ||
      args.supabase_url ||
      env.WORKSPACE_APPROVED_SUPABASE_URL ||
      env.SUPABASE_URL,
  );
}

function resolveRuntimeAuthConfigMode({ args = {}, env = process.env } = {}) {
  return String(
    firstValue(args['runtime-auth-config-mode'] || args.runtime_auth_config_mode) ||
      firstValue(args['runtime-readback-mode'] || args.runtime_readback_mode) ||
      env.LOCAL_AUTH_REDIRECTS_RUNTIME_AUTH_CONFIG_MODE ||
      '',
  ).trim().toLowerCase();
}

function resolveRuntimeAuthConfigApply({ args = {}, env = process.env } = {}) {
  return isTruthy(
    args['apply-runtime-auth-config'] ||
      args.apply_runtime_auth_config ||
      env.LOCAL_AUTH_REDIRECTS_APPLY_RUNTIME_AUTH_CONFIG,
  );
}

function resolveManagementApiToken({ args = {}, env = process.env } = {}) {
  const envName = String(
    firstValue(args['supabase-access-token-env'] || args.supabase_access_token_env) ||
      'SUPABASE_ACCESS_TOKEN',
  ).trim();
  return {
    env_name: envName,
    present: Boolean(String(env[envName] || '').trim()),
    value: String(env[envName] || '').trim(),
  };
}

function resolveManagementProjectRef({ args = {}, env = process.env } = {}) {
  return String(
    firstValue(args['af38b526-f5c1-468d-88fb-86677fbe872a'] || args.project_ref) ||
      env.SUPABASE_PROJECT_ID ||
      '',
  ).trim();
}

function buildExistingRuntimeAction({ approvedSupabaseUrl, callbacks }) {
  const callbackOrigin = (() => {
    try {
      return new URL(callbacks[0]).origin;
    } catch {
      return 'http://127.0.0.1:<leased-console-port>';
    }
  })();
  return {
    verify_with_management_api:
      `npm run local:auth-redirects -- --console-origin ${callbackOrigin} --approved-supabase-url ${approvedSupabaseUrl || '<approved-local-supabase-url>'} --runtime-auth-config-mode management-api --af38b526-f5c1-468d-88fb-86677fbe872a <supabase-af38b526-f5c1-468d-88fb-86677fbe872a> --check`,
    apply_with_management_api:
      `set LOCAL_AUTH_REDIRECTS_AUTH_CONFIG_GUARD=enabled && npm run local:auth-redirects -- --console-origin ${callbackOrigin} --approved-supabase-url ${approvedSupabaseUrl || '<approved-local-supabase-url>'} --runtime-auth-config-mode management-api --af38b526-f5c1-468d-88fb-86677fbe872a <supabase-af38b526-f5c1-468d-88fb-86677fbe872a> --apply-runtime-auth-config --confirm-runtime-url ${approvedSupabaseUrl || '<approved-local-supabase-url>'}`,
    controlled_restart:
      `Use the generated Supabase config overlay when starting or adopting the owned backend for ${approvedSupabaseUrl || '<approved-local-supabase-url>'}; TOML-only output does not update an already-running auth service.`,
  };
}

function resolveSupabaseApi(apiOverride) {
  if (apiOverride) return apiOverride;
  return require('./supabase-api');
}

function normalizeLocalCallbackUrl(value, options = {}) {
  const callbackPath = String(options.callbackPath || DEFAULT_CALLBACK_PATH).replace(/^\/?/, '/');
  const raw = String(value || '').trim();
  if (!raw) return '';
  const withProtocol = /^\d+$/.test(raw) ? `http://127.0.0.1:${raw}` : raw;
  let parsed;
  try {
    parsed = new URL(withProtocol);
  } catch {
    return '';
  }
  if (!['http:', 'https:'].includes(parsed.protocol)) return '';
  if (!isLocalHost(parsed.hostname)) return '';
  if (parsed.hostname === '0.0.0.0') parsed.hostname = '127.0.0.1';
  parsed.username = '';
  parsed.password = '';
  parsed.search = '';
  parsed.hash = '';

  const normalizedPath = String(parsed.pathname || '').replace(/\/+$/g, '');
  if (!normalizedPath || normalizedPath === '/') {
    parsed.pathname = callbackPath;
  } else if (!normalizedPath.endsWith(callbackPath)) {
    parsed.pathname = `${normalizedPath}${callbackPath}`;
  }
  return parsed.toString();
}

function normalizePort(value) {
  const parsed = Number.parseInt(String(value || '').trim(), 10);
  return Number.isFinite(parsed) && parsed > 0 && parsed <= 65535 ? parsed : 0;
}

function urlsFromRuntimeLeases(runtimeStatus, options = {}) {
  const owner = String(options.owner || '').trim();
  const leases = Array.isArray(runtimeStatus?.leases) ? runtimeStatus.leases : [];
  return leases
    .filter((lease) => (
      lease &&
      lease.resource_class === 'console-v2' &&
      (!owner || String(lease.owner || '').trim() === owner)
    ))
    .map((lease) => normalizeLocalCallbackUrl(lease.details?.port))
    .filter(Boolean);
}

function buildLocalConsoleCallbackUrls(options = {}) {
  const env = options.env || process.env;
  const values = [
    ...splitList(options.urls),
    ...splitList(options.origins),
    ...splitList(options.consolePorts)
      .map((port) => normalizePort(port))
      .filter(Boolean)
      .map((port) => `http://127.0.0.1:${port}`),
    ...splitList(env.WORKSPACE_LOCAL_AUTH_REDIRECT_URLS),
    ...splitList(env.WORKSPACE_LOCAL_AUTH_REDIRECT_ORIGINS),
    ...splitList(env.CONSOLE_BASE_URL),
    ...splitList(env.WORKSPACE_CONSOLE_BASE_URL),
    ...splitList(env.VITE_CONSOLE_BASE_URL),
    ...splitList(env.WORKSPACE_LOCAL_CONSOLE_PORTS)
      .map((port) => normalizePort(port))
      .filter(Boolean)
      .map((port) => `http://127.0.0.1:${port}`),
    ...urlsFromRuntimeLeases(options.runtimeStatus, { owner: options.owner }),
  ];
  return Array.from(new Set(values.map((value) => normalizeLocalCallbackUrl(value)).filter(Boolean)));
}

function stripTomlComment(line) {
  let quote = '';
  let escaped = false;
  let out = '';
  for (const char of String(line || '')) {
    if (quote === '"') {
      out += char;
      if (escaped) {
        escaped = false;
      } else if (char === '\\') {
        escaped = true;
      } else if (char === quote) {
        quote = '';
      }
      continue;
    }
    if (quote === "'") {
      out += char;
      if (char === quote) quote = '';
      continue;
    }
    if (char === '"' || char === "'") {
      quote = char;
      out += char;
      continue;
    }
    if (char === '#') break;
    out += char;
  }
  return out;
}

function findTomlSection(lines, sectionName) {
  const wanted = `[${String(sectionName || '').trim().toLowerCase()}]`;
  const start = lines.findIndex((line) => stripTomlComment(line).trim().toLowerCase() === wanted);
  if (start === -1) return null;
  let end = lines.length;
  for (let index = start + 1; index < lines.length; index += 1) {
    const trimmed = stripTomlComment(lines[index]).trim();
    if (/^\[[^\]]+\]$/.test(trimmed)) {
      end = index;
      break;
    }
  }
  return { start, end };
}

function arrayBracketClosed(valueText) {
  if (!String(valueText || '').includes('[')) return true;
  let quote = '';
  let escaped = false;
  let depth = 0;
  for (const char of String(valueText || '')) {
    if (quote === '"') {
      if (escaped) {
        escaped = false;
      } else if (char === '\\') {
        escaped = true;
      } else if (char === quote) {
        quote = '';
      }
      continue;
    }
    if (quote === "'") {
      if (char === quote) quote = '';
      continue;
    }
    if (char === '"' || char === "'") {
      quote = char;
      continue;
    }
    if (char === '[') depth += 1;
    if (char === ']') depth -= 1;
  }
  return depth <= 0 && String(valueText || '').includes('[');
}

function findTomlKeyAssignment(lines, section, key) {
  if (!section) return null;
  const keyPattern = new RegExp(`^\\s*${key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*=`, 'i');
  for (let index = section.start + 1; index < section.end; index += 1) {
    const cleanLine = stripTomlComment(lines[index]);
    if (!keyPattern.test(cleanLine)) continue;
    const valueLines = [lines[index]];
    let end = index + 1;
    while (!arrayBracketClosed(valueLines.map(stripTomlComment).join('\n')) && end < section.end) {
      valueLines.push(lines[end]);
      end += 1;
    }
    const valueText = valueLines
      .map(stripTomlComment)
      .join('\n')
      .replace(/^[^=]*=/, '')
      .trim();
    return { start: index, end, valueText };
  }
  return null;
}

function parseTomlStringArray(valueText) {
  const values = [];
  const text = String(valueText || '');
  let quote = '';
  let escaped = false;
  let current = '';
  for (const char of text) {
    if (!quote) {
      if (char === '"' || char === "'") {
        quote = char;
        current = '';
        escaped = false;
      }
      continue;
    }
    if (quote === '"') {
      if (escaped) {
        current += char === 'n' ? '\n' : char === 't' ? '\t' : char;
        escaped = false;
      } else if (char === '\\') {
        escaped = true;
      } else if (char === quote) {
        values.push(current);
        quote = '';
      } else {
        current += char;
      }
      continue;
    }
    if (char === quote) {
      values.push(current);
      quote = '';
    } else {
      current += char;
    }
  }
  return values.map((value) => String(value || '').trim()).filter(Boolean);
}

function readAuthAdditionalRedirectUrls(toml) {
  const lines = String(toml || '').split(/\r?\n/);
  const section = findTomlSection(lines, 'auth');
  const assignment = findTomlKeyAssignment(lines, section, 'additional_redirect_urls');
  return assignment ? parseTomlStringArray(assignment.valueText) : [];
}

function parseTomlString(valueText) {
  const values = parseTomlStringArray(valueText);
  return values[0] || '';
}

function readAuthSiteUrl(toml) {
  const lines = String(toml || '').split(/\r?\n/);
  const section = findTomlSection(lines, 'auth');
  const assignment = findTomlKeyAssignment(lines, section, 'site_url');
  return assignment ? parseTomlString(assignment.valueText) : '';
}

function formatTomlStringArray(values) {
  return `[${values.map((value) => JSON.stringify(String(value))).join(', ')}]`;
}

function replaceAuthSiteUrl(toml, siteUrl) {
  const nextLine = `site_url = ${JSON.stringify(String(siteUrl || ''))}`;
  const lines = String(toml || '').split(/\r?\n/);
  const section = findTomlSection(lines, 'auth');
  if (!section) {
    if (lines.length && lines[lines.length - 1].trim()) lines.push('');
    lines.push('[auth]', nextLine);
    return lines.join('\n');
  }

  const assignment = findTomlKeyAssignment(lines, section, 'site_url');
  if (assignment) {
    lines.splice(assignment.start, assignment.end - assignment.start, nextLine);
    return lines.join('\n');
  }

  lines.splice(section.start + 1, 0, nextLine);
  return lines.join('\n');
}

function replaceAuthAdditionalRedirectUrls(toml, urls) {
  const nextLine = `additional_redirect_urls = ${formatTomlStringArray(urls)}`;
  const lines = String(toml || '').split(/\r?\n/);
  const section = findTomlSection(lines, 'auth');
  if (!section) {
    if (lines.length && lines[lines.length - 1].trim()) lines.push('');
    lines.push('[auth]', nextLine);
    return lines.join('\n');
  }

  const assignment = findTomlKeyAssignment(lines, section, 'additional_redirect_urls');
  if (assignment) {
    lines.splice(assignment.start, assignment.end - assignment.start, nextLine);
    return lines.join('\n');
  }

  lines.splice(section.end, 0, nextLine);
  return lines.join('\n');
}

function mergeLocalAuthRedirectUrls(toml, requiredUrls = []) {
  const configured = readAuthAdditionalRedirectUrls(toml);
  const siteUrl = readAuthSiteUrl(toml);
  const normalizedRequired = Array.from(new Set(
    splitList(requiredUrls).map((url) => normalizeLocalCallbackUrl(url)).filter(Boolean),
  ));
  const requiredSiteUrl = normalizedRequired[0] || '';
  const existing = new Set(configured);
  const added = normalizedRequired.filter((url) => !existing.has(url));
  const siteUrlChanged = Boolean(requiredSiteUrl && siteUrl !== requiredSiteUrl);
  if (added.length === 0 && !siteUrlChanged) {
    return {
      toml,
      changed: false,
      configured,
      added: [],
      required: normalizedRequired,
      site_url: siteUrl,
      required_site_url: requiredSiteUrl,
      site_url_changed: false,
    };
  }
  const merged = Array.from(new Set([...configured, ...added]));
  let nextToml = toml;
  if (siteUrlChanged) {
    nextToml = replaceAuthSiteUrl(nextToml, requiredSiteUrl);
  }
  if (added.length) {
    nextToml = replaceAuthAdditionalRedirectUrls(nextToml, merged);
  }
  return {
    toml: nextToml,
    changed: true,
    configured: merged,
    added,
    required: normalizedRequired,
    site_url: requiredSiteUrl || siteUrl,
    previous_site_url: siteUrl,
    required_site_url: requiredSiteUrl,
    site_url_changed: siteUrlChanged,
  };
}

function validateLocalAuthRedirectAllowlist(toml, requiredUrls = []) {
  const configured = readAuthAdditionalRedirectUrls(toml);
  const siteUrl = readAuthSiteUrl(toml);
  const normalizedRequired = Array.from(new Set(
    splitList(requiredUrls).map((url) => normalizeLocalCallbackUrl(url)).filter(Boolean),
  ));
  const requiredSiteUrl = normalizedRequired[0] || '';
  const configuredSet = new Set(configured);
  const missing = normalizedRequired.filter((url) => !configuredSet.has(url));
  const siteUrlOk = Boolean(!requiredSiteUrl || siteUrl === requiredSiteUrl);
  return {
    ok: missing.length === 0 && siteUrlOk,
    configured,
    required: normalizedRequired,
    missing,
    site_url: siteUrl,
    required_site_url: requiredSiteUrl,
    site_url_ok: siteUrlOk,
  };
}

function readSupabaseConfigToml(cwd = process.cwd(), fsImpl = fs) {
  const configPath = path.join(cwd, 'supabase', 'config.toml');
  return {
    path: configPath,
    exists: fsImpl.existsSync(configPath),
    toml: fsImpl.existsSync(configPath) ? fsImpl.readFileSync(configPath, 'utf8') : '',
  };
}

function writeJson(filePath, payload) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
}

function writeText(filePath, content) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, content, 'utf8');
}

async function evaluateRunningRuntimeReadiness({
  args = {},
  env = process.env,
  callbacks = [],
  approvedSupabaseUrl = '',
  apply = false,
  supabaseApi,
} = {}) {
  const mode = resolveRuntimeAuthConfigMode({ args, env });
  const backendStarted = isTruthy(
    args['backend-started'] ||
      args.backend_started ||
      args['approved-runtime-backend-started'] ||
      args.approved_runtime_backend_started ||
      env.LOCAL_AUTH_REDIRECTS_BACKEND_STARTED,
  );
  const action = buildExistingRuntimeAction({ approvedSupabaseUrl, callbacks });
  const base = {
    approved_supabase_url: approvedSupabaseUrl,
    existing_runtime_required: true,
    backend_started: backendStarted,
    mode: mode || 'config-file-only',
    readback_attempted: false,
    apply_attempted: false,
    verified: false,
    status: 'partial',
    reason: '',
    missing: [],
    missing_env: [],
    action,
    service_role_used: false,
    secret_values_redacted: true,
  };

  if (!approvedSupabaseUrl) {
    return {
      ...base,
      status: 'blocked',
      reason: 'missing_approved_local_supabase_url',
      missing: ['approved-supabase-url'],
    };
  }

  if (!mode || mode === 'config-file-only' || mode === 'toml-only') {
    if (backendStarted) {
      return {
        ...base,
        status: 'complete',
        verified: true,
        reason: '',
        source: 'prestarted_local_config_file',
      };
    }
    return {
      ...base,
      status: 'partial',
      reason: 'running_auth_service_not_verified_from_config_file_only',
    };
  }

  if (mode !== 'management-api') {
    return {
      ...base,
      status: 'blocked',
      reason: `unsupported_runtime_auth_config_mode:${mode}`,
    };
  }

  const projectRef = resolveManagementProjectRef({ args, env });
  const token = resolveManagementApiToken({ args, env });
  const missing = [
    ...(projectRef ? [] : ['af38b526-f5c1-468d-88fb-86677fbe872a']),
    ...(token.present ? [] : [token.env_name]),
  ];
  if (missing.length) {
    return {
      ...base,
      status: 'blocked',
      reason: 'missing_management_api_runtime_readback_inputs',
      missing,
      missing_env: token.present ? [] : [token.env_name],
      project_ref_present: Boolean(projectRef),
    };
  }

  const api = resolveSupabaseApi(supabaseApi);
  let current;
  try {
    current = await api.getProjectAuthConfig(projectRef, token.value);
  } catch (error) {
    return {
      ...base,
      status: 'blocked',
      readback_attempted: true,
      reason: 'management_api_auth_config_readback_failed',
      error: error?.message || String(error),
      project_ref_present: true,
    };
  }

  const extracted = api.extractProjectAuthEmailUrlConfig(current);
  const currentRedirects = Array.isArray(extracted.additional_redirect_urls)
    ? extracted.additional_redirect_urls
    : [];
  const currentSet = new Set(currentRedirects);
  const missingRedirects = callbacks.filter((callback) => !currentSet.has(callback));
  if (missingRedirects.length === 0) {
    return {
      ...base,
      status: 'complete',
      readback_attempted: true,
      verified: true,
      reason: '',
      source: current.source || '',
      project_ref_present: true,
      missing: [],
    };
  }

  const applyRuntime = resolveRuntimeAuthConfigApply({ args, env }) || (apply && isTruthy(args['runtime-apply'] || args.runtime_apply));
  if (!applyRuntime) {
    return {
      ...base,
      status: 'partial',
      readback_attempted: true,
      reason: 'running_auth_service_missing_required_redirects',
      missing: missingRedirects,
      source: current.source || '',
      project_ref_present: true,
    };
  }

  const confirmRuntimeUrl = normalizeLocalRuntimeUrl(args['confirm-runtime-url'] || args.confirm_runtime_url);
  if (!isTruthy(env.LOCAL_AUTH_REDIRECTS_AUTH_CONFIG_GUARD)) {
    return {
      ...base,
      status: 'blocked',
      readback_attempted: true,
      reason: 'runtime_auth_config_apply_guard_disabled',
      missing_env: ['LOCAL_AUTH_REDIRECTS_AUTH_CONFIG_GUARD=enabled'],
      missing: missingRedirects,
      project_ref_present: true,
    };
  }
  if (confirmRuntimeUrl !== approvedSupabaseUrl) {
    return {
      ...base,
      status: 'blocked',
      readback_attempted: true,
      reason: 'confirm_runtime_url_mismatch',
      missing: ['confirm-runtime-url'],
      project_ref_present: true,
    };
  }

  const mergedRedirects = Array.from(new Set([...currentRedirects, ...callbacks]));
  const siteUrl = String(
    firstValue(args['site-url'] || args.site_url) ||
      extracted.site_url ||
      callbacks[0] ||
      '',
  ).trim();
  try {
    const applied = await api.setProjectAuthConfig(projectRef, token.value, {
      site_url: siteUrl,
      additional_redirect_urls: mergedRedirects,
      verify_attempts: args['verify-attempts'] || args.verify_attempts || 2,
      verify_delay_ms: args['verify-delay-ms'] || args.verify_delay_ms || 1000,
    });
    return {
      ...base,
      status: 'complete',
      readback_attempted: true,
      apply_attempted: true,
      verified: true,
      reason: '',
      source: applied.source || '',
      observed_source: applied.observed_source || '',
      project_ref_present: true,
      missing: [],
    };
  } catch (error) {
    return {
      ...base,
      status: 'blocked',
      readback_attempted: true,
      apply_attempted: true,
      reason: 'management_api_auth_config_apply_failed',
      error: error?.message || String(error),
      missing: missingRedirects,
      project_ref_present: true,
    };
  }
}

async function buildLocalAuthRedirectSummary(options = {}) {
  const cwd = path.resolve(options.cwd || process.cwd());
  const args = options.args || {};
  const env = mergeExplicitEnvFiles({ cwd, env: options.env || process.env, args });
  const apply = isTruthy(args.apply);
  const writeConfig = isTruthy(args['write-config'] || args.write_config || args.write);
  const outputConfigArg = firstValue(args['output-config'] || args.output_config || args.out);
  const outputConfigPath = outputConfigArg
    ? path.resolve(cwd, String(outputConfigArg))
    : '';
  const callbacks = buildLocalConsoleCallbackUrls({
    env,
    origins: args['console-origin'] || args.console_origin,
    urls: args['console-callback-url'] || args.console_callback_url,
    consolePorts: args['console-port'] || args.console_port,
  });
  const approvedSupabaseUrl = resolveApprovedRuntimeUrl({ args, env });
  const config = readSupabaseConfigToml(cwd);
  const blockers = [];
  const partials = [];

  if (!approvedSupabaseUrl) blockers.push('missing_approved_local_supabase_url');
  if (!config.exists) blockers.push('supabase_config_missing');
  if (callbacks.length === 0) blockers.push('missing_console_callback_origin');

  const validation = validateLocalAuthRedirectAllowlist(config.toml, callbacks);
  let merge = {
    changed: false,
    added: [],
    required: validation.required,
    configured: validation.configured,
    toml: config.toml,
  };
  let outputConfig = { written: false, path: '' };

  let configFileStatus = 'blocked';
  if (apply && blockers.length === 0) {
    merge = mergeLocalAuthRedirectUrls(config.toml, callbacks);
    if (outputConfigPath) {
      writeText(outputConfigPath, merge.toml);
      outputConfig = { written: true, path: outputConfigPath };
      configFileStatus = 'complete';
    } else if (writeConfig) {
      writeText(config.path, merge.toml);
      outputConfig = { written: true, path: config.path };
      configFileStatus = 'complete';
    } else if (merge.changed) {
      partials.push('apply_requires_output_config_or_write_config');
      configFileStatus = 'partial';
    } else {
      configFileStatus = 'complete';
    }
  } else if (!validation.ok) {
    partials.push('missing_local_auth_callback_allowlist');
    configFileStatus = blockers.length ? 'blocked' : 'partial';
  } else {
    configFileStatus = blockers.length ? 'blocked' : 'complete';
  }

  const runningRuntime = await evaluateRunningRuntimeReadiness({
    args,
    env,
    callbacks,
    approvedSupabaseUrl,
    apply,
    supabaseApi: options.supabaseApi,
  });
  if (runningRuntime.status === 'blocked') blockers.push(`running_runtime_${runningRuntime.reason}`);
  if (runningRuntime.status === 'partial') partials.push(`running_runtime_${runningRuntime.reason}`);

  const status = blockers.length > 0 ? 'blocked' : (partials.length > 0 ? 'partial' : 'complete');
  return {
    generated_at: new Date().toISOString(),
    status,
    mode: apply ? 'apply' : 'check',
    approved_runtime: {
      supabase_url: approvedSupabaseUrl,
      existing_runtime_required: true,
      backend_started: runningRuntime.backend_started === true,
    },
    config_file: {
      status: configFileStatus,
      readiness_scope: 'supabase_config_file_only',
      proves_running_runtime: false,
      output_config: outputConfig,
    },
    running_runtime: runningRuntime,
    callbacks: {
      required: validation.required,
      configured: apply && merge.configured ? merge.configured : validation.configured,
      missing: apply && configFileStatus === 'complete' ? [] : validation.missing,
      added: apply ? merge.added : [],
      ok: apply && configFileStatus === 'complete' ? true : validation.ok,
      site_url: apply && merge.site_url ? merge.site_url : validation.site_url,
      previous_site_url: apply ? (merge.previous_site_url || validation.site_url) : validation.site_url,
      required_site_url: validation.required_site_url,
      site_url_ok: apply && configFileStatus === 'complete' ? true : validation.site_url_ok,
      site_url_changed: apply ? Boolean(merge.site_url_changed) : !validation.site_url_ok,
    },
    supabase_config: {
      path: config.path,
      exists: config.exists,
      output_config: outputConfig,
    },
    blockers,
    partials,
    security: {
      server_side_only: true,
      service_role_used: false,
      service_role_browser_exposed: false,
      secret_values_redacted: true,
    },
    command_shape: {
      check:
        'npm run local:auth-redirects -- --console-origin http://127.0.0.1:<leased-console-port> --approved-supabase-url http://127.0.0.1:<approved-api-port> --check',
      apply_overlay:
        'npm run local:auth-redirects -- --console-origin http://127.0.0.1:<leased-console-port> --approved-supabase-url http://127.0.0.1:<approved-api-port> --apply --output-config <gitignored-supabase-config.toml>',
      verify_running_runtime:
        'npm run local:auth-redirects -- --console-origin http://127.0.0.1:<leased-console-port> --approved-supabase-url http://127.0.0.1:<approved-api-port> --runtime-auth-config-mode management-api --af38b526-f5c1-468d-88fb-86677fbe872a <supabase-af38b526-f5c1-468d-88fb-86677fbe872a> --check',
    },
  };
}

function printUsage() {
  console.log('Usage: node scripts/ops/workspace/local-auth-redirects.js [options]');
  console.log('');
  console.log('Options:');
  console.log('  --console-origin <url>             Local Console origin for auth callback');
  console.log('  --console-port <port>              Local Console port for auth callback');
  console.log('  --approved-supabase-url <url>      Existing approved local Supabase API URL');
  console.log('  --backend-started                  Mark approved local runtime as already started by caller');
  console.log('  --env-file <path>                  Explicit local env file to read values from');
  console.log('  --check                            Validate only');
  console.log('  --apply                            Merge callback allowlist into an output config');
  console.log('  --output-config <path>             Write merged Supabase config overlay to this path');
  console.log('  --write-config                     Update supabase/config.toml directly');
  console.log('  --runtime-auth-config-mode <mode>  Optional running-runtime readback mode: management-api');
  console.log('  --af38b526-f5c1-468d-88fb-86677fbe872a <ref>                Supabase project ref for management-api mode');
  console.log('  --apply-runtime-auth-config        Apply missing redirects through management API with guard');
  console.log('  --confirm-runtime-url <url>        Required for management API apply');
  console.log('  --summary-out <path>               Write JSON summary');
}

async function main() {
  const args = parseArgs();
  if (args.help || args.h) {
    printUsage();
    return;
  }
  const summary = await buildLocalAuthRedirectSummary({ args });
  const summaryOut = firstValue(args['summary-out'] || args.summary_out);
  if (summaryOut) writeJson(path.resolve(process.cwd(), String(summaryOut)), summary);
  console.log(JSON.stringify({
    status: summary.status,
    mode: summary.mode,
    approved_runtime: {
      supabase_url: summary.approved_runtime.supabase_url,
      backend_started: summary.approved_runtime.backend_started === true,
    },
    missing: summary.callbacks.missing,
    added: summary.callbacks.added,
    blockers: summary.blockers,
    partials: summary.partials,
    config_file_status: summary.config_file.status,
    running_runtime_status: summary.running_runtime.status,
    running_runtime_reason: summary.running_runtime.reason,
  }, null, 2));
}

if (require.main === module) {
  main().catch((error) => {
    console.error(error?.message || String(error));
    process.exit(1);
  });
}

module.exports = {
  DEFAULT_CALLBACK_PATH,
  buildLocalAuthRedirectSummary,
  buildLocalConsoleCallbackUrls,
  evaluateRunningRuntimeReadiness,
  findTomlKeyAssignment,
  findTomlSection,
  isLocalHost,
  mergeLocalAuthRedirectUrls,
  normalizeLocalRuntimeUrl,
  normalizeLocalCallbackUrl,
  parseTomlStringArray,
  parseArgs,
  readAuthAdditionalRedirectUrls,
  readSupabaseConfigToml,
  resolveApprovedRuntimeUrl,
  splitList,
  stripTomlComment,
  validateLocalAuthRedirectAllowlist,
};
