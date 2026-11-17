const fs = require('fs');
const path = require('path');

const repoRoot = path.resolve(__dirname, '..', '..', '..');

function read(relativePath) {
  return fs.readFileSync(path.join(repoRoot, relativePath), 'utf8');
}

describe('label designer Edge authentication contract', () => {
  test('browser-invoked functions use the narrowest safe JWT validation mode', () => {
    const registry = JSON.parse(read('config/edge/functions.json'));
    const byName = new Map(registry.functions.map((entry) => [entry.name, entry]));

    expect(byName.get('label-renderer')?.auth_mode).toBe('supabase_jwt');
    expect(byName.get('label-designer-assets')?.auth_mode).toBe('public_no_jwt');
    expect(JSON.parse(read('supabase/functions/label-renderer/deno.json')).deploy.verify_jwt).toBe(true);
    expect(JSON.parse(read('supabase/functions/label-designer-assets/deno.json')).deploy.verify_jwt).toBe(false);
  });

  test('UI and E2E do not put the publishable key in Authorization', () => {
    const uiSource = read('packages/ui/src/label-designer/use-label-designer-data.ts');
    const e2eSource = read('tests/integration/label-designer/label-designer.e2e.test.js');

    expect(uiSource).not.toContain('Authorization: `Bearer ${anonKey}`');
    expect(e2eSource).not.toContain('Authorization: `Bearer ${process.env.SUPABASE_ANON_KEY}`');
  });
});
