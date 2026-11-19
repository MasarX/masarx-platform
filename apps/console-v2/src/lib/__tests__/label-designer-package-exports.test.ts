import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const repoRoot = path.resolve(__dirname, '../../../../..');
const uiPackage = JSON.parse(
  readFileSync(path.join(repoRoot, 'packages/ui/package.json'), 'utf8'),
) as { exports?: Record<string, string> };
const consolePackage = JSON.parse(
  readFileSync(path.join(repoRoot, 'apps/console-v2/package.json'), 'utf8'),
) as { dependencies?: Record<string, string> };

describe('label designer package exports', () => {
  it('keeps the shared production designer modules importable through stable package subpaths', () => {
    const exportsMap = uiPackage.exports ?? {};
    const requiredExports = [
      './label-designer',
      './label-designer/canvas',
      './label-designer/canvas/label-canvas',
      './label-designer/label-canvas',
      './label-designer/canvas/canvas-layers-panel',
      './label-designer/block-catalog-sidebar',
      './label-designer/block-property-panel',
      './label-designer/draft-workflow',
      './label-designer/preview-panel',
      './label-designer/use-undo-redo',
      './label-designer/use-label-designer-data',
      './label-designer/use-label-designer-store',
      './label-designer/utils',
    ];

    for (const exportKey of requiredExports) {
      expect(exportsMap[exportKey], exportKey).toMatch(/^\.\/src\/label-designer\//);
    }
  });

  it('keeps shared label designer runtime dependencies resolvable from Console V2', () => {
    const viteConfig = readFileSync(path.join(repoRoot, 'apps/console-v2/vite.config.ts'), 'utf8');
    const vitestConfig = readFileSync(path.join(repoRoot, 'apps/console-v2/vitest.config.ts'), 'utf8');
    const tsconfig = JSON.parse(
      readFileSync(path.join(repoRoot, 'apps/console-v2/tsconfig.app.json'), 'utf8'),
    ) as { compilerOptions?: { paths?: Record<string, string[]> } };

    expect(consolePackage.dependencies?.['@masarx/config']).toBe('0.1.0');
    expect(consolePackage.dependencies?.['next-intl']).toBeDefined();
    expect(viteConfig).toContain('@masarx\\/config');
    expect(vitestConfig).toContain('@masarx\\/config');
    expect(tsconfig.compilerOptions?.paths?.['@masarx/config']).toEqual([
      '../../packages/config/src/index.ts',
    ]);
    expect(tsconfig.compilerOptions?.paths?.['@masarx/config/*']).toEqual([
      '../../packages/config/src/*',
    ]);
  });
});
