const fs = require('fs');
const path = require('path');

const source = fs.readFileSync(path.resolve(
  __dirname,
  '../../../supabase/migrations/20260913094000_fieldops_active_role_v1.sql',
), 'utf8');

describe('FieldOps active-role contract', () => {
  test('keeps role preference server-authorized and device scoped', () => {
    for (const required of [
      'ADD COLUMN IF NOT EXISTS active_role_id UUID',
      'REFERENCES public.rbac_roles(id)',
      'public.ui_get_fieldops_active_role_v1',
      'public.ui_set_fieldops_active_role_v1',
      'api.ui_get_fieldops_active_role_v1',
      'api.ui_set_fieldops_active_role_v1',
      'd.organization_id = v_organization_id',
      'd.user_id = v_user_id',
      'd.revoked_at IS NULL',
      'a.organization_id = v_organization_id',
      'a.user_id = v_user_id',
      'a.revoked_at IS NULL',
      'r.is_active',
      'bm.effective_from <= now()',
      'bm.effective_to IS NULL OR bm.effective_to > now()',
      "USING ERRCODE = '42501'",
      'TO authenticated',
    ]) expect(source).toContain(required);
  });

  test('does not mutate authorization state or trust caller metadata', () => {
    expect(source).not.toMatch(/UPDATE\s+public\.rbac_/i);
    expect(source).not.toMatch(/INSERT\s+INTO\s+public\.rbac_/i);
    expect(source).not.toMatch(/request\.jwt\.claims/i);
    expect(source).not.toMatch(/metadata\s*=/i);
  });
});
