const { migrationDiff, orderViolations } = require('../../../scripts/ci-hosted/migrations.cjs');

const directory = 'supabase/migrations/';
const base = 'a'.repeat(40);
const latestStamp = '20260102000000';
const latest = `${directory}${latestStamp}_latest.sql`;
const newer = `${directory}20260103000000_next.sql`;
const equal = `${directory}${latestStamp}_same_stamp.sql`;
const older = `${directory}20260101000000_old.sql`;

function fixture(changes, baseFiles = [latest, `${directory}archive/20990101000000_future.sql`]) {
  const read = jest.fn()
    .mockReturnValueOnce([...baseFiles, ''].join('\0'))
    .mockReturnValueOnce([...changes.flat(), ''].join('\0'));
  const delta = migrationDiff(base, read);
  return { ...delta, read, messages: orderViolations(delta.baseFiles, delta.changes) };
}

function violation(file) {
  return `Migration order violation for ${file}. Base latest is ${latest}. To fix it, re-stamp after ${latestStamp}.`;
}

test('accepts an addition after the latest active stamp', () => {
  expect(fixture([['A', newer]]).messages).toEqual([]);
});

test.each([['equal to', equal], ['before', older]])('rejects an addition %s the latest stamp', (_, file) => {
  expect(fixture([['A', file]]).messages).toEqual([violation(file)]);
});

test('treats an older rename destination as an addition', () => {
  const { read, messages } = fixture([['D', latest], ['A', older]]);
  expect(read).toHaveBeenNthCalledWith(2, ['diff', '--no-renames', '--name-status', '-z', base, 'HEAD', '--', directory]);
  expect(messages).toEqual([violation(older)]);
});

test('ignores a modified migration for ordering', () => {
  expect(fixture([['M', latest]]).messages).toEqual([]);
});

test('ignores changes under archive', () => {
  const archived = `${directory}archive/fixtures/20260101000000_old.sql`;
  const { changes, messages } = fixture([['A', archived], ['M', archived]]);
  expect(changes).toEqual([]);
  expect(messages).toEqual([]);
});

test('names only the out-of-order addition in a mixed diff', () => {
  expect(fixture([['A', older], ['A', newer]]).messages).toEqual([violation(older)]);
});

test('selects the base migration by stamp when base stamps have different lengths', () => {
  const shorter = `${directory}20260102_shorter.sql`;
  expect(fixture([['A', older]], [shorter, latest]).messages).toEqual([violation(older)]);
});
