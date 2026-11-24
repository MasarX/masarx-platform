const fs = require('node:fs');
const path = require('node:path');
const yaml = require('js-yaml');

test('limits grouped root npm major updates to named packages', () => {
  const config = yaml.load(fs.readFileSync(path.join(__dirname, '../../../.github/dependabot.yml'), 'utf8'));
  const root = config.updates.find(update => update['package-ecosystem'] === 'npm' && update.directory === '/');
  const major = Object.values(root.groups).find(group => group['update-types'].includes('major'));

  expect(major.patterns.length).toBeGreaterThan(0);
  for (const pattern of major.patterns) expect(pattern).not.toContain('*');
});
