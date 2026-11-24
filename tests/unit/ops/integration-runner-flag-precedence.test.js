const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

test('integration runner preserves caller flags through the runner and child environment loads', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'integration-runner-flags-'));
  const write = (relative, contents) => {
    const file = path.join(root, relative);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, contents);
    return file;
  };

  try {
    const runner = write('scripts/tests/run-integration-cloud.js', fs.readFileSync(
      path.resolve(__dirname, '../../../scripts/tests/run-integration-cloud.js'),
    ));
    const loadEnv = JSON.stringify(require.resolve('../../../scripts/utils/load-env'));
    write('scripts/utils/load-env.js', `module.exports = require(${loadEnv});`);
    write('scripts/edge/sync-shared.js', '');
    write('scripts/edge/verify-shared.js', '');
    const probe = `
      require(${loadEnv}).loadEnv();
      const { RUN_FIXTURE_EXPLICIT, RUN_FIXTURE_DEFAULT, FIXTURE_SETTING, ENV_FILE_OVERRIDE } = process.env;
      console.log('probe:' + JSON.stringify([RUN_FIXTURE_EXPLICIT, RUN_FIXTURE_DEFAULT, FIXTURE_SETTING, ENV_FILE_OVERRIDE]));
    `;
    write('scripts/tests/bootstrap/seed-integration-fixtures.js', probe);
    write('node_modules/jest/bin/jest.js', probe);
    write('flags.env', 'RUN_FIXTURE_EXPLICIT=true\nRUN_FIXTURE_DEFAULT=true\nFIXTURE_SETTING=file\n');

    const output = execFileSync(process.execPath, [runner], {
      cwd: root,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      env: {
        SystemRoot: process.env.SystemRoot,
        NODE_PATH: process.env.NODE_PATH,
        ENV_FILE: 'flags.env',
        ENV_FILE_OVERRIDE: '1',
        INTEGRATION_JEST_RETRY_COUNT: '0',
        RUN_FIXTURE_EXPLICIT: 'false',
        FIXTURE_SETTING: 'caller',
      },
    });
    const childValues = output.split(/\r?\n/).filter((line) => line.startsWith('probe:'))
      .map((line) => JSON.parse(line.slice('probe:'.length)));
    const expected = ['false', 'true', 'file', '0'];
    expect(childValues).toEqual([expected, expected]);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
