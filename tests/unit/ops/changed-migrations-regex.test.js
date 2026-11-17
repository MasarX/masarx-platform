const {
  buildRegexPattern,
  parseFilesArgs,
} = require('../../../scripts/ops/ci/changed-migrations-regex');

describe('changed-migrations-regex', () => {
  describe('parseFilesArgs', () => {
    test('splits comma-separated lists and trims', () => {
      const out = parseFilesArgs([' a.sql, b.sql ', 'c.sql', '', '  ']);
      expect(out).toEqual(['a.sql', 'b.sql', 'c.sql']);
    });
  });

  describe('buildRegexPattern', () => {
    test('returns empty string when there are no files', () => {
      expect(buildRegexPattern([])).toBe('');
      expect(buildRegexPattern(['', '  '])).toBe('');
    });

    test('escapes regex metacharacters and anchors the match', () => {
      const files = [
        'supabase/migrations/2025(01).sql',
        'supabase/migrations/20250101_add+thing.sql',
      ];
      expect(buildRegexPattern(files)).toBe(
        '^(?:supabase/migrations/2025\\(01\\)\\.sql|supabase/migrations/20250101_add\\+thing\\.sql)$',
      );
    });

    test('dedupes while preserving first-seen order', () => {
      const files = ['a.sql', 'b.sql', 'a.sql', 'b.sql', 'c.sql'];
      expect(buildRegexPattern(files)).toBe('^(?:a\\.sql|b\\.sql|c\\.sql)$');
    });
  });
});

