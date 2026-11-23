const { createHash } = require('node:crypto');
const { readFileSync, readdirSync } = require('node:fs');
const path = require('node:path');
const yaml = require('yaml');

const root = path.resolve(__dirname, '../../..');
const certificatePath = 'config/certs/supabase-prod-ca-2021.crt';
const certificateSha256 = '700723581420dd1ac98fd7e9ac529f0ef210eadcaf87fc868a3ad7d114c2f3b7';
const read = file => readFileSync(path.join(root, file), 'utf8');
const { jobs } = yaml.parse(read('.github/workflows/deploy.yml'));

test('workflows and scripts have no reference to the public database CA download URL', () => {
  const downloads = ['.github/workflows', 'scripts'].flatMap(dir =>
    readdirSync(path.join(root, dir), { recursive: true, withFileTypes: true })
      .filter(entry => entry.isFile() && readFileSync(path.join(entry.parentPath, entry.name), 'utf8')
        .includes('/prod/ssl/prod-ca-2021.crt'))
      .map(entry => path.relative(root, path.join(entry.parentPath, entry.name))),
  );
  expect(downloads).toEqual([]);
});

test('committed Supabase database CA matches the pinned SHA-256', () => {
  const bytes = readFileSync(path.join(root, certificatePath));
  expect(createHash('sha256').update(bytes).digest('hex')).toBe(certificateSha256);
});

function expectPinnedCertificate(source) {
  expect(source).toMatch(/^\s*ca_file="[^\n]*config\/certs\/supabase-prod-ca-2021\.crt"$/m);
  const check = source.match(/printf '([a-f0-9]{64})  %s\\n' "\$ca_file" \|\r?\n\s+sha256sum --check --status\b/);
  expect(check?.[1]).toBe(certificateSha256);
}

test.each([
  ['api-schemas', 'Read renderer JWT claims'],
  ['renderer-jwt-mint', 'Rotate the DEV renderer invoke credential'],
])('deploy %s checks out and verifies the committed database CA', (job, stepName) => {
  const { steps } = jobs[job];
  const index = steps.findIndex(step => step.name === stepName);
  expect(index).toBeGreaterThan(0);
  expect(steps.slice(0, index)).toEqual(expect.arrayContaining([expect.objectContaining({
    uses: expect.stringMatching(/^actions\/checkout@[a-f0-9]{40}$/),
    with: expect.objectContaining({ ref: '${{ github.sha }}', 'persist-credentials': false }),
  })]));
  expectPinnedCertificate(steps[index].run);
});

test.each([
  'scripts/deploy/sync-outbound-wake-endpoint.sh',
  'scripts/deploy/dev-outbound-probe.sh',
])('%s verifies the committed database CA', file => {
  expectPinnedCertificate(read(file));
});
