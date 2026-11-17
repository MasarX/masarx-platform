describe('workspace/preview-supabase-config', () => {
  const originalEnv = process.env;

  beforeEach(() => {
    jest.resetModules();
    process.env = { ...originalEnv };
    [
      'PREVIEW_SUPABASE_ACCESS_TOKEN',
      'PREVIEW_SUPABASE_ORG_ID',
      'PREVIEW_SUPABASE_REGION',
      'PREVIEW_SUPABASE_DB_PASSWORD',
      'PREVIEW_SUPABASE_WORKSPACE_MODE',
      'PREVIEW_SUPABASE_BRANCH_PARENT_REF',
      'SUPABASE_ACCESS_TOKEN',
      'SUPABASE_ORG_ID',
      'SUPABASE_REGION',
      'SUPABASE_DB_PASSWORD',
      'WORKSPACE_MODE',
      'SUPABASE_BRANCH_PARENT_REF',
      'SUPABASE_PARENT_PROJECT_REF',
      'SUPABASE_PROJECT_ID',
    ].forEach((key) => delete process.env[key]);
  });

  afterAll(() => {
    process.env = originalEnv;
  });

  test('defaults workspace mode to project', () => {
    const { resolvePreviewSupabaseConfig } = require('../../../scripts/ops/workspace/preview-supabase-config');
    process.env.SUPABASE_ACCESS_TOKEN = 'tok';
    process.env.SUPABASE_ORG_ID = 'org';
    process.env.SUPABASE_REGION = 'us-east-1';
    process.env.SUPABASE_DB_PASSWORD = 'pass';

    const cfg = resolvePreviewSupabaseConfig({ requirePreviewSecrets: false });
    expect(cfg.workspaceMode).toBe('project');
  });

  test('flags invalid preview workspace mode', () => {
    const { resolvePreviewSupabaseConfig } = require('../../../scripts/ops/workspace/preview-supabase-config');
    process.env.PREVIEW_SUPABASE_ACCESS_TOKEN = 'tok';
    process.env.PREVIEW_SUPABASE_ORG_ID = 'org';
    process.env.PREVIEW_SUPABASE_REGION = 'us-east-1';
    process.env.PREVIEW_SUPABASE_DB_PASSWORD = 'pass';
    process.env.PREVIEW_SUPABASE_WORKSPACE_MODE = 'invalid-mode';

    const cfg = resolvePreviewSupabaseConfig({ requirePreviewSecrets: true });
    expect(cfg.invalid).toContain('PREVIEW_SUPABASE_WORKSPACE_MODE');
  });

  test('accepts auto preview workspace mode', () => {
    const { resolvePreviewSupabaseConfig } = require('../../../scripts/ops/workspace/preview-supabase-config');
    process.env.PREVIEW_SUPABASE_ACCESS_TOKEN = 'tok';
    process.env.PREVIEW_SUPABASE_ORG_ID = 'org';
    process.env.PREVIEW_SUPABASE_REGION = 'us-east-1';
    process.env.PREVIEW_SUPABASE_DB_PASSWORD = 'pass';
    process.env.PREVIEW_SUPABASE_WORKSPACE_MODE = 'auto';

    const cfg = resolvePreviewSupabaseConfig({ requirePreviewSecrets: true });
    expect(cfg.workspaceMode).toBe('auto');
    expect(cfg.invalid).not.toContain('PREVIEW_SUPABASE_WORKSPACE_MODE');
  });

  test('resolves branch parent ref from preview var with fallback', () => {
    const { resolvePreviewSupabaseConfig } = require('../../../scripts/ops/workspace/preview-supabase-config');
    process.env.SUPABASE_ACCESS_TOKEN = 'tok';
    process.env.SUPABASE_ORG_ID = 'org';
    process.env.SUPABASE_REGION = 'us-east-1';
    process.env.SUPABASE_DB_PASSWORD = 'pass';
    process.env.SUPABASE_PROJECT_ID = 'c6beaf84-e0fa-4069-81bd-d524ca2cc694';
    process.env.WORKSPACE_MODE = 'branch';

    let cfg = resolvePreviewSupabaseConfig({ requirePreviewSecrets: false });
    expect(cfg.workspaceMode).toBe('branch');
    expect(cfg.branchParentRef).toBe('c6beaf84-e0fa-4069-81bd-d524ca2cc694');

    process.env.PREVIEW_SUPABASE_BRANCH_PARENT_REF = 'preview-parent';
    cfg = resolvePreviewSupabaseConfig({ requirePreviewSecrets: false });
    expect(cfg.branchParentRef).toBe('preview-parent');
  });

  test('prefers SUPABASE_PROJECT_ID over SUPABASE_PARENT_PROJECT_REF fallback', () => {
    const { resolvePreviewSupabaseConfig } = require('../../../scripts/ops/workspace/preview-supabase-config');
    process.env.SUPABASE_ACCESS_TOKEN = 'tok';
    process.env.SUPABASE_ORG_ID = 'org';
    process.env.SUPABASE_REGION = 'us-east-1';
    process.env.SUPABASE_DB_PASSWORD = 'pass';
    process.env.WORKSPACE_MODE = 'branch';
    process.env.SUPABASE_PARENT_PROJECT_REF = 'legacy-parent';
    process.env.SUPABASE_PROJECT_ID = '03411b5f-7520-41e3-ad9c-d358711c6deb';

    const cfg = resolvePreviewSupabaseConfig({ requirePreviewSecrets: false });
    expect(cfg.branchParentRef).toBe('03411b5f-7520-41e3-ad9c-d358711c6deb');
  });

  test('supports resolving against an injected env object without mutating process.env', () => {
    const { resolvePreviewSupabaseConfig } = require('../../../scripts/ops/workspace/preview-supabase-config');
    const env = {
      PREVIEW_SUPABASE_ACCESS_TOKEN: 'EXAMPLE_PASSWORD',
      PREVIEW_SUPABASE_ORG_ID: 'preview-org',
      PREVIEW_SUPABASE_REGION: 'eu-north-1',
      PREVIEW_SUPABASE_DB_PASSWORD: 'EXAMPLE_PASSWORD',
      PREVIEW_SUPABASE_WORKSPACE_MODE: 'auto',
    };

    const cfg = resolvePreviewSupabaseConfig({
      env,
      requirePreviewSecrets: true,
    });

    expect(cfg.token).toBe('EXAMPLE_PASSWORD');
    expect(cfg.orgId).toBe('preview-org');
    expect(cfg.region).toBe('eu-north-1');
    expect(cfg.dbPass).toBe('EXAMPLE_PASSWORD');
    expect(cfg.workspaceMode).toBe('auto');
    expect(process.env.PREVIEW_SUPABASE_ACCESS_TOKEN).toBeUndefined();
  });
});
