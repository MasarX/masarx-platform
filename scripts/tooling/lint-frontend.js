/* eslint-disable no-console */
const fs = require('fs');
const path = require('path');

const repoRoot = process.cwd();
const configPath = path.join(repoRoot, 'config', 'lint', 'frontend-lint.json');

const defaultConfig = {
  ignore: [],
  allow: {
    from: [],
    supabaseUrl: [],
    serviceRole: [],
    appContextImport: [],
  },
  allowFromReceivers: ['Array', 'Object', 'String', 'Buffer', 'URLSearchParams'],
};

function loadConfig() {
  if (!fs.existsSync(configPath)) return defaultConfig;
  try {
    const raw = fs.readFileSync(configPath, 'utf8');
    const parsed = JSON.parse(raw);
    return {
      ...defaultConfig,
      ...parsed,
      allow: {
        ...defaultConfig.allow,
        ...(parsed.allow || {}),
      },
      allowFromReceivers: Array.isArray(parsed.allowFromReceivers)
        ? parsed.allowFromReceivers
        : defaultConfig.allowFromReceivers,
    };
  } catch (err) {
    console.warn('[lint:frontend] Failed to parse config/lint/frontend-lint.json; using defaults.');
    return defaultConfig;
  }
}

const config = loadConfig();
const ignoreMatchers = (config.ignore || []).map((pattern) => new RegExp(pattern));
const allowMatchers = {
  from: (config.allow?.from || []).map((pattern) => new RegExp(pattern)),
  supabaseUrl: (config.allow?.supabaseUrl || []).map((pattern) => new RegExp(pattern)),
  serviceRole: (config.allow?.serviceRole || []).map((pattern) => new RegExp(pattern)),
  appContextImport: (config.allow?.appContextImport || []).map((pattern) => new RegExp(pattern)),
};

function resolveScanRoots(argv) {
  const args = (argv || []).slice(2).filter((arg) => arg && !arg.startsWith('-'));
  const roots = args.length ? args : ['apps', 'packages'];
  return roots
    .map((dir) => (path.isAbsolute(dir) ? dir : path.join(repoRoot, dir)))
    .filter((dir) => fs.existsSync(dir));
}

const scanRoots = resolveScanRoots(process.argv);

const allowedExtensions = new Set(['.js', '.jsx', '.ts', '.tsx', '.mjs', '.cjs']);
const ignoredDirs = new Set([
  '.git',
  '.cache',
  '.eas',
  '.expo',
  '.expo-shared',
  '.next',
  '.parcel-cache',
  '.storybook',
  '.turbo',
  '.vite',
  '.vercel',
  'build',
  'dist',
  'coverage',
  'node_modules',
  'out',
]);

function toPosix(filePath) {
  return filePath.split(path.sep).join('/');
}

function isIgnoredPath(relPath) {
  return ignoreMatchers.some((re) => re.test(relPath));
}

function isRuleAllowed(rule, relPath) {
  return allowMatchers[rule]?.some((re) => re.test(relPath)) || false;
}

function getLineAndColumn(content, index) {
  const slice = content.slice(0, index);
  const lines = slice.split(/\r?\n/);
  const line = lines.length;
  const column = lines[lines.length - 1].length + 1;
  return { line, column };
}

function getReceiverIdentifier(content, dotIndex) {
  let i = dotIndex - 1;
  while (i >= 0 && /\s/.test(content[i])) i -= 1;
  if (i < 0 || !/[A-Za-z0-9_$]/.test(content[i])) return '';
  let end = i;
  while (i >= 0 && /[A-Za-z0-9_$]/.test(content[i])) i -= 1;
  return content.slice(i + 1, end + 1);
}

function resolveImportTarget(importerFile, importPath) {
  const base = path.resolve(path.dirname(importerFile), importPath);
  const candidateFiles = [
    base,
    `${base}.ts`,
    `${base}.tsx`,
    `${base}.js`,
    `${base}.jsx`,
    `${base}.mjs`,
    `${base}.cjs`,
    path.join(base, 'index.ts'),
    path.join(base, 'index.tsx'),
    path.join(base, 'index.js'),
    path.join(base, 'index.jsx'),
    path.join(base, 'index.mjs'),
    path.join(base, 'index.cjs'),
  ];
  return candidateFiles.some((candidate) => fs.existsSync(candidate));
}

function collectFiles(dir, relBase, out) {
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    const rel = toPosix(path.join(relBase, entry.name));
    if (entry.isDirectory()) {
      if (ignoredDirs.has(entry.name)) continue;
      if (isIgnoredPath(rel)) continue;
      collectFiles(full, rel, out);
      continue;
    }
    if (!entry.isFile()) continue;
    if (!allowedExtensions.has(path.extname(entry.name))) continue;
    if (isIgnoredPath(rel)) continue;
    out.push({ full, rel });
  }
}

const violations = [];

function addSimpleViolation(rule, relPath, detail) {
  violations.push({ rule, relPath, line: 1, column: 1, detail });
}

function addViolation(rule, relPath, index, content, detail) {
  const { line, column } = getLineAndColumn(content, index);
  violations.push({ rule, relPath, line, column, detail });
}

function lintFile(file) {
  const content = fs.readFileSync(file.full, 'utf8');

  if (!isRuleAllowed('supabaseUrl', file.rel)) {
    const supabaseUrlRegex = /https?:\/\/[a-z0-9-]+\.supabase\.co/gi;
    let match;
    while ((match = supabaseUrlRegex.exec(content))) {
      addViolation('supabaseUrl', file.rel, match.index, content, match[0]);
    }
  }

  if (!isRuleAllowed('serviceRole', file.rel)) {
    const serviceRoleRegex = /service[_-]?role|SUPABASE_SERVICE_ROLE/gi;
    let match;
    while ((match = serviceRoleRegex.exec(content))) {
      addViolation('serviceRole', file.rel, match.index, content, match[0]);
    }
  }

  if (!isRuleAllowed('from', file.rel)) {
    const fromRegex = /\.\s*from\s*\(/g;
    let match;
    while ((match = fromRegex.exec(content))) {
      const receiver = getReceiverIdentifier(content, match.index);
      if (config.allowFromReceivers.includes(receiver)) continue;
      addViolation('from', file.rel, match.index, content, receiver || '.from');
    }
  }

  if (!isRuleAllowed('appContextImport', file.rel)) {
    const appContextImportRegex = /from\s+["'](\.{1,2}\/[^"']*app-context)["']/g;
    let match;
    while ((match = appContextImportRegex.exec(content))) {
      const importPath = match[1];
      if (!resolveImportTarget(file.full, importPath)) {
        addViolation(
          'appContextImport',
          file.rel,
          match.index,
          content,
          `Unresolved app-context import: ${importPath}`
        );
      }
    }
  }
}

const files = [];
for (const root of scanRoots) {
  const stat = fs.statSync(root);
  const relBase = toPosix(path.relative(repoRoot, root));
  if (stat.isDirectory()) {
    collectFiles(root, relBase, files);
    continue;
  }
  if (!stat.isFile()) continue;
  if (!allowedExtensions.has(path.extname(root))) continue;
  if (isIgnoredPath(relBase)) continue;
  files.push({ full: root, rel: relBase });
}

for (const file of files) {
  lintFile(file);
}

function collectSpecFiles(dir, relBase, out) {
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    const rel = toPosix(path.join(relBase, entry.name));
    if (entry.isDirectory()) {
      if (ignoredDirs.has(entry.name)) continue;
      collectSpecFiles(full, rel, out);
      continue;
    }
    if (!entry.isFile()) continue;
    if (!/\.spec\.(ts|tsx)$/.test(entry.name)) continue;
    out.push({ full, rel });
  }
}

function parsePlaywrightTestMatchPatterns(configContent) {
  const patterns = [];
  const regexLiteral = /testMatch\s*:\s*\/((?:\\\/|[^/])+)\/([gimsuy]*)/g;
  let match;
  while ((match = regexLiteral.exec(configContent))) {
    try {
      patterns.push(new RegExp(match[1], match[2]));
    } catch (err) {
      console.warn(
        `[lint:frontend] Failed to parse playwright testMatch regex: /${match[1]}/${match[2]}`
      );
    }
  }
  return patterns;
}

function lintPlaywrightCoverage() {
  const configFile = path.join(repoRoot, 'playwright.config.ts');
  const e2eRoot = path.join(repoRoot, 'tests', 'e2e');
  if (!fs.existsSync(configFile) || !fs.existsSync(e2eRoot)) return;

  let configContent = '';
  try {
    configContent = fs.readFileSync(configFile, 'utf8');
  } catch (err) {
    addSimpleViolation('playwrightTestMatch', 'playwright.config.ts', 'Unable to read Playwright config.');
    return;
  }

  const patterns = parsePlaywrightTestMatchPatterns(configContent);
  if (!patterns.length) {
    addSimpleViolation(
      'playwrightTestMatch',
      'playwright.config.ts',
      'No project testMatch patterns found; E2E suite may be silently incomplete.'
    );
    return;
  }

  const specFiles = [];
  collectSpecFiles(e2eRoot, toPosix(path.relative(repoRoot, e2eRoot)), specFiles);

  for (const file of specFiles) {
    const matched = patterns.some((pattern) => pattern.test(file.rel));
    if (!matched) {
      addSimpleViolation(
        'playwrightTestMatch',
        file.rel,
        'E2E spec is not matched by any Playwright project testMatch; rename it to a supported prefix (e.g. console.*, portal.*, a11y.*, action.*, navigation.*, logging.*, labels.*).'
      );
    }
  }
}

lintPlaywrightCoverage();

if (violations.length) {
  console.error('[lint:frontend] Violations detected:');
  for (const v of violations) {
    console.error(`- ${v.rule} ${v.relPath}:${v.line}:${v.column} ${v.detail}`);
  }
  console.error(`[lint:frontend] ${violations.length} issue(s) found.`);
  process.exit(1);
}

console.log('[lint:frontend] OK');
process.exit(0);
