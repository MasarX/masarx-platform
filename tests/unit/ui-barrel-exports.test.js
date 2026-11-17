const fs = require('fs');
const path = require('path');

function collectNamedBarrelExports(source) {
  const exports = new Map();
  const exportPattern = /^export\s+(?:type\s+)?\{\s*([^}]+?)\s*\}\s+from\s+["'][^"']+["'];/gms;

  for (const match of source.matchAll(exportPattern)) {
    const names = match[1]
      .split(',')
      .map((entry) => entry.trim())
      .filter(Boolean)
      .map((entry) => {
        const aliasMatch = entry.match(/\s+as\s+([A-Za-z_$][\w$]*)$/);
        if (aliasMatch) return aliasMatch[1];
        return entry.replace(/\s+as\s+[A-Za-z_$][\w$]*$/, '').trim();
      });

    for (const name of names) {
      const linesBefore = source.slice(0, match.index).split('\n').length;
      const lineNumbers = exports.get(name) || [];
      lineNumbers.push(linesBefore);
      exports.set(name, lineNumbers);
    }
  }

  return exports;
}

function collectNamedTypeImports(source, modulePath) {
  const imports = new Map();
  const escapedModulePath = modulePath.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const importPattern = new RegExp(
    `^import\\s+type\\s+\\{\\s*([^}]+?)\\s*\\}\\s+from\\s+["']${escapedModulePath}["'];`,
    'gms',
  );

  for (const match of source.matchAll(importPattern)) {
    const names = match[1]
      .split(',')
      .map((entry) => entry.trim())
      .filter(Boolean)
      .map((entry) => {
        const aliasMatch = entry.match(/\s+as\s+([A-Za-z_$][\w$]*)$/);
        if (aliasMatch) return aliasMatch[1];
        return entry.replace(/\s+as\s+[A-Za-z_$][\w$]*$/, '').trim();
      });

    for (const name of names) {
      const linesBefore = source.slice(0, match.index).split('\n').length;
      const lineNumbers = imports.get(name) || [];
      lineNumbers.push(linesBefore);
      imports.set(name, lineNumbers);
    }
  }

  return imports;
}

function duplicateEntries(namedEntries) {
  return Array.from(namedEntries.entries())
    .filter(([, lines]) => lines.length > 1)
    .map(([name, lines]) => `${name} at lines ${lines.join(', ')}`);
}

describe('ui package barrel exports', () => {
  test('does not export the same public symbol more than once', () => {
    const indexPath = path.join(process.cwd(), 'packages', 'ui', 'src', 'index.ts');
    const source = fs.readFileSync(indexPath, 'utf8').replace(/\r\n/g, '\n');
    const exports = collectNamedBarrelExports(source);

    expect(duplicateEntries(exports)).toEqual([]);
  });

  test('does not import the same API server type more than once', () => {
    const serverPath = path.join(process.cwd(), 'packages', 'api', 'src', 'server.ts');
    const source = fs.readFileSync(serverPath, 'utf8').replace(/\r\n/g, '\n');
    const imports = collectNamedTypeImports(source, './index');

    expect(duplicateEntries(imports)).toEqual([]);
  });
});
