import { defineConfig, loadEnv } from 'vite';
import react from '@vitejs/plugin-react';
import { TanStackRouterVite } from '@tanstack/router-vite-plugin';
import { visualizer } from 'rollup-plugin-visualizer';
import { readFileSync } from 'node:fs';
import path from 'node:path';

import { resolveDevServerAllowedHosts } from './dev-server-allowed-hosts';

function consoleRuntimeChunk(id: string): string | undefined {
  if (id.includes('/node_modules/@tanstack/')) return 'tanstack';
  if (id.includes('/node_modules/react/')) return 'react';

  // The SDK publishes independent clients. Keep each client's runtime together
  // and keep the auth client separate from its protocol and storage helpers.
  const supabasePackage = id.match(/\/node_modules\/@supabase\/([^/]+)\//)?.[1];
  if (supabasePackage) {
    if (id.endsWith('/auth-js/dist/module/GoTrueClient.js')) return 'supabase-auth-client';
    return `supabase-${supabasePackage}`;
  }

  const sharedRuntime = id.match(/\/src\/lib\/(data-source|api|queries|i18n)\.tsx?$/)?.[1];
  return sharedRuntime ? `console-${sharedRuntime}` : undefined;
}

// Phase F (lazy seed). The seed catalog under src/lib/seed-raw/ is only
// consumed in seed/demo mode; production builds (`VITE_USE_SEED=false`) must
// tree-shake it entirely. Vite's standard `import.meta.env.VITE_USE_SEED`
// replacement is a string ('true' | 'false'); we additionally inject a true
// boolean compile-time constant `__SEED_ENABLED__` so Rollup can see a
// literal `if (false) { ... }` branch around the seed dynamic import in
// `src/lib/seed-loader.ts` and dead-code-eliminate it cleanly.
export default defineConfig(({ mode }) => {
  const npmPackageJson = process.env.npm_package_json;
  const logicalPackageRoot =
    npmPackageJson && path.basename(path.dirname(npmPackageJson)) === 'console-v2'
      ? path.dirname(npmPackageJson)
      : undefined;
  const cacheRoot = logicalPackageRoot ?? __dirname;
  const env = loadEnv(mode, __dirname, '');
  const analyze = env.ANALYZE === '1' || process.env.ANALYZE === '1';
  const seedMode = process.env.VITE_USE_SEED ?? env.VITE_USE_SEED;
  const seedEnabled = seedMode !== 'false';
  // Console V2 uses the shared UI for label design. All other screens use its own catalogs.
  const sharedUiMessages = Object.fromEntries(['en', 'ar'].map((locale) => {
    const catalogPath = path.resolve(__dirname, '../../packages/config/messages', `${locale}.json`);
    const { ui } = JSON.parse(readFileSync(catalogPath, 'utf8'));
    if (!ui?.labelDesigner) throw new Error(`Missing labelDesigner messages in ${locale}`);
    return [locale, { ui: { labelDesigner: ui.labelDesigner } }];
  }));

  return {
    root: __dirname,
    cacheDir: path.join(cacheRoot, 'node_modules/.vite'),
    plugins: [
      TanStackRouterVite({
        routesDirectory: './src/routes',
        generatedRouteTree: './src/routeTree.gen.ts',
        autoCodeSplitting: true,
      }),
      react(),
      ...(analyze
        ? [
            visualizer({
              filename: 'dist/bundle-stats.html',
              gzipSize: true,
              brotliSize: true,
              template: 'treemap',
              open: false,
            }),
          ]
        : []),
    ],
    // Compile-time literal injected into the build. Rollup folds
    // `if (__SEED_ENABLED__)` into `if (true)` / `if (false)` and removes the
    // unreachable branch (including the `await import('./seed-raw/seed.js')`).
    // Stringified per Vite's define contract.
    define: {
      __SEED_ENABLED__: JSON.stringify(seedEnabled),
      __UI_MESSAGE_CATALOGS__: JSON.stringify(JSON.stringify(sharedUiMessages)),
    },
    resolve: {
      alias: [
        { find: '@', replacement: path.resolve(__dirname, './src') },
        {
          find: /^@masarx\/config$/,
          replacement: path.resolve(__dirname, '../../packages/config/src/index.ts'),
        },
        {
          find: /^@masarx\/config\/(.+)$/,
          replacement: path.resolve(__dirname, '../../packages/config/src/$1'),
        },
        { find: /^@masarx\/ui$/, replacement: path.resolve(__dirname, '../../packages/ui/src/index.ts') },
        { find: /^@masarx\/ui\/label-designer\/canvas-types$/, replacement: path.resolve(__dirname, '../../packages/ui/src/label-designer/canvas/canvas-types.ts') },
        { find: /^@masarx\/ui\/(.+)$/, replacement: path.resolve(__dirname, '../../packages/ui/src/$1') },
      ],
    },
    server: {
      port: 5175,
      strictPort: true,
      allowedHosts: resolveDevServerAllowedHosts(),
    },
    build: {
      target: 'es2022',
      sourcemap: true,
      minify: 'terser',
      terserOptions: { compress: { passes: 2 } },
      rollupOptions: {
        // @sentry/react is an opt-in runtime dep: it's only dynamically imported when
        // VITE_SENTRY_DSN is set, and is intentionally NOT in package.json. Externalise so
        // Rollup does not fail trying to resolve the dynamic import; if a deployment opts
        // into Sentry it must install the package and provide the DSN.
        external: ['@sentry/react'],
        output: {
          onlyExplicitManualChunks: true,
          manualChunks: consoleRuntimeChunk,
        },
      },
    },
  };
});
