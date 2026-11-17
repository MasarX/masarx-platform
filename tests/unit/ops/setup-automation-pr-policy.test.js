const { parseAuthorsCsv, uniq } = require('../../../scripts/ops/setup-automation-pr-policy');

describe('setup-automation-pr-policy', () => {
  describe('parseAuthorsCsv', () => {
    test('splits on commas and whitespace', () => {
      expect(parseAuthorsCsv('a,b  c\nd')).toEqual(['a', 'b', 'c', 'd']);
    });

    test('filters blanks', () => {
      expect(parseAuthorsCsv(' , , ')).toEqual([]);
    });
  });

  describe('uniq', () => {
    test('dedupes and trims preserving order', () => {
      expect(uniq([' a ', '', 'b', 'a', 'c', 'b'])).toEqual(['a', 'b', 'c']);
    });
  });
});

