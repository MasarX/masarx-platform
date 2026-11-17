/* eslint-disable @typescript-eslint/no-require-imports -- isolates the actual helper without loading browser dependencies */
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const ts = require('typescript');
const en = require('../../../packages/config/messages/en.json');
const ar = require('../../../packages/config/messages/ar.json');

const source = fs.readFileSync(path.resolve(__dirname, '../../e2e/utils/automation-marketplace.ts'), 'utf8');
const compiled = ts.transpileModule(source, {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true },
}).outputText;
const unusedImports = new Set(['fs', 'path', '@playwright/test', './workflow-studio', './mutations', './mutation-manifest']);

function marketplaceText(locale) {
  const context = {
    exports: {},
    process: { env: locale === undefined ? {} : { NEXT_PUBLIC_LOCALE: locale } },
    require: name => {
      if (name === '../../../packages/config/messages/en.json') return en;
      if (name === '../../../packages/config/messages/ar.json') return ar;
      if (unusedImports.has(name)) return {};
      throw new Error(`Unexpected import: ${name}`);
    },
  };
  vm.runInNewContext(compiled, context);
  return context.exports.marketplaceText;
}

test.each([undefined, '', 'en'])('uses the complete English catalog for locale=%s', locale => {
  expect(marketplaceText(locale)).toBe(en.ui.automationMarketplace);
});

test('uses the complete Arabic catalog for locale=ar', () => {
  expect(marketplaceText('ar')).toBe(ar.ui.automationMarketplace);
});

test.each(['fr', 'AR', 'en-US'])('rejects unsupported locale=%s', locale => {
  expect(() => marketplaceText(locale)).toThrow('Marketplace E2E locale must be en or ar.');
});
