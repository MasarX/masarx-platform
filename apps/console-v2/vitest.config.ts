import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';
import fs from 'node:fs';
import path from 'node:path';

const toVitePath = (value: string) => value.replace(/\\/g, '/');
const isConsoleV2Root = (candidate: string) => {
  try {
    const manifestPath = path.join(candidate, 'package.json');
    return JSON.parse(fs.readFileSync(manifestPath, 'utf8')).name === '@masarx/console-v2';
  } catch {
    return false;
  }
};
const resolveAppRoot = () => {
  const candidates = [
    process.cwd(),
    process.env.INIT_CWD ? path.join(process.env.INIT_CWD, 'apps', 'console-v2') : '',
    __dirname,
  ];
  const match = candidates.find((candidate) => candidate && isConsoleV2Root(candidate));
  return toVitePath(path.resolve(match || __dirname));
};
const appRoot = resolveAppRoot();
const realAppRoot = toVitePath(fs.realpathSync.native(appRoot));
const repoRoot = toVitePath(path.resolve(appRoot, '../..'));
const realRepoRoot = toVitePath(fs.realpathSync.native(repoRoot));
const appTestCache = toVitePath(path.resolve(appRoot, '.vitest'));
const appTestSetup = toVitePath(path.resolve(appRoot, './src/test/setup.ts'));

export default defineConfig({
  root: appRoot,
  cacheDir: appTestCache,
  plugins: [react()],
  server: {
    fs: {
      allow: Array.from(new Set([appRoot, realAppRoot, repoRoot, realRepoRoot])),
    },
  },
  resolve: {
    preserveSymlinks: true,
    alias: [
      { find: '@', replacement: path.resolve(appRoot, './src') },
      {
        find: /^@masarx\/config$/,
        replacement: path.resolve(appRoot, '../../packages/config/src/index.ts'),
      },
      {
        find: /^@masarx\/config\/(.+)$/,
        replacement: path.resolve(appRoot, '../../packages/config/src/$1'),
      },
      { find: /^@masarx\/ui$/, replacement: path.resolve(appRoot, '../../packages/ui/src/index.ts') },
      { find: /^@masarx\/ui\/label-designer\/canvas-types$/, replacement: path.resolve(appRoot, '../../packages/ui/src/label-designer/canvas/canvas-types.ts') },
      { find: /^@masarx\/ui\/(.+)$/, replacement: path.resolve(appRoot, '../../packages/ui/src/$1') },
      // Optional Sentry SDK is dynamic-imported by `lib/telemetry.ts` only when
      // `VITE_SENTRY_DSN` is set; vitest's static analysis still tries to
      // resolve the literal at transform time, so we point it at a local stub
      // so tests never depend on the real package being installed.
      { find: '@sentry/react', replacement: path.resolve(appRoot, './src/test/stubs/sentry-stub.ts') },
    ],
  },
  test: {
    environment: 'jsdom',
    globals: true,
    setupFiles: [appTestSetup],
    include: ['src/**/*.test.{ts,tsx}', 'scripts/**/*.test.mjs'],
    coverage: {
      reporter: ['text', 'lcov'],
      include: ['src/**/*.{ts,tsx}'],
      exclude: [
        'src/routeTree.gen.ts',
        'src/lib/seed-raw/**',
        'src/**/*.test.{ts,tsx}',
        'src/test/**',
      ],
    },
  },
});
