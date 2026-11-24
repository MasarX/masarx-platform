const fs = require('node:fs');
const path = require('node:path');
const { runInNewContext } = require('node:vm');
const yaml = require('yaml');

test('runs hosted pgTAP shard 1 serially and preserves worker settings for other shards', () => {
  const workflow = yaml.parse(fs.readFileSync(path.join(__dirname, '../../../.github/workflows/public-ci.yml'), 'utf8'));
  const job = workflow.jobs['database-pgtap'];
  const expression = job.env.PGTAP_WORKERS.slice(3, -2);

  for (const shard of job.strategy.matrix.shard) {
    for (const workers of ['', '4']) {
      const context = { matrix: { shard }, vars: { PGTAP_WORKERS: workers } };
      expect(runInNewContext(expression, context, { timeout: 1000 }))
        .toBe(shard === 1 ? '1' : workers || 'nproc');
    }
  }
});
