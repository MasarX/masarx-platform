const fs = require('node:fs');
const path = require('node:path');
const { PGTAP_SHARD_COUNT } = require('../../../scripts/ci-hosted/database-result.cjs');
const { shardFiles } = require('../../../scripts/ci-hosted/pgtap.cjs');
const { seconds } = require('../../../scripts/ci-hosted/pgtap-timings.json');

test('allocates less work to the hosted serial shard and covers every SQL file once', () => {
  const inventory = fs.readdirSync(path.join(__dirname, '../../../supabase/tests/pgtap'))
    .filter(file => /\.sql$/i.test(file)).sort();
  const plan = (files, hosted) => Array.from({ length: PGTAP_SHARD_COUNT }, (_, index) =>
    shardFiles(files, `${index + 1}/${PGTAP_SHARD_COUNT}`, { hosted }));
  const measure = files => files.reduce((total, file) => total + (seconds[file] ?? 0), 0);
  const hosted = plan(inventory, true);

  expect(hosted.flat().sort()).toEqual(inventory);
  expect(hosted).toEqual(plan([...inventory].reverse(), true));
  expect(measure(hosted[0])).toBeLessThan(measure(plan(inventory, false)[0]) * 0.8);
});
