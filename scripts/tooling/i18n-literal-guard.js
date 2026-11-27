/* eslint-disable no-console */
// Finds English UI text written as literals instead of catalog lookups.
// Files that still hold literals are listed in the baseline with their count.
// The baseline may only shrink: a new file with literals, or a higher count, fails.
const fs = require('fs');
const path = require('path');
const ts = require('typescript');

const repoRoot = path.join(__dirname, '..', '..');
const baselineDir = path.join(__dirname, 'i18n-literal-baseline');

const SCAN_ROOTS = [
  'apps/console-v2/src',
  'packages/ui/src',
  'apps/fieldops/App.tsx',
  'apps/fieldops/src',
  'apps/console/app',
  'apps/portal/app',
  'apps/shared',
];
const SKIP_DIRS = new Set(['node_modules', '.next', 'dist', 'build', '__tests__', '__mocks__', 'test', 'tests', 'i18n', 'seed-raw', 'msw', 'stubs']);
const SKIP_FILE = /\.(?:test|spec|stories|d)\.tsx?$|\.(?:test|spec)\.[cm]?js$/;
const SOURCE_FILE = /\.tsx?$/;
// Marks a deliberate literal, such as a brand name: put it on the same line.
const ALLOW_MARKER = 'i18n-literal-ok';

// JSX attributes and object properties whose value is shown or read to the user.
// The word ends the name: `title`, `aria-label`, `emptyText` or `confirmLabel`.
const TEXT_NAME = /(^|[-_]|[a-z0-9])(label|title|placeholder|text|description|message|hint|caption|heading|tooltip|eyebrow|subtitle|summary|helper|alt|header)$/i;
// Calls whose string arguments reach the user.
const TOAST_CALL = /^(?:toast|pushToast|showToast|addToast|notify|alert|confirm)$/;
const ERROR_SETTER = /^set(?:[A-Z]\w*)?Error(?:Message|Text)?$/;

const LETTERS = /[A-Za-z]{2,}/;
// Property and argument values: prose starts with a capital or holds a space.
// Lowercase single words are usually codes, tones or keys.
const PROSE = /^\s*[A-Z][a-z]|[A-Za-z]{2,}\s+[A-Za-z]/;

function textOfLiteral(node) {
  if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) return node.text;
  if (ts.isTemplateExpression(node)) return [node.head.text, ...node.templateSpans.map((s) => s.literal.text)].join(' ');
  return null;
}

// Literal parts of an expression, without entering calls (t('key', 'Fallback') is a lookup).
function literalParts(node, out = []) {
  if (!node) return out;
  const text = textOfLiteral(node);
  if (text !== null) {
    out.push({ node, text });
    return out;
  }
  if (ts.isParenthesizedExpression(node) || ts.isAsExpression(node) || ts.isNonNullExpression(node) || ts.isSatisfiesExpression?.(node)) {
    return literalParts(node.expression, out);
  }
  if (ts.isConditionalExpression(node)) {
    literalParts(node.whenTrue, out);
    return literalParts(node.whenFalse, out);
  }
  if (ts.isBinaryExpression(node)) {
    const op = node.operatorToken.kind;
    if (op === ts.SyntaxKind.PlusToken || op === ts.SyntaxKind.BarBarToken || op === ts.SyntaxKind.QuestionQuestionToken || op === ts.SyntaxKind.AmpersandAmpersandToken) {
      literalParts(node.left, out);
      return literalParts(node.right, out);
    }
  }
  return out;
}

function propName(name) {
  if (!name) return '';
  if (ts.isIdentifier(name) || ts.isStringLiteral(name) || ts.isPrivateIdentifier?.(name)) return name.text;
  if (ts.isJsxNamespacedName?.(name)) return `${name.namespace.text}:${name.name.text}`;
  return '';
}

function isTextName(name) {
  const match = TEXT_NAME.exec(name);
  if (!match) return false;
  // In camelCase the word must start a new part: `contentText`, not `context`.
  return !/[a-z0-9]/.test(match[1]) || /[A-Z]/.test(match[2][0]);
}

function calleeName(expr) {
  if (ts.isIdentifier(expr)) return expr.text;
  if (ts.isPropertyAccessExpression(expr)) {
    const owner = ts.isIdentifier(expr.expression) ? expr.expression.text : '';
    if (/^toast$/i.test(owner)) return 'toast';
    if (owner === 'Alert' && expr.name.text === 'alert') return 'alert';
    if (owner === 'window') return expr.name.text;
    return expr.name.text;
  }
  return '';
}

function scanSource(source, fileName = 'file.tsx') {
  const kind = fileName.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS;
  const sf = ts.createSourceFile(fileName, source, ts.ScriptTarget.Latest, true, kind);
  const lines = source.split(/\r?\n/);
  const findings = [];
  const add = (node, text, why, test) => {
    const value = text.replace(/\s+/g, ' ').trim();
    if (!test.test(value)) return;
    const line = sf.getLineAndCharacterOfPosition(node.getStart(sf)).line;
    if (lines[line] && lines[line].includes(ALLOW_MARKER)) return;
    findings.push({ line: line + 1, kind: why, text: value });
  };

  const visit = (node) => {
    if (ts.isJsxText(node)) {
      add(node, node.text, 'jsx-text', LETTERS);
    } else if (ts.isJsxExpression(node) && node.parent && (ts.isJsxElement(node.parent) || ts.isJsxFragment(node.parent))) {
      for (const part of literalParts(node.expression)) add(part.node, part.text, 'jsx-text', LETTERS);
    } else if (ts.isJsxAttribute(node)) {
      const name = propName(node.name);
      if (isTextName(name) && node.initializer) {
        const init = node.initializer;
        const parts = ts.isJsxExpression(init) ? literalParts(init.expression) : literalParts(init);
        for (const part of parts) add(part.node, part.text, 'prop', LETTERS);
      }
    } else if (ts.isPropertyAssignment(node)) {
      const name = propName(node.name);
      if (isTextName(name)) for (const part of literalParts(node.initializer)) add(part.node, part.text, 'prop', PROSE);
    } else if (ts.isCallExpression(node)) {
      const name = calleeName(node.expression);
      const args = node.arguments;
      if (TOAST_CALL.test(name)) {
        const count = name === 'alert' && ts.isPropertyAccessExpression(node.expression) ? 2 : 1;
        for (const arg of args.slice(0, count)) for (const part of literalParts(arg)) add(part.node, part.text, 'toast', PROSE);
      } else if (ERROR_SETTER.test(name) && args[0]) {
        for (const part of literalParts(args[0])) add(part.node, part.text, 'error', PROSE);
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return findings;
}

function listFiles(root = repoRoot) {
  const files = [];
  const walk = (rel) => {
    const abs = path.join(root, rel);
    let stat;
    try {
      stat = fs.lstatSync(abs);
    } catch {
      return;
    }
    if (stat.isSymbolicLink()) return;
    if (stat.isFile()) {
      if (SOURCE_FILE.test(rel) && !SKIP_FILE.test(rel)) files.push(rel.split(path.sep).join('/'));
      return;
    }
    if (!stat.isDirectory()) return;
    for (const entry of fs.readdirSync(abs)) {
      if (SKIP_DIRS.has(entry)) continue;
      walk(path.join(rel, entry));
    }
  };
  SCAN_ROOTS.forEach((r) => walk(r));
  return files.sort();
}

function scanRepo(root = repoRoot) {
  const counts = new Map();
  for (const rel of listFiles(root)) {
    const findings = scanSource(fs.readFileSync(path.join(root, rel), 'utf8'), rel);
    if (findings.length) counts.set(rel, findings);
  }
  return counts;
}

function readBaseline(dir = baselineDir) {
  const entries = new Map();
  const problems = [];
  const files = fs.existsSync(dir)
    ? fs.readdirSync(dir, { recursive: true, withFileTypes: true })
      .filter((entry) => entry.isFile() && entry.name.endsWith('.txt'))
      .map((entry) => path.join(entry.parentPath, entry.name))
      .sort()
    : [];
  for (const file of files) {
    const name = path.relative(dir, file);
    let previous = '';
    fs.readFileSync(file, 'utf8').split(/\r?\n/).forEach((line, index) => {
      if (!line.trim() || line.startsWith('#')) return;
      const match = /^(\S+) (\d+)$/.exec(line);
      if (!match) {
        problems.push(`${name}:${index + 1}: expected "<path> <count>"`);
        return;
      }
      const [, rel, count] = match;
      const expectedFile = path.join(path.dirname(rel), `literal-${path.basename(rel)}.txt`);
      if (name !== expectedFile) problems.push(`${name}:${index + 1}: expected ${expectedFile} for ${rel}`);
      if (entries.has(rel)) problems.push(`baseline lists ${rel} twice (also in ${name})`);
      if (previous && rel < previous) problems.push(`${name}: baseline is not sorted at ${rel}`);
      previous = rel;
      entries.set(rel, Number(count));
    });
  }
  return { entries, problems };
}

// Compares current literals with the baseline and returns the failures.
function check(current, baseline) {
  const failures = [...baseline.problems];
  for (const [rel, findings] of current) {
    const allowed = baseline.entries.get(rel);
    if (allowed === undefined) {
      failures.push(`${rel}: ${findings.length} new literal(s); move them to the catalogs. First: line ${findings[0].line} "${findings[0].text}"`);
    } else if (findings.length > allowed) {
      failures.push(`${rel}: ${findings.length} literals, baseline allows ${allowed}; move the new ones to the catalogs`);
    }
  }
  for (const rel of baseline.entries.keys()) {
    if (!current.has(rel)) failures.push(`${rel}: no literals left; delete its allowance file or row`);
  }
  return failures;
}

if (require.main === module) {
  const current = scanRepo();
  const only = process.argv.slice(2).filter((a) => !a.startsWith('--'));
  if (process.argv.includes('--report')) {
    for (const [rel, findings] of current) {
      if (only.length && !only.some((o) => rel.startsWith(o))) continue;
      for (const f of findings) console.log(`${rel}:${f.line} ${f.kind} ${JSON.stringify(f.text)}`);
    }
    process.exit(0);
  }
  const failures = check(current, readBaseline());
  failures.forEach((f) => console.error(f));
  console.log(failures.length ? `i18n literal guard: ${failures.length} failure(s)` : 'i18n literal guard: ok');
  process.exit(failures.length ? 1 : 0);
}

module.exports = { scanSource, listFiles, scanRepo, readBaseline, check, SCAN_ROOTS };
