const fs = require('fs');
const path = require('path');

describe('renderer defaults tenant seed migration', () => {
  const migrationPath = path.join(
    process.cwd(),
    'supabase',
    'migrations',
    '202511130003_renderer_defaults_tenant_seed.sql',
  );

  test('excludes global-root sentinel org from tenant-scoped settings inserts', () => {
    const sql = fs.readFileSync(migrationPath, 'utf8');
    expect(sql).toContain("o.id <> '00000000-0000-0000-0000-000000000000'::uuid");
    expect(sql).toContain("COALESCE(o.slug, '') <> 'global-root'");
  });
});

