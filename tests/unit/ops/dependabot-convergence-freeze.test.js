const fs = require('fs');
const path = require('path');
const yaml = require('js-yaml');

const config = yaml.load(fs.readFileSync(
  path.join(__dirname, '..', '..', '..', '.github', 'dependabot.yml'),
  'utf8',
));

describe('Dependabot update limits', () => {
  test('caps update pull requests for every configured ecosystem', () => {
    expect(Array.isArray(config.updates)).toBe(true);
    expect(config.updates.length).toBeGreaterThan(0);
    for (const update of config.updates) {
      expect(Number.isInteger(update['open-pull-requests-limit'])).toBe(true);
      expect(update['open-pull-requests-limit']).toBeGreaterThanOrEqual(1);
      expect(update['open-pull-requests-limit']).toBeLessThanOrEqual(2);
    }
  });

  test('never auto-rebases update pull requests', () => {
    for (const update of config.updates) {
      expect(update['rebase-strategy']).toBe('disabled');
    }
  });

  test('keeps major updates in their own groups', () => {
    for (const update of config.updates) {
      const groups = Object.values(update.groups || {});
      expect(groups.length).toBeGreaterThan(0);
      const majors = groups.filter(group => (group['update-types'] || []).includes('major'));
      expect(majors.length).toBe(1);
      expect(majors[0]['update-types']).toEqual(['major']);
    }
  });

  test('covers the deploy tooling manifest', () => {
    const deploy = config.updates.find(update => update.directory === '/tooling/apps/deploy');
    expect(deploy).toBeDefined();
    expect(deploy['package-ecosystem']).toBe('npm');
  });
});
