const path = require('path');
const { execFileSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..', '..', '..');
const REQUIRE_RULE = '@typescript-eslint/no-require-imports';
const PATHS = [
  ['apps/console/app/lint-probe.js', true],
  ['apps/portal/app/lint-probe.ts', true],
  ['apps/fieldops/src/lint-probe.tsx', true],
  ['apps/shared/lint-probe.js', true],
  ['scripts/ops/lint-probe.js', false],
  ['tests/unit/ops/lint-probe.test.js', false],
  ['packages/api/src/lint-probe.ts', false],
];

describe('frontend import lint scope', () => {
  let observed;

  beforeAll(() => {
    const script = `
      import { ESLint } from 'eslint';
      const eslint = new ESLint({ cwd: process.cwd() });
      const observations = {};
      for (const [filePath] of ${JSON.stringify(PATHS)}) {
        const config = await eslint.calculateConfigForFile(filePath);
        const [result] = await eslint.lintText(
          "const value = require('node:path'); value.resolve('a');",
          { filePath },
        );
        observations[filePath] = {
          severity: config.rules[${JSON.stringify(REQUIRE_RULE)}][0],
          importErrors: result.messages.filter(message => message.ruleId === ${JSON.stringify(REQUIRE_RULE)}).length,
          explicitAnySeverity: config.rules['@typescript-eslint/no-explicit-any'][0],
        };
      }
      console.log(JSON.stringify(observations));
    `;
    observed = JSON.parse(execFileSync(process.execPath, ['--input-type=module', '-e', script], {
      cwd: ROOT,
      encoding: 'utf8',
      timeout: 30000,
    }));
  }, 35000);

  test.each(PATHS)('%s enforces frontend import policy only when in an app', (filePath, frontend) => {
    expect(observed[filePath]).toEqual({
      severity: frontend ? 2 : 0,
      importErrors: frontend ? 1 : 0,
      explicitAnySeverity: 2,
    });
  });
});
