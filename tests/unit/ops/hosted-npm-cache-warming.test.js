const fs = require('node:fs');
const path = require('node:path');
const yaml = require('yaml');

const root = path.resolve(__dirname, '../../..');
const read = file => fs.readFileSync(path.join(root, file), 'utf8');

test('warms the hosted CI npm cache on trusted main pushes', () => {
  const warmFile = '.github/workflows/warm-ci-npm-cache.yml';
  expect(fs.existsSync(path.join(root, warmFile))).toBe(true);
  const workflow = yaml.parse(read(warmFile));
  const ci = yaml.parse(read('.github/workflows/public-ci.yml'));
  const writer = workflow.jobs.warm;
  const reader = ci.jobs.lint;
  const writerSetup = writer.steps.find(step => step.id === 'node');
  const readerSetup = reader.steps.find(step => step.uses?.startsWith('actions/setup-node@'));
  const restore = reader.steps.find(step => step.name === 'Restore npm cache');
  const install = writer.steps.find(step => step.name === 'Populate the npm cache');

  expect(workflow.on).toEqual({ push: { branches: ['main'], paths: ['package-lock.json', warmFile] } });
  expect(workflow.permissions).toEqual({ contents: 'read' });
  expect(writer['runs-on']).toBe(reader['runs-on']);
  expect(writerSetup.uses).toBe(readerSetup.uses);
  expect(read(writerSetup.with['node-version-file']).trim()).toBe(readerSetup.with['node-version']);
  expect(writerSetup.with.cache).toBe('npm');
  expect(writerSetup.with['cache-dependency-path']).toBe(readerSetup.with['cache-dependency-path']);
  expect(writerSetup.env.NPM_CONFIG_CACHE).toBe(restore.with.path);
  expect(install.env.NPM_CONFIG_CACHE).toBe(restore.with.path);
  expect(install.if).toBe("steps.node.outputs.cache-hit != 'true'");
  expect(install.run).toMatch(/^npm ci --ignore-scripts\b/);
});
