const { spawnSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const {
  buildEnvRewritePayload,
  resolveEnsureEdgeWorkspace,
} = require('../../../scripts/ops/workspace/ensure-edge-role-api-keys');

const repoRoot = path.resolve(__dirname, '..', '..', '..');
const genEnvScript = path.join(repoRoot, 'scripts', 'ops', 'branches', 'gen-env.js');

function runGenEnv({ outPath, payload, env = {} }) {
  return spawnSync(process.execPath, [
    '-e',
    "require('dns').promises.Resolver = class { async resolve4() { return ['192.0.2.10']; } }; require(process.argv[1]);",
    genEnvScript, '--file', outPath,
  ], {
    cwd: repoRoot,
    input: JSON.stringify(payload),
    encoding: 'utf8',
    env: { ...process.env, ...env },
  });
}

function readEnvPairs(filePath) {
  return Object.fromEntries(
    fs.readFileSync(filePath, 'utf8')
      .split(/\r?\n/)
      .filter((line) => line && !line.startsWith('#') && line.includes('='))
      .map((line) => {
        const index = line.indexOf('=');
        return [line.slice(0, index), line.slice(index + 1)];
      }),
  );
}

describe('branches/gen-env', () => {
  test('manages EDGE_DB_JWT to prevent stale token reuse', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gen-env-'));
    const outPath = path.join(tmpDir, 'env.cloud');
    fs.writeFileSync(
      outPath,
      [
        'SUPABASE_PROJECT_ID=oldref',
        'SUPABASE_BRANCH_PARENT_REF=stale-parent-ref',
        'SUPABASE_POOLER_USER=postgres.oldref',
        'PG_CONN_STRING=postgresql://old-pinned',
        'SYNCED_DB_URL_POOLER=postgresql://old-synced',
        'DB_SMOKE_SELECTED_DSN_NAME=OLD_POOLER',
        'SHARED_LANE_DB_PROBE_SELECTED_DSN_NAME=OLD_SHARED',
        'SUPABASE_JWT_SECRET=stale-jwt-secret',
        'EDGE_DB_JWT=stale-edge-db-jwt',
        'WEBHOOK_DB_JWT=stale-webhook-jwt',
        'SOME_PRESERVED=keepme',
        '',
      ].join('\n'),
      'utf8',
    );

    const payload = {
      project_ref: 'abcdefghijklmnopqrst',
      supabase_url: 'https://abcdefghijklmnopqrst.supabase.co',
      anon_key: 'anon-key',
      service_role_key: 'service-role-key',
      jwt_secret: 'fresh-jwt-secret',
      database_url: (['postgresql',":","/","/",'user',":",'pass',"@",'localhost',":",'5432',"/",'postgres'].join("")),
      edge_require_db_jwt: '1',
      edge_db_jwt: 'fresh-edge-db-jwt',
      webhook_db_jwt: 'fresh-webhook-jwt',
      api_caller_db_jwt: 'fresh-api-caller-jwt',
      api_gateway_db_jwt: 'fresh-api-gateway-jwt',
      label_renderer_db_jwt: 'fresh-label-renderer-jwt',
    };

    const res = runGenEnv({
      outPath,
      payload,
      env: {
        SUPABASE_POOLER_HOST: '',
        SUPABASE_REGION: '',
      },
    });
    expect(res.status).toBe(0);

    const written = fs.readFileSync(outPath, 'utf8');
    expect(written).toContain('SUPABASE_PROJECT_ID=abcdefghijklmnopqrst');
    expect(written).toContain('SUPABASE_POOLER_USER=postgres.abcdefghijklmnopqrst');
    expect(written).toContain('SUPABASE_JWT_SECRET=fresh-jwt-secret');
    expect(written).toContain('EDGE_DB_JWT=fresh-edge-db-jwt');
    expect(written).toContain('WEBHOOK_DB_JWT=fresh-webhook-jwt');
    expect(written).toContain('LABEL_RENDERER_DB_JWT=fresh-label-renderer-jwt');
    expect(written).toContain('SOME_PRESERVED=keepme');
    expect(written).not.toContain('SUPABASE_JWT_SECRET=stale-jwt-secret');
    expect(written).not.toContain('SUPABASE_BRANCH_PARENT_REF=stale-parent-ref');
    expect(written).not.toContain('SUPABASE_POOLER_USER=postgres.oldref');
    expect(written).not.toContain('postgresql://old-pinned');
    expect(written).not.toContain('postgresql://old-synced');
    expect(written).not.toContain('DB_SMOKE_SELECTED_DSN_NAME=OLD_POOLER');
    expect(written).not.toContain('SHARED_LANE_DB_PROBE_SELECTED_DSN_NAME=OLD_SHARED');
    expect(written).not.toContain('EDGE_DB_JWT=stale-edge-db-jwt');
    expect(written).not.toContain('WEBHOOK_DB_JWT=stale-webhook-jwt');
  });

  test('manages PREVIEW_MODE and EDGE_REQUIRE_DB_JWT from payload', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gen-env-'));
    const outPath = path.join(tmpDir, 'env.cloud');
    fs.writeFileSync(
      outPath,
      [
        'SUPABASE_PROJECT_ID=oldref',
        'PREVIEW_MODE=0',
        'PREVIEW_SUPABASE_RESOLVED_WORKSPACE_MODE=project',
        'EDGE_REQUIRE_DB_JWT=1',
        'SOME_PRESERVED=keepme',
        '',
      ].join('\n'),
      'utf8',
    );

    const payload = {
      project_ref: 'abcdefghijklmnopqrst',
      supabase_url: 'https://abcdefghijklmnopqrst.supabase.co',
      anon_key: 'anon-key',
      service_role_key: 'service-role-key',
      database_url: (['postgresql',":","/","/",'user',":",'pass',"@",'localhost',":",'5432',"/",'postgres'].join("")),
      preview_mode: '1',
      workspace_mode: 'branch',
      branch_parent_ref: 'uvwxyzabcdefghijklmn',
      edge_require_db_jwt: '0',
    };

    const res = runGenEnv({
      outPath,
      payload,
      env: {
        SUPABASE_POOLER_HOST: '',
        SUPABASE_REGION: '',
      },
    });
    expect(res.status).toBe(0);

    const written = fs.readFileSync(outPath, 'utf8');
    expect(written).toContain('PREVIEW_MODE=1');
    expect(written).toContain('PREVIEW_SUPABASE_RESOLVED_WORKSPACE_MODE=branch');
    expect(written).toContain('SUPABASE_BRANCH_PARENT_REF=uvwxyzabcdefghijklmn');
    expect(written).toContain('PREVIEW_SUPABASE_URL=https://abcdefghijklmnopqrst.supabase.co');
    expect(written).toContain('PREVIEW_SUPABASE_ANON_KEY=anon-key');
    expect(written).toContain('PREVIEW_SUPABASE_SERVICE_ROLE_KEY=service-role-key');
    expect(written).toContain('EDGE_REQUIRE_DB_JWT=0');
    expect(written).toContain('SOME_PRESERVED=keepme');
    expect(written).not.toContain('PREVIEW_MODE=0');
    expect(written).not.toContain('PREVIEW_SUPABASE_RESOLVED_WORKSPACE_MODE=project');
    expect(written).not.toContain('EDGE_REQUIRE_DB_JWT=1');
  });

  test('branch initial write and ensure-edge rewrite preserve lineage without parent auth inheritance', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gen-env-branch-auth-'));
    const outPath = path.join(tmpDir, 'env.cloud');
    fs.writeFileSync(
      outPath,
      [
        'SUPABASE_PROJECT_ID=uvwxyzabcdefghijklmn',
        'PREVIEW_SUPABASE_RESOLVED_WORKSPACE_MODE=project',
        'SUPABASE_ANON_KEY=parent-anon',
        'SUPABASE_SERVICE_ROLE_KEY=parent-service',
        'SUPABASE_JWT_SECRET=parent-jwt-secret',
        'EDGE_DB_JWT=parent-edge-jwt',
        'WEBHOOK_DB_JWT=parent-webhook-jwt',
        'API_CALLER_DB_JWT=parent-api-caller-jwt',
        'API_GATEWAY_DB_JWT=parent-api-gateway-jwt',
        'LABEL_RENDERER_DB_JWT=parent-label-renderer-jwt',
        'SUPABASE_DB_PASSWORD=parent-db-password',
        ('DATABASE_URL=' + ['postgresql',":","/","/",'parent',":",'parent-db-password',"@",'parent-db.invalid',"/",'postgres'].join("")),
        ('DATABASE_URL_DIRECT=' + ['postgresql',":","/","/",'parent',":",'parent-db-password',"@",'parent-direct.invalid',"/",'postgres'].join("")),
        ('DATABASE_URL_POOLER=' + ['postgresql',":","/","/",'parent',":",'parent-db-password',"@",'parent-pooler.invalid',"/",'postgres'].join("")),
        'SUPABASE_POOLER_HOST=parent-pooler.invalid',
        'SUPABASE_POOLER_PORT=6543',
        'SUPABASE_POOLER_USER=postgres.uvwxyzabcdefghijklmn',
        '',
      ].join('\n'),
      'utf8',
    );
    const staleParentEnv = {
      SUPABASE_PROJECT_ID: 'uvwxyzabcdefghijklmn',
      PREVIEW_SUPABASE_RESOLVED_WORKSPACE_MODE: 'project',
      SUPABASE_ANON_KEY: 'process-parent-anon',
      SUPABASE_SERVICE_ROLE_KEY: 'process-parent-service',
      SUPABASE_JWT_SECRET: 'process-parent-jwt-secret',
      EDGE_DB_JWT: 'process-parent-edge-jwt',
      WEBHOOK_DB_JWT: 'process-parent-webhook-jwt',
      API_CALLER_DB_JWT: 'process-parent-api-caller-jwt',
      API_GATEWAY_DB_JWT: 'process-parent-api-gateway-jwt',
      LABEL_RENDERER_DB_JWT: 'process-parent-label-renderer-jwt',
      SUPABASE_DB_PASSWORD: 'process-parent-db-password',
      DATABASE_URL: (['postgresql',":","/","/",'parent',":",'process-parent-db-password',"@",'process-parent-db.invalid',"/",'postgres'].join("")),
      DATABASE_URL_DIRECT: (['postgresql',":","/","/",'parent',":",'process-parent-db-password',"@",'process-parent-direct.invalid',"/",'postgres'].join("")),
      DATABASE_URL_POOLER: (['postgresql',":","/","/",'parent',":",'process-parent-db-password',"@",'process-parent-pooler.invalid',"/",'postgres'].join("")),
      SUPABASE_POOLER_HOST: 'process-parent-pooler.invalid',
      SUPABASE_POOLER_PORT: '6543',
      SUPABASE_POOLER_USER: 'postgres.uvwxyzabcdefghijklmn',
      SUPABASE_REGION: '',
    };

    const initial = runGenEnv({
      outPath,
      payload: {
        workspace_mode: 'branch',
        branch_parent_ref: 'uvwxyzabcdefghijklmn',
        project_ref: 'abcdefghijklmnopqrst',
        supabase_url: 'https://abcdefghijklmnopqrst.supabase.co',
        database_url: (['postgresql',":","/","/",'branch-user',":",['b','r','a','n','c','h','-','p','a','s','s','w','o','r','d'].join(""),"@",'localhost',":",'5432',"/",'postgres'].join("")),
        db_pass: 'branch-password',
        jwt_secret: 'branch-jwt-secret',
        preview_mode: '1',
        edge_require_db_jwt: '1',
      },
      env: staleParentEnv,
    });
    expect(initial.status).toBe(0);
    const initialEnv = readEnvPairs(outPath);
    expect(initialEnv).toMatchObject({
      SUPABASE_PROJECT_ID: 'abcdefghijklmnopqrst',
      SUPABASE_BRANCH_PARENT_REF: 'uvwxyzabcdefghijklmn',
      PREVIEW_SUPABASE_RESOLVED_WORKSPACE_MODE: 'branch',
      SUPABASE_ANON_KEY: '',
      SUPABASE_SERVICE_ROLE_KEY: '',
      SUPABASE_JWT_SECRET: 'branch-jwt-secret',
      EDGE_DB_JWT: '',
      WEBHOOK_DB_JWT: '',
      API_CALLER_DB_JWT: '',
      API_GATEWAY_DB_JWT: '',
      LABEL_RENDERER_DB_JWT: '',
      SUPABASE_DB_PASSWORD: 'branch-password',
      DATABASE_URL: (['postgresql',":","/","/",'branch-user',":",['b','r','a','n','c','h','-','p','a','s','s','w','o','r','d'].join(""),"@",'localhost',":",'5432',"/",'postgres'].join("")),
      DATABASE_URL_DIRECT: (['postgresql',":","/","/",'branch-user',":",['b','r','a','n','c','h','-','p','a','s','s','w','o','r','d'].join(""),"@",'localhost',":",'5432',"/",'postgres'].join("")),
      DATABASE_URL_POOLER: '',
      SUPABASE_POOLER_HOST: '',
      SUPABASE_POOLER_PORT: '',
      SUPABASE_POOLER_USER: '',
    });

    const workspace = resolveEnsureEdgeWorkspace({
      env: { ...staleParentEnv, SUPABASE_PROJECT_ID: 'uvwxyzabcdefghijklmn' },
      persistedEnv: initialEnv,
    });
    const rewritePayload = buildEnvRewritePayload({
      workspace,
      anonKey: 'branch-anon',
      serviceRoleKey: 'branch-service',
      jwtSecret: 'branch-jwt-secret',
      edgeBundle: {
        webhook_db_jwt: 'branch-webhook-jwt',
        api_caller_db_jwt: 'branch-api-caller-jwt',
        api_gateway_db_jwt: 'branch-api-gateway-jwt',
        label_renderer_db_jwt: 'branch-label-renderer-jwt',
      },
      edgeGuard: { previewMode: '0', edgeRequireDbJwt: '1' },
    });
    const rewritten = runGenEnv({
      outPath,
      payload: rewritePayload,
      env: staleParentEnv,
    });
    expect(rewritten.status).toBe(0);

    const reloaded = readEnvPairs(outPath);
    expect(reloaded).toMatchObject({
      SUPABASE_PROJECT_ID: 'abcdefghijklmnopqrst',
      SUPABASE_BRANCH_PARENT_REF: 'uvwxyzabcdefghijklmn',
      PREVIEW_SUPABASE_RESOLVED_WORKSPACE_MODE: 'branch',
      SUPABASE_ANON_KEY: 'branch-anon',
      SUPABASE_SERVICE_ROLE_KEY: 'branch-service',
      SUPABASE_JWT_SECRET: 'branch-jwt-secret',
      EDGE_DB_JWT: 'branch-api-gateway-jwt',
      WEBHOOK_DB_JWT: 'branch-webhook-jwt',
      API_CALLER_DB_JWT: 'branch-api-caller-jwt',
      API_GATEWAY_DB_JWT: 'branch-api-gateway-jwt',
      LABEL_RENDERER_DB_JWT: 'branch-label-renderer-jwt',
      SUPABASE_DB_PASSWORD: 'branch-password',
      DATABASE_URL: (['postgresql',":","/","/",'branch-user',":",['b','r','a','n','c','h','-','p','a','s','s','w','o','r','d'].join(""),"@",'localhost',":",'5432',"/",'postgres'].join("")),
      DATABASE_URL_DIRECT: (['postgresql',":","/","/",'branch-user',":",['b','r','a','n','c','h','-','p','a','s','s','w','o','r','d'].join(""),"@",'localhost',":",'5432',"/",'postgres'].join("")),
      DATABASE_URL_POOLER: '',
      SUPABASE_POOLER_HOST: '',
      SUPABASE_POOLER_PORT: '',
      SUPABASE_POOLER_USER: '',
    });
    expect(resolveEnsureEdgeWorkspace({
      env: staleParentEnv,
      persistedEnv: reloaded,
    })).toMatchObject({
      workspaceMode: 'branch',
      projectRef: 'abcdefghijklmnopqrst',
      branchParentRef: 'uvwxyzabcdefghijklmn',
      jwtSecret: 'branch-jwt-secret',
    });
    expect(fs.readFileSync(outPath, 'utf8')).not.toMatch(/(?:process-)?parent-(?:anon|service|jwt|edge|webhook|api|label|db|pooler|direct)/);
  });

  test('project mode reuses process auth only when the process project identity matches', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gen-env-project-auth-'));
    const outPath = path.join(tmpDir, 'env.cloud');
    const result = runGenEnv({
      outPath,
      payload: {
        workspace_mode: 'project',
        project_ref: 'abcdefghijklmnopqrst',
        supabase_url: 'https://abcdefghijklmnopqrst.supabase.co',
        database_url: (['postgresql',":","/","/",'user',":",'password',"@",'localhost',":",'5432',"/",'postgres'].join("")),
      },
      env: {
        SUPABASE_PROJECT_ID: 'abcdefghijklmnopqrst',
        SUPABASE_ANON_KEY: 'project-anon',
        SUPABASE_SERVICE_ROLE_KEY: 'project-service',
        SUPABASE_JWT_SECRET: 'project-jwt-secret',
        EDGE_DB_JWT: 'project-edge-jwt',
        SUPABASE_POOLER_HOST: '',
        SUPABASE_REGION: '',
      },
    });
    expect(result.status).toBe(0);
    expect(readEnvPairs(outPath)).toMatchObject({
      SUPABASE_ANON_KEY: 'project-anon',
      SUPABASE_SERVICE_ROLE_KEY: 'project-service',
      SUPABASE_JWT_SECRET: 'project-jwt-secret',
      EDGE_DB_JWT: 'project-edge-jwt',
      PREVIEW_SUPABASE_RESOLVED_WORKSPACE_MODE: 'project',
    });
  });

  test('project mode does not inherit unscoped process auth for an explicit project', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gen-env-project-unscoped-auth-'));
    const outPath = path.join(tmpDir, 'env.cloud');
    const result = runGenEnv({
      outPath,
      payload: {
        workspace_mode: 'project',
        project_ref: 'abcdefghijklmnopqrst',
        supabase_url: 'https://abcdefghijklmnopqrst.supabase.co',
        database_url: (['postgresql',":","/","/",'user',":",'password',"@",'localhost',":",'5432',"/",'postgres'].join("")),
      },
      env: {
        SUPABASE_PROJECT_ID: '',
        SUPABASE_ANON_KEY: 'unscoped-anon',
        SUPABASE_SERVICE_ROLE_KEY: 'unscoped-service',
        SUPABASE_JWT_SECRET: 'unscoped-jwt-secret',
        EDGE_DB_JWT: 'unscoped-edge-jwt',
        SUPABASE_POOLER_HOST: '',
        SUPABASE_REGION: '',
      },
    });
    expect(result.status).toBe(0);
    expect(readEnvPairs(outPath)).toMatchObject({
      SUPABASE_PROJECT_ID: 'abcdefghijklmnopqrst',
      SUPABASE_ANON_KEY: '',
      SUPABASE_SERVICE_ROLE_KEY: '',
      SUPABASE_JWT_SECRET: '',
      EDGE_DB_JWT: '',
    });
    expect(fs.readFileSync(outPath, 'utf8')).not.toContain('unscoped-');
  });

  test('project identity changes cannot inherit another project auth or database values', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gen-env-project-switch-'));
    const outPath = path.join(tmpDir, 'env.cloud');
    fs.writeFileSync(outPath, [
      'SUPABASE_PROJECT_ID=uvwxyzabcdefghijklmn',
      'PREVIEW_SUPABASE_RESOLVED_WORKSPACE_MODE=project',
      'SUPABASE_ANON_KEY=file-project-a-anon',
      'SUPABASE_SERVICE_ROLE_KEY=file-project-a-service',
      'SUPABASE_JWT_SECRET=file-project-a-jwt',
      'SUPABASE_DB_PASSWORD=file-project-a-password',
      ('DATABASE_URL=' + ['postgresql',":","/","/",'a',":",'file-project-a-password',"@",'file-project-a.invalid',"/",'postgres'].join("")),
      'SUPABASE_POOLER_HOST=file-project-a-pooler.invalid',
      '',
    ].join('\n'), 'utf8');
    const result = runGenEnv({
      outPath,
      payload: {
        workspace_mode: 'project',
        project_ref: 'abcdefghijklmnopqrst',
        supabase_url: 'https://abcdefghijklmnopqrst.supabase.co',
        anon_key: '',
        service_role_key: '',
        supabase_jwt_secret: '',
      },
      env: {
        SUPABASE_PROJECT_ID: 'uvwxyzabcdefghijklmn',
        PREVIEW_SUPABASE_RESOLVED_WORKSPACE_MODE: 'project',
        SUPABASE_ANON_KEY: 'process-project-a-anon',
        SUPABASE_SERVICE_ROLE_KEY: 'process-project-a-service',
        SUPABASE_JWT_SECRET: 'process-project-a-jwt',
        SUPABASE_DB_PASSWORD: 'process-project-a-password',
        DATABASE_URL: (['postgresql',":","/","/",'a',":",'process-project-a-password',"@",'process-project-a.invalid',"/",'postgres'].join("")),
        SUPABASE_POOLER_HOST: 'process-project-a-pooler.invalid',
        SUPABASE_REGION: '',
      },
    });
    expect(result.status).toBe(0);
    const switched = readEnvPairs(outPath);
    expect(switched).toMatchObject({
      SUPABASE_PROJECT_ID: 'abcdefghijklmnopqrst',
      PREVIEW_SUPABASE_RESOLVED_WORKSPACE_MODE: 'project',
      SUPABASE_ANON_KEY: '',
      SUPABASE_SERVICE_ROLE_KEY: '',
      SUPABASE_JWT_SECRET: '',
      SUPABASE_DB_PASSWORD: '',
    });
    expect(fs.readFileSync(outPath, 'utf8')).not.toMatch(/(?:file|process)-project-a/);
  });

  test('prefers the selected preview DB candidate and persists pooler identity', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gen-env-'));
    const outPath = path.join(tmpDir, 'env.cloud');

    const payload = {
      project_ref: 'abcdefghijklmnopqrst',
      supabase_url: 'https://abcdefghijklmnopqrst.supabase.co',
      anon_key: 'anon-key',
      service_role_key: 'service-role-key',
      database_url: (['postgresql',":","/","/",'postgres',":",'pass',"@",'db.abcdefghijklmnopqrst.supabase.co',":",'5432',"/",'postgres'].join("")),
      preferred_database_url: (['postgresql',":","/","/",'postgres.abcdefghijklmnopqrst',":",'pass',"@",'192.0.2.20',":",'6543',"/",'postgres'].join("")),
      db_ready_candidate_name: 'DATABASE_URL_POOLER+ipv4host',
      db_pass: 'pass',
      pooler_host: 'aws-0-eu-west-1.pooler.supabase.com',
      pooler_port: '6543',
      pooler_user: 'postgres.abcdefghijklmnopqrst',
    };

    const res = runGenEnv({
      outPath,
      payload,
      env: {
        SUPABASE_POOLER_HOST: '',
        SUPABASE_POOLER_PORT: '',
        SUPABASE_POOLER_USER: '',
        SUPABASE_REGION: '',
      },
    });
    expect(res.status).toBe(0);

    const written = fs.readFileSync(outPath, 'utf8');
    expect(written).toContain(('DATABASE_URL=' + ['postgresql',":","/","/",'postgres.abcdefghijklmnopqrst',":",'pass',"@",'192.0.2.20',":",'6543',"/",'postgres'].join("")));
    expect(written).toContain(('DATABASE_URL_DIRECT=' + ['postgresql',":","/","/",'postgres',":",'pass',"@",'db.abcdefghijklmnopqrst.supabase.co',":",'5432',"/",'postgres'].join("")));
    expect(written).toContain(('DATABASE_URL_POOLER=' + ['postgresql',":","/","/",'postgres.abcdefghijklmnopqrst',":",'pass',"@",'aws-0-eu-west-1.pooler.supabase.com',":",'6543',"/",'postgres'].join("")));
    expect(written).toContain('SUPABASE_POOLER_HOST=aws-0-eu-west-1.pooler.supabase.com');
    expect(written).toContain('SUPABASE_POOLER_PORT=6543');
    expect(written).toContain('SUPABASE_POOLER_USER=postgres.abcdefghijklmnopqrst');
    expect(written).toContain('DATABASE_URL_SELECTED_DSN_NAME=DATABASE_URL_POOLER+ipv4host');
  });

  test('rebuilds a branch selected route from nonsecret pooler metadata instead of stale persisted DSN', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gen-env-route-'));
    const outPath = path.join(tmpDir, 'env.cloud');
    fs.writeFileSync(outPath, [
      'SUPABASE_PROJECT_ID=abcdefghijklmnopqrst',
      'SUPABASE_BRANCH_PARENT_REF=uvwxyzabcdefghijklmn',
      'PREVIEW_SUPABASE_RESOLVED_WORKSPACE_MODE=branch',
      'SUPABASE_DB_PASSWORD=secret',
      ('DATABASE_URL=' + ['postgresql',":","/","/",'postgres.abcdefghijklmnopqrst',":",'stale-password',"@",'aws-1-eu-west-1.pooler.supabase.com',":",'5432',"/",'postgres'].join("")),
      '',
    ].join('\n'), 'utf8');

    const result = runGenEnv({
      outPath,
      payload: {
        project_ref: 'abcdefghijklmnopqrst',
        workspace_mode: 'branch',
        branch_parent_ref: 'uvwxyzabcdefghijklmn',
        pooler_host: 'aws-0-eu-west-1.pooler.supabase.com',
        pooler_port: '5432',
        pooler_user: 'postgres.abcdefghijklmnopqrst',
        db_ready_candidate_name: 'DATABASE_URL_POOLER+poolerhost:aws-0',
      },
      env: {},
    });

    expect(result.status).toBe(0);
    const written = fs.readFileSync(outPath, 'utf8');
    expect(written).toContain(('DATABASE_URL=' + ['postgresql',":","/","/",'postgres.abcdefghijklmnopqrst',":",'secret',"@",'aws-0-eu-west-1.pooler.supabase.com',":",'5432',"/",'postgres'].join("")));
    expect(written).toContain(('DATABASE_URL_POOLER=' + ['postgresql',":","/","/",'postgres.abcdefghijklmnopqrst',":",'secret',"@",'aws-0-eu-west-1.pooler.supabase.com',":",'5432',"/",'postgres'].join("")));
    expect(written).toContain('DATABASE_URL_SELECTED_DSN_NAME=DATABASE_URL_POOLER+poolerhost:aws-0');
  });
});

test.each([
  ['explicit payload', 'fresh-marketing', 'project', 'fresh-marketing'],
  ['different project does not inherit stale token', undefined, 'project', ''],
  ['branch does not inherit parent token', undefined, 'branch', ''],
])('marketing read JWT: %s', (_label, token, mode, expected) => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'gen-env-marketing-'));
  try {
    const outPath = path.join(tmp, 'env.cloud');
    fs.writeFileSync(outPath, 'SUPABASE_PROJECT_ID=oldprojectrefaaaaaaa\nMARKETING_DB_JWT=stale-marketing\n');
    const result = runGenEnv({
      outPath,
      payload: {
        project_ref: 'abcdefghijklmnopqrst',
        workspace_mode: mode,
        branch_parent_ref: mode === 'branch' ? 'uvwxyzabcdefghijklmn' : '',
        supabase_url: 'https://abcdefghijklmnopqrst.supabase.co',
        database_url: (['postgresql',":","/","/",'user',":",'pass',"@",'127.0.0.1',":",'5432',"/",'postgres'].join("")),
        ...(token ? { marketing_db_jwt: token } : {}),
      },
      env: { SUPABASE_PROJECT_ID: 'oldprojectrefaaaaaaa', MARKETING_DB_JWT: 'stale-process-marketing' },
    });
    expect(result.status).toBe(0);
    expect(readEnvPairs(outPath).MARKETING_DB_JWT).toBe(expected);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});
