import { createRequire } from 'node:module';
import { defineConfig, globalIgnores } from 'eslint/config';
import nextVitals from 'eslint-config-next/core-web-vitals';
import nextTypescript from 'eslint-config-next/typescript';

const require = createRequire(import.meta.url);
const fieldopsPlugin = require('./config/tooling/eslint-plugin-fieldops');
const fieldopsLintConfig = require('./config/tooling/eslint.fieldops.js');

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
  ...fieldopsLintConfig({ plugin: fieldopsPlugin }),
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
