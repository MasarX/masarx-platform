const { spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');

describe('schema audit summary tooling', () => {
  test('schema-audit-summarize supports --in - (stdin)', () => {
    const file = path.join(__dirname, '..', '..', 'scripts', 'tooling', 'schema-audit-summarize.js');
    const sample = {
      meta: { generatedAt: '2026-02-08T00:00:00.000Z', schemas: ['public'] },
      summary: {
        relationCount: 1,
        baseTableCount: 1,
        viewCount: 0,
        materializedViewCount: 0,
        partitionedTableCount: 0,
        partitionLeafCount: 0,
        userFacingCount: 0,
        serviceOnlyCount: 0,
      },
      issues: [],
      tables: [],
    };

    const res = spawnSync(
      process.execPath,
      [file, '--format', 'md', '--in', '-'],
      { encoding: 'utf8', input: JSON.stringify(sample) },
    );

    expect(res.status).toBe(0);
    expect(String(res.stdout || '')).toContain('Live Schema Audit Summary');
    expect(String(res.stdout || '')).toContain('Generated: 2026-02-08T00:00:00.000Z');
  });

  test('schema:audit:summary is live (runs from DB then summarizes)', () => {
    const pkgPath = path.join(__dirname, '..', '..', 'package.json');
    const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
    const cmd = String(pkg?.scripts?.['schema:audit:summary'] || '');

    expect(cmd).toContain('schema-audit-from-db.js');
    expect(cmd).toContain('schema-audit-summarize.js');
    expect(cmd).toContain('--in -');
  });
});

