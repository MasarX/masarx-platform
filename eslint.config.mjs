import { defineConfig, globalIgnores } from 'eslint/config';
import nextVitals from 'eslint-config-next/core-web-vitals';
import nextTypescript from 'eslint-config-next/typescript';

export default defineConfig([
  ...nextVitals,
  ...nextTypescript,
  {
    rules: {
      '@typescript-eslint/no-require-imports': 'off',
    },
  },
  {
    files: ['apps/**/*.{js,jsx,ts,tsx}'],
    rules: {
      '@typescript-eslint/no-require-imports': 'error',
    },
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
    'supabase/functions/resource-import-studio/_vendor/exceljs*',
    'apps/*/next.config.js',
    'apps/*/tailwind.config.js',
    'apps/*/postcss.config.js',
  ]),
]);
