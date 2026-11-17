const fs = require('fs');
const path = require('path');
const yaml = require('js-yaml');

describe('Dependabot update limits', () => {
  test('caps update pull requests for every configured ecosystem', () => {
    const config = yaml.load(fs.readFileSync(
      path.join(__dirname, '..', '..', '..', '.github', 'dependabot.yml'),
      'utf8',
    ));

    expect(Array.isArray(config.updates)).toBe(true);
    expect(config.updates.length).toBeGreaterThan(0);
    for (const update of config.updates) {
      expect(update['open-pull-requests-limit']).toBe(5);
    }
  });
});
