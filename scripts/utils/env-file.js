const fs = require('fs');
const { parseEnv } = require('node:util');

let cachedDotenvModule;

function resolveDotenvModule() {
  if (cachedDotenvModule !== undefined) return cachedDotenvModule;
  try {
    cachedDotenvModule = require('dotenv');
  } catch (error) {
    if (error?.code !== 'MODULE_NOT_FOUND') {
      throw error;
    }
    cachedDotenvModule = null;
  }
  return cachedDotenvModule;
}

function parseEnvFallback(raw) {
  const parsed = {};
  for (const line of String(raw || '').split(/\r?\n/)) {
    if (!line || /^\s*#/.test(line)) continue;
    const normalized = line.replace(/^\s*export\s+/, '');
    const separatorIndex = normalized.indexOf('=');
    if (separatorIndex <= 0) continue;
    const key = normalized.slice(0, separatorIndex).trim();
    if (!key) continue;
    let value = normalized.slice(separatorIndex + 1);
    if (/^\s*['"]/.test(value)) {
      value = value.trim();
      const quote = value[0];
      if (value.endsWith(quote)) {
        value = value.slice(1, -1);
      } else {
        value = value.slice(1);
      }
    } else {
      value = value.replace(/\s+#.*$/, '').trim();
    }
    parsed[key] = value
      .replace(/\\n/g, '\n')
      .replace(/\\r/g, '\r')
      .replace(/\\t/g, '\t');
  }
  return parsed;
}

function parseEnvText(raw) {
  try {
    return typeof parseEnv === 'function' ? parseEnv(String(raw || '')) : parseEnvFallback(raw);
  } catch {
    return parseEnvFallback(raw);
  }
}

function readEnvFile(filePath) {
  if (!filePath || !fs.existsSync(filePath)) return null;
  const raw = fs.readFileSync(filePath, 'utf8');
  const dotenv = resolveDotenvModule();
  if (dotenv && typeof dotenv.parse === 'function') {
    return dotenv.parse(raw);
  }
  return parseEnvText(raw);
}

function applyParsedEnv(parsed, { override, env = process.env } = {}) {
  for (const [key, value] of Object.entries(parsed || {})) {
    if (!override && Object.prototype.hasOwnProperty.call(env, key)) continue;
    env[key] = value;
  }
}

function configEnvFile(filePath, { override = false, env = process.env } = {}) {
  const parsed = readEnvFile(filePath);
  if (!parsed) return;
  applyParsedEnv(parsed, { override, env });
}

function upsertEnvFileValues(filePath, updates = {}) {
  const resolvedPath = String(filePath || '').trim();
  if (!resolvedPath || !fs.existsSync(resolvedPath)) return false;

  const entries = Object.entries(updates)
    .map(([key, value]) => [String(key || '').trim(), value == null ? '' : String(value)])
    .filter(([key, value]) => key && value);
  if (entries.length === 0) return false;

  const replacements = new Map(entries);
  const raw = fs.readFileSync(resolvedPath, 'utf8');
  const lines = raw.split(/\r?\n/);
  const seen = new Set();
  const nextLines = lines.map((line) => {
    const idx = line.indexOf('=');
    if (idx <= 0) return line;
    const key = line.slice(0, idx).trim();
    if (!replacements.has(key)) return line;
    seen.add(key);
    return `${key}=${replacements.get(key)}`;
  });

  for (const [key, value] of replacements.entries()) {
    if (!seen.has(key)) nextLines.push(`${key}=${value}`);
  }

  fs.writeFileSync(resolvedPath, `${nextLines.join('\n').replace(/\n+$/u, '')}\n`, 'utf8');
  return true;
}

module.exports = {
  applyParsedEnv,
  configEnvFile,
  parseEnvFallback,
  parseEnvText,
  readEnvFile,
  resolveDotenvModule,
  upsertEnvFileValues,
};
