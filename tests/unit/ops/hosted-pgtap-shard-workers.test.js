const fs = require('node:fs');
const path = require('node:path');
const yaml = require('yaml');

test('runs every hosted pgTAP shard with one worker', () => {
  const workflow = yaml.parse(fs.readFileSync(path.join(__dirname, '../../../.github/workflows/public-ci.yml'), 'utf8'));
  const job = workflow.jobs['database-pgtap'];

  expect(job.env.PGTAP_WORKERS).toBe('1');
});
