import { describe, expect, it } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const srcRoot = path.resolve(here, '..', '..');

function sourceFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) return sourceFiles(fullPath);
    if (!/\.(ts|tsx)$/.test(entry.name)) return [];
    if (entry.name.includes('.test.')) return [];
    if (entry.name === 'routeTree.gen.ts') return [];
    return [fullPath];
  });
}

describe('Console V2 navigation contract', () => {
  it('keeps production navigation on clean router paths instead of hash routes', () => {
    const allowedHashFallbacks = new Set([
      path.normalize(path.join(srcRoot, 'lib', 'legacy-hash-navigation.ts')),
    ]);

    const violations = sourceFiles(srcRoot).flatMap((file) => {
      if (allowedHashFallbacks.has(path.normalize(file))) return [];
      const src = readFileSync(file, 'utf8');
      const lines = src.split(/\r?\n/);
      return lines.flatMap((line, index) => {
        const hasHashRoute = /[`'"]#\//.test(line) || /href=\{?["'`]#\//.test(line);
        const writesHash = /window\.location\.hash\s*=/.test(line);
        return hasHashRoute || writesHash
          ? [`${path.relative(srcRoot, file)}:${index + 1}:${line.trim()}`]
          : [];
      });
    });

    expect(violations).toEqual([]);
  }, 20000);
});
