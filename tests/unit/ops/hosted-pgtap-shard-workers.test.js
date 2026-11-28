const fs = require('node:fs');
const path = require('node:path');
const yaml = require('yaml');

test('runs all six hosted pgTAP shards with one worker', () => {
  const workflow = yaml.parse(fs.readFileSync(path.join(__dirname, '../../../.github/workflows/public-ci.yml'), 'utf8'));
  const job = workflow.jobs['database-pgtap'];

  expect(job.strategy.matrix.shard).toEqual([1, 2, 3, 4, 5, 6]);
  expect(job.env.PGTAP_WORKERS).toBe('1');
});
