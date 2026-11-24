// The Typecheck job covers Console V2, which is a Vite app and has no Next typegen step (#429).
const fs = require('node:fs');
const path = require('node:path');
const yaml = require('yaml');

const root = path.resolve(__dirname, '../../..');
const workflow = yaml.parse(fs.readFileSync(path.join(root, '.github/workflows/public-ci.yml'), 'utf8'));
const tasks = fs.readFileSync(path.join(root, 'scripts/ci-hosted/tasks.cjs'), 'utf8');

describe('Console V2 typecheck in CI', () => {
  test('the Typecheck job runs the Console V2 subject', () => {
    expect(workflow.jobs.typecheck.steps.at(-1).run).toContain('node scripts/ci-hosted/tasks.cjs typecheck apps/console-v2 || result=$?');
  });

  test('tasks.cjs generates the route tree, then runs the Console V2 tsc script', () => {
    expect(tasks).toContain("if (subject === 'apps/console-v2') {");
    expect(tasks).toContain("await new Generator({ config: getConfig({}, appRoot), root: appRoot }).run();");
    expect(tasks).toContain("return npmScript('typecheck', subject);");
    const manifest = JSON.parse(fs.readFileSync(path.join(root, 'apps/console-v2/package.json'), 'utf8'));
    expect(manifest.scripts.typecheck).toBe('tsc -b --noEmit');
  });
});
