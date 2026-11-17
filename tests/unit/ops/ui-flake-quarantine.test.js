const fs = require('fs');
const os = require('os');
const path = require('path');
const {
  loadUiFlakeQuarantine,
  normalizeEntry,
} = require('../../../scripts/ops/ci/ui-flake-quarantine');

describe('ui-flake-quarantine', () => {
  test('normalizeEntry requires owner, reason, burn-down date, and spec pattern', () => {
    const normalized = normalizeEntry({}, 0);
    expect(normalized.valid).toBe(false);
    expect(normalized.errors).toEqual(expect.arrayContaining([
      'entries[0].spec_pattern is required.',
      'entries[0].owner is required.',
      'entries[0].reason is required.',
      'entries[0].burn_down_by is required.',
    ]));
  });

  test('loadUiFlakeQuarantine loads an empty-but-valid manifest', () => {
    const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'ui-quarantine-'));
    const configPath = path.join(repoRoot, 'config', 'ci');
    fs.mkdirSync(configPath, { recursive: true });
    fs.writeFileSync(
      path.join(configPath, 'ui-flake-quarantine.json'),
      JSON.stringify({ version: '2026-03-19', entries: [] }, null, 2),
    );

    const report = loadUiFlakeQuarantine(repoRoot);
    expect(report.valid).toBe(true);
    expect(report.entries).toEqual([]);
  });
});
