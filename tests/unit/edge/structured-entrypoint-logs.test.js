const { readFileSync } = require('node:fs');
const { resolve } = require('node:path');

test.each(['api-caller', 'label-renderer'])('routes %s entry-point logs through the shared logger', (name) => {
  const entrypoint = resolve(__dirname, '../../../supabase/functions', name, 'index.ts');
  const source = readFileSync(entrypoint, 'utf8');

  expect(source).not.toMatch(/\bconsole\s*\./);
  expect(source).toMatch(/\blogStructured\s*\(/);
});
