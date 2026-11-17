import { defineConfig, globalIgnores } from 'eslint/config';
import nextVitals from 'eslint-config-next/core-web-vitals';
import nextTypescript from 'eslint-config-next/typescript';

export default defineConfig([
  ...nextVitals,
  ...nextTypescript,
  {
    files: ['apps/**/*.{js,jsx,ts,tsx}'],
    settings: {
      next: {
        rootDir: ['apps/console/', 'apps/portal/'],
      },
    },
  },
  globalIgnores([
    '**/node_modules/**',
    '**/.next/**',
    '**/coverage/**',
    '**/dist/**',
    '**/build/**',
    '**/out/**',
    '**/next-env.d.ts',
    'apps/*/next.config.js',
    'apps/*/tailwind.config.js',
    'apps/*/postcss.config.js',
  ]),
]);
