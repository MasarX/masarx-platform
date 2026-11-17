const fs = require('fs');
const path = require('path');
const yaml = require('js-yaml');

describe('Dependabot convergence freeze', () => {
  test('prevents every configured ecosystem from creating update branches', () => {
    const config = yaml.load(fs.readFileSync(
      path.join(__dirname, '..', '..', '..', '.github', 'dependabot.yml'),
      'utf8',
    ));

    expect(Array.isArray(config.updates)).toBe(true);
    expect(config.updates.length).toBeGreaterThan(0);
    for (const update of config.updates) {
      expect(update['open-pull-requests-limit']).toBe(0);
    }
  });
});
