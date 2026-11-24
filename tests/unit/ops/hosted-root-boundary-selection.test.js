const { changedPaths, select } = require('../../../scripts/ci-hosted/changes.cjs');

test.each(['AGENTS.md', 'DELIVERY.md', 'DESIGN.md', 'CLAUDE.md'])(
  'selects Unit Jest for a pull request that changes only %s',
  file => {
    const files = changedPaths('0'.repeat(40), () => Buffer.from(`${file}\0`));
    const enabled = Object.entries(select(files)).filter(([, selected]) => selected).map(([job]) => job);
    expect(enabled).toEqual(['unit']);
  },
);

test('keeps ordinary root documentation outside the Unit Jest lane', () => {
  expect(select(['README.md']).unit).toBe(false);
});
