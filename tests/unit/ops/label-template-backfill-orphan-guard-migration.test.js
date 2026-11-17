const fs = require('fs');
const path = require('path');

function read(p) {
  return fs.readFileSync(p, 'utf8');
}

describe('labels orphan org guard migration', () => {
  test('guards template-spec backfills by cleaning orphan label_jobs and labels pointers', () => {
    const repoRoot = path.resolve(__dirname, '..', '..', '..');
    const mig = path.join(
      repoRoot,
      'supabase',
      'migrations',
      '202601211518_labels_orphan_org_layout_template_guard.sql',
    );
    const body = read(mig);
    expect(body).toContain('DELETE FROM public.label_jobs');
    expect(body).toContain('UPDATE public.labels');
    expect(body).toContain('SET layout_template_id = NULL');
    expect(body).toContain('NOT EXISTS');
    expect(body).toContain('public.organizations');
  });
});
