const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { lintDocEntry } = require('../../../scripts/tooling/docs-ssot-lint');

test('checks same-file and cross-file Markdown section links', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'docs-sections-'));
  try {
    fs.writeFileSync(path.join(root, 'source.md'), [
      '# Local section',
      '[Local](#local-section)',
      '[Cross-file](guide.md#hello-world)',
      '[Repeat](guide#hello-world-1)',
      '[Named](guide.md#manual-anchor)',
      '[Missing local](#missing)',
      '[Missing in guide](guide.md#inside-a-fence)',
      '[Line](guide.md?plain=1#L1-L2)',
      '[External](https://example.invalid/guide#missing)',
    ].join('\n'));
    fs.writeFileSync(path.join(root, 'guide.md'), [
      '# Hello, World!',
      '# Hello, World!',
      '<a name="manual-anchor"></a>',
      '~~~markdown',
      '# Inside a fence',
      '~~~',
    ].join('\n'));
    expect(lintDocEntry(root, { path: 'source.md', checkLinks: true })).toEqual([
      'source.md: broken_section_link "#missing"',
      'source.md: broken_section_link "guide.md#inside-a-fence"',
    ]);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
