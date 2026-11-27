const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { lintDocEntry } = require('../../../scripts/tooling/docs-ssot-lint');

test('rejects invalid and past-end line ranges in local documentation links', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'docs-lines-'));
  try {
    fs.writeFileSync(path.join(root, 'example.txt'), 'first\r\nsecond\r\n');
    fs.writeFileSync(path.join(root, 'empty.txt'), '');
    fs.writeFileSync(path.join(root, 'source.md'), [
      '[One line](example.txt#L2)',
      '[Range](example.txt#L1-L2)',
      '[Past the end](example.txt#L2-L3)',
      '[Reversed](example.txt#L2-L1)',
      '[Zero](example.txt#L0)',
      '[Malformed](example.txt#L1-L)',
      '[Empty](empty.txt#L1)',
    ].join('\n'));
    expect(lintDocEntry(root, { path: 'source.md', checkLinks: true })).toEqual([
      'source.md: broken_line_link "example.txt#L2-L3"',
      'source.md: broken_line_link "example.txt#L2-L1"',
      'source.md: broken_line_link "example.txt#L0"',
      'source.md: broken_line_link "example.txt#L1-L"',
      'source.md: broken_line_link "empty.txt#L1"',
    ]);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
