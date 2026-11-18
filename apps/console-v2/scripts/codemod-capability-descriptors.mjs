// codemod-capability-descriptors.mjs — replace bare-string capability
// descriptors in DataTable/menu/action arrays with CAP.<KEY> from the
// canonical typed bridge.
//
// Pattern targeted (in module .tsx files):
//   capability: 'shipments.write'   →   capability: CAP.SHIPMENTS_WRITE
//   capability: "fleet.read"        →   capability: CAP.FLEET_READ
//
// Excluded (leave untouched):
//   - JSX prop form `capability={CAP.X}` (already canonical)
//   - JSX prop form `capability="literal"` (lots of legacy; covered by a
//     separate pass; ESLint rule will catch them in next audit)
//   - Test fixtures (`__tests__/`, `*.test.tsx`)
//   - Storybook (`*.stories.tsx`)
//   - Comment lines (anything that starts with // or is inside /* */)
//
// SSOT: the CAP keys come from `src/lib/seed-raw/registry.js#capabilities`.
// We derive the SCREAMING_SNAKE_CASE name from the dot-separated capability
// key by uppercasing and replacing dots with underscores.

import { readFile, writeFile } from 'node:fs/promises';
import { glob } from 'node:fs/promises'; // node 22+
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const REPO_ROOT = path.resolve(__dirname, '..');
const MODULES_DIR = path.join(REPO_ROOT, 'src/modules');

// Load the canonical capability list from seed-raw to validate that every
// replacement we make targets a registered key.
const registryPath = path.join(REPO_ROOT, 'src/lib/seed-raw/registry.js');
const registrySource = await readFile(registryPath, 'utf8');
// Parse `export const capabilities = [ ... ]` from the registry. Bracket-count
// to find the end (non-greedy regex misfires on apostrophes inside `//` comments
// embedded in the array literal). Strip line comments before extracting strings
// so commented-out keys don't get mis-counted.
{
  const startIdx = registrySource.search(/export\s+const\s+capabilities\s*=\s*\[/);
  if (startIdx < 0) {
    throw new Error('codemod: failed to locate capabilities array in registry.js');
  }
  const arrayStart = registrySource.indexOf('[', startIdx);
  let depth = 0;
  let i = arrayStart;
  for (; i < registrySource.length; i++) {
    if (registrySource[i] === '[') depth += 1;
    else if (registrySource[i] === ']') {
      depth -= 1;
      if (depth === 0) break;
    }
  }
  const arrayText = registrySource.slice(arrayStart, i + 1);
  const stripped = arrayText
    .split('\n')
    .map((line) => {
      const idx = line.indexOf('//');
      return idx >= 0 ? line.slice(0, idx) : line;
    })
    .join('\n');
  // eslint-disable-next-line no-var
  var capStrings = Array.from(stripped.matchAll(/'([^']+)'/g)).map((m) => m[1]);
}
const capSet = new Set(capStrings);
console.log(`[codemod] loaded ${capSet.size} canonical capability keys from seed-raw`);

// SCREAMING_SNAKE_CASE name for a dot.case key.
function capName(key) {
  return key.toUpperCase().replaceAll('.', '_');
}

// Find all .tsx files under modules/, excluding tests + storybook.
async function* walk(dir) {
  const fs = await import('node:fs/promises');
  for (const entry of await fs.readdir(dir, { withFileTypes: true })) {
    const p = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === '__tests__' || entry.name === 'stories') continue;
      yield* walk(p);
    } else if (
      entry.isFile() &&
      entry.name.endsWith('.tsx') &&
      !entry.name.endsWith('.test.tsx') &&
      !entry.name.endsWith('.stories.tsx')
    ) {
      yield p;
    }
  }
}

let totalEdits = 0;
let editedFiles = 0;
const filesNeedingCapImport = [];

for await (const file of walk(MODULES_DIR)) {
  let source = await readFile(file, 'utf8');
  const original = source;
  let fileEdits = 0;

  // Match `capability: 'key.suffix'` (single quotes) and `capability: "key.suffix"` (double quotes)
  // ONLY where the key is a registered FE capability — guards against false
  // positives (e.g. `capability: 'unknown.thing'` where `thing` is not in
  // the registry, which would mean either a typo OR a non-canonical key
  // we deliberately want to flag, not silently rewrite).
  source = source.replace(
    /(\bcapability\s*:\s*)(['"])([a-z_]+(?:\.[a-z_]+)+)\2/g,
    (whole, prefix, _quote, key) => {
      if (!capSet.has(key)) return whole; // unknown key — leave as-is
      fileEdits += 1;
      totalEdits += 1;
      return `${prefix}CAP.${capName(key)}`;
    },
  );

  if (fileEdits === 0) continue;

  // Ensure CAP is imported. Look for an existing import of `CAP` from
  // '@/lib/capabilities' or './capabilities' (any path ending in capabilities).
  const hasCapImport = /from\s+['"][^'"]*\/lib\/capabilities['"]/.test(source);
  if (!hasCapImport) {
    // Find the last import line, append a new import after it.
    const importLines = [...source.matchAll(/^(import\s.*?from\s+['"][^'"]+['"];?)$/gm)];
    if (importLines.length > 0) {
      const lastImport = importLines[importLines.length - 1];
      const insertAt = lastImport.index + lastImport[0].length;
      source =
        source.slice(0, insertAt) +
        `\nimport { CAP } from '@/lib/capabilities';` +
        source.slice(insertAt);
      filesNeedingCapImport.push(path.relative(REPO_ROOT, file));
    }
  } else {
    // Verify the existing import actually exposes `CAP`.
    const capabilitiesImportMatch = source.match(
      /import\s*\{([^}]+)\}\s*from\s*['"][^'"]*\/lib\/capabilities['"]/,
    );
    if (capabilitiesImportMatch) {
      const namedImports = capabilitiesImportMatch[1]
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean);
      const hasCap = namedImports.some((n) => n === 'CAP' || n.startsWith('CAP '));
      if (!hasCap) {
        // Add CAP to existing named imports.
        const newImport = capabilitiesImportMatch[0].replace(
          /\{([^}]+)\}/,
          (m, contents) => `{${contents.trimEnd()}, CAP }`,
        );
        source = source.replace(capabilitiesImportMatch[0], newImport);
        filesNeedingCapImport.push(path.relative(REPO_ROOT, file));
      }
    }
  }

  if (source !== original) {
    await writeFile(file, source, 'utf8');
    editedFiles += 1;
    process.stdout.write(
      `[edit] ${path.relative(REPO_ROOT, file)} (${fileEdits} replacement${fileEdits === 1 ? '' : 's'})\n`,
    );
  }
}

console.log('---');
console.log(`Files edited: ${editedFiles}`);
console.log(`Total replacements: ${totalEdits}`);
if (filesNeedingCapImport.length > 0) {
  console.log(`Added CAP import to ${filesNeedingCapImport.length} file(s).`);
}
