const { defaultSteps, parseSteps } = require('../../../scripts/ops/ci/reviewer-gate');
const { parseCommands } = require('../../../scripts/ops/ci/reviewer-autofix');

describe('reviewer gate scripts', () => {
  test('default reviewer gate steps are stable', () => {
    expect(defaultSteps()).toEqual([
      'npm run lint:structure',
      'npm run test:unit',
    ]);
  });

  test('parseSteps handles newline-delimited commands', () => {
    expect(parseSteps('npm run lint:plans\n\nnpm run test:unit')).toEqual([
      'npm run lint:plans',
      'npm run test:unit',
    ]);
  });

  test('parseCommands handles empty and populated values', () => {
    expect(parseCommands('')).toEqual([]);
    expect(parseCommands('npm run lint:plans\nnpm run lint:objectives')).toEqual([
      'npm run lint:plans',
      'npm run lint:objectives',
    ]);
  });
});
