const { execFileSync } = require('node:child_process');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

test('Console V2 pickup windows round-trip local time and reject skipped clock times', () => {
  const helpers = pathToFileURL(path.resolve(__dirname, '../../../apps/console-v2/src/lib/date-input.ts'));
  const script = `
    import { localDateTimeInputToUtc, toDateTimeInputValue } from ${JSON.stringify(helpers.href)};
    const local = toDateTimeInputValue(new Date('2026-04-25T14:00:00Z'));
    console.log(JSON.stringify({
      local,
      utc: localDateTimeInputToUtc(local),
      skipped: localDateTimeInputToUtc('2026-03-08T02:30'),
      missing: localDateTimeInputToUtc(''),
    }));
  `;

  const output = execFileSync(process.execPath, ['--input-type=module', '-e', script], {
    env: { ...process.env, TZ: 'America/New_York' },
    encoding: 'utf8',
  });

  expect(JSON.parse(output)).toEqual({
    local: '2026-04-25T10:00',
    utc: '2026-04-25T14:00:00.000Z',
    skipped: null,
    missing: null,
  });
});
