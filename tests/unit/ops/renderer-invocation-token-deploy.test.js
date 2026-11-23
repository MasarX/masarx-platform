const fs = require('node:fs');
const path = require('node:path');
const yaml = require('yaml');

const root = path.resolve(__dirname, '../../..');

function readSources(dir) {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap(entry => {
    const file = path.join(dir, entry.name);
    return entry.isDirectory() ? readSources(file) : [file];
  });
}

test('deploy workflows and scripts cannot mint or store the retired renderer invocation JWT', () => {
  const files = ['.github/workflows', '.github/actions', 'scripts/deploy']
    .map(dir => path.join(root, dir))
    .filter(dir => fs.existsSync(dir))
    .flatMap(readSources);
  const deploy = path.join(root, '.github/workflows/deploy.yml');
  expect(files).toContain(deploy);

  const invocationMint = /renderer[-_]jwt[-_]mint|renderer_mint_failed|Rotate the DEV renderer invoke credential|RENDERER_(?:EXP|IAT|TOKEN_FILE)|renderer\.jwt\b/i;
  const invocationWrite = /\bvault\s*\.\s*(?:create_secret|update_secret)\b|\bupsert_label_provider_settings_v1\b|\\bind\s+:renderer_jwt\b/i;
  for (const file of files) {
    const source = fs.readFileSync(file, 'utf8');
    expect(source).not.toMatch(invocationMint);
    expect(source).not.toMatch(invocationWrite);
  }

  const workflow = yaml.parse(fs.readFileSync(deploy, 'utf8'));
  expect(workflow.jobs['api-schemas'].steps.find(step => step.name === 'Read renderer JWT claims').run)
    .toMatch(/BEGIN TRANSACTION READ ONLY;[\s\S]+public\.resolve_label_renderer_invoke_config_v1/);
});
