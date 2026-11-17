const {
  buildEnvRewritePayload,
  resolveEdgeGuardSettings,
  resolveEnsureEdgeWorkspace,
} = require('../../../scripts/ops/workspace/ensure-edge-role-api-keys');

describe('workspace/ensure-edge-role-api-keys', () => {
  test('uses strict guard toggles when least-privilege keys are valid', () => {
    expect(resolveEdgeGuardSettings(true)).toEqual({
      modeLabel: 'least-privilege (edge roles)',
      previewMode: '0',
      edgeRequireDbJwt: '1',
    });
  });

  test('uses preview-compatible guard toggles in fallback mode', () => {
    expect(resolveEdgeGuardSettings(false)).toEqual({
      modeLabel: 'fallback (service_role)',
      previewMode: '1',
      edgeRequireDbJwt: '0',
    });
  });

  test('uses persisted branch topology and auth instead of stale parent process values', () => {
    const workspace = resolveEnsureEdgeWorkspace({
      env: {
        WORKSPACE_MODE: 'project',
        SUPABASE_PROJECT_ID: 'uvwxyzabcdefghijklmn',
        SUPABASE_BRANCH_PARENT_REF: 'abcdefghijklmnopqrst',
        SUPABASE_URL: 'https://uvwxyzabcdefghijklmn.supabase.co',
        SUPABASE_JWT_SECRET: 'parent-jwt-secret',
      },
      persistedEnv: {
        PREVIEW_SUPABASE_RESOLVED_WORKSPACE_MODE: 'branch',
        SUPABASE_PROJECT_ID: 'abcdefghijklmnopqrst',
        SUPABASE_BRANCH_PARENT_REF: 'uvwxyzabcdefghijklmn',
        SUPABASE_URL: 'https://abcdefghijklmnopqrst.supabase.co',
        SUPABASE_JWT_SECRET: 'branch-jwt-secret',
      },
    });

    expect(workspace).toMatchObject({
      workspaceMode: 'branch',
      projectRef: 'abcdefghijklmnopqrst',
      branchParentRef: 'uvwxyzabcdefghijklmn',
      supabaseUrl: 'https://abcdefghijklmnopqrst.supabase.co',
      jwtSecret: 'branch-jwt-secret',
    });
    expect(buildEnvRewritePayload({
      workspace,
      anonKey: 'branch-anon-key',
      serviceRoleKey: 'branch-service-role-key',
      jwtSecret: workspace.jwtSecret,
      edgeBundle: {
        webhook_db_jwt: 'branch-webhook-jwt',
        api_caller_db_jwt: 'branch-api-caller-jwt',
        api_gateway_db_jwt: 'branch-api-gateway-jwt',
        label_renderer_db_jwt: 'branch-label-renderer-jwt',
      },
      edgeGuard: { previewMode: '0', edgeRequireDbJwt: '1' },
    })).toMatchObject({
      workspace_mode: 'branch',
      branch_parent_ref: 'uvwxyzabcdefghijklmn',
      project_ref: 'abcdefghijklmnopqrst',
      anon_key: 'branch-anon-key',
      service_role_key: 'branch-service-role-key',
      jwt_secret: 'branch-jwt-secret',
    });
  });

  test('rejects invalid or self-referencing persisted branch lineage', () => {
    expect(() => resolveEnsureEdgeWorkspace({
      persistedEnv: {
        PREVIEW_SUPABASE_RESOLVED_WORKSPACE_MODE: 'branch',
        SUPABASE_PROJECT_ID: 'abcdefghijklmnopqrst',
        SUPABASE_BRANCH_PARENT_REF: 'abcdefghijklmnopqrst',
        SUPABASE_URL: 'https://abcdefghijklmnopqrst.supabase.co',
      },
    })).toThrow('canonical parent lineage');
  });

  test('uses an explicit project env file instead of stale process project values', () => {
    expect(resolveEnsureEdgeWorkspace({
      env: {
        WORKSPACE_MODE: 'project',
        SUPABASE_PROJECT_ID: 'uvwxyzabcdefghijklmn',
        SUPABASE_URL: 'https://uvwxyzabcdefghijklmn.supabase.co',
        SUPABASE_JWT_SECRET: 'stale-project-a-secret',
        SUPABASE_DB_PASSWORD: 'stale-project-a-password',
      },
      persistedEnv: {
        PREVIEW_SUPABASE_RESOLVED_WORKSPACE_MODE: 'project',
        SUPABASE_PROJECT_ID: 'abcdefghijklmnopqrst',
        SUPABASE_URL: 'https://abcdefghijklmnopqrst.supabase.co',
        SUPABASE_JWT_SECRET: 'project-b-secret',
        SUPABASE_DB_PASSWORD: 'project-b-password',
      },
    })).toMatchObject({
      workspaceMode: 'project',
      projectRef: 'abcdefghijklmnopqrst',
      supabaseUrl: 'https://abcdefghijklmnopqrst.supabase.co',
      jwtSecret: 'project-b-secret',
      dbPass: 'project-b-password',
    });
  });

  test('rejects invalid topology markers and mismatched project URLs', () => {
    expect(() => resolveEnsureEdgeWorkspace({
      persistedEnv: {
        PREVIEW_SUPABASE_RESOLVED_WORKSPACE_MODE: 'corrupt',
      },
    })).toThrow('Invalid persisted workspace mode');
    expect(() => resolveEnsureEdgeWorkspace({
      persistedEnv: {
        PREVIEW_SUPABASE_RESOLVED_WORKSPACE_MODE: 'project',
        SUPABASE_PROJECT_ID: 'abcdefghijklmnopqrst',
        SUPABASE_URL: 'https://uvwxyzabcdefghijklmn.supabase.co',
      },
    })).toThrow('does not match SUPABASE_PROJECT_ID');
  });
});

