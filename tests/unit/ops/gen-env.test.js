const { spawnSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const repoRoot = path.resolve(__dirname, '..', '..', '..');
const genEnvScript = path.join(repoRoot, 'scripts', 'ops', 'branches', 'gen-env.js');

function runGenEnv({ outPath, payload, env = {} }) {
  return spawnSync(process.execPath, [genEnvScript, '--file', outPath], {
    cwd: repoRoot,
    input: JSON.stringify(payload),
    encoding: 'utf8',
    env: { ...process.env, ...env },
  });
}

describe('branches/gen-env', () => {
  test('manages EDGE_DB_JWT to prevent stale token reuse', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gen-env-'));
    const outPath = path.join(tmpDir, 'env.cloud');
    fs.writeFileSync(
      outPath,
      [
        'SUPABASE_PROJECT_ID=oldref',
        'SUPABASE_JWT_SECRET=stale-jwt-secret',
        'EDGE_DB_JWT=stale-edge-db-jwt',
        'WEBHOOK_DB_JWT=stale-webhook-jwt',
        'SOME_PRESERVED=keepme',
        '',
      ].join('\n'),
      'utf8',
    );

    const payload = {
      project_ref: 'newref',
      supabase_url: 'https://newref.supabase.co',
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
    expect(written).toContain('SUPABASE_PROJECT_ID=newref');
    expect(written).toContain('SUPABASE_JWT_SECRET=fresh-jwt-secret');
    expect(written).toContain('EDGE_DB_JWT=fresh-edge-db-jwt');
    expect(written).toContain('WEBHOOK_DB_JWT=fresh-webhook-jwt');
    expect(written).toContain('LABEL_RENDERER_DB_JWT=fresh-label-renderer-jwt');
    expect(written).toContain('SOME_PRESERVED=keepme');
    expect(written).not.toContain('SUPABASE_JWT_SECRET=stale-jwt-secret');
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
        'EDGE_REQUIRE_DB_JWT=1',
        'SOME_PRESERVED=keepme',
        '',
      ].join('\n'),
      'utf8',
    );

    const payload = {
      project_ref: 'newref',
      supabase_url: 'https://newref.supabase.co',
      anon_key: 'anon-key',
      service_role_key: 'service-role-key',
      database_url: (['postgresql',":","/","/",'user',":",'pass',"@",'localhost',":",'5432',"/",'postgres'].join("")),
      preview_mode: '1',
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
    expect(written).toContain('PREVIEW_SUPABASE_URL=https://newref.supabase.co');
    expect(written).toContain('PREVIEW_SUPABASE_ANON_KEY=anon-key');
    expect(written).toContain('PREVIEW_SUPABASE_SERVICE_ROLE_KEY=service-role-key');
    expect(written).toContain('EDGE_REQUIRE_DB_JWT=0');
    expect(written).toContain('SOME_PRESERVED=keepme');
    expect(written).not.toContain('PREVIEW_MODE=0');
    expect(written).not.toContain('EDGE_REQUIRE_DB_JWT=1');
  });

  test('prefers the selected preview DB candidate and persists pooler identity', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gen-env-'));
    const outPath = path.join(tmpDir, 'env.cloud');

    const payload = {
      project_ref: 'xooqygvstokpqzukjkqy',
      supabase_url: 'https://xooqygvstokpqzukjkqy.supabase.co',
      anon_key: 'anon-key',
      service_role_key: 'service-role-key',
      database_url: (['postgresql',":","/","/",'postgres',":",'lmvhpwigvnziuyivjnptrmrj',"@",'example.invalid',":",'5432',"/",'postgres'].join("")),
      preferred_database_url: (['postgresql',":","/","/",'postgres.xooqygvstokpqzukjkqy',":",'zyxmsoyihirnnhsthyhsyzsk',"@",'example.invalid',":",'6543',"/",'postgres'].join("")),
      db_ready_candidate_name: 'DATABASE_URL_POOLER+ipv4host',
      db_pass: 'pass',
      pooler_host: 'aws-0-eu-west-1.pooler.supabase.com',
      pooler_port: '6543',
      pooler_user: 'postgres.xooqygvstokpqzukjkqy',
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
    expect(written).toContain(('DATABASE_URL=' + ['postgresql',":","/","/",'postgres.xooqygvstokpqzukjkqy',":",'zyxmsoyihirnnhsthyhsyzsk',"@",'example.invalid',":",'6543',"/",'postgres'].join("")));
    expect(written).toContain(('DATABASE_URL_DIRECT=' + ['postgresql',":","/","/",'postgres',":",'lmvhpwigvnziuyivjnptrmrj',"@",'example.invalid',":",'5432',"/",'postgres'].join("")));
    expect(written).toContain(('DATABASE_URL_POOLER=' + ['postgresql',":","/","/",'postgres.xooqygvstokpqzukjkqy',":",'zyxmsoyihirnnhsthyhsyzsk',"@",'example.invalid',":",'6543',"/",'postgres'].join("")));
    expect(written).toContain('SUPABASE_POOLER_HOST=aws-0-eu-west-1.pooler.supabase.com');
    expect(written).toContain('SUPABASE_POOLER_PORT=6543');
    expect(written).toContain('SUPABASE_POOLER_USER=postgres.xooqygvstokpqzukjkqy');
    expect(written).toContain('DATABASE_URL_SELECTED_DSN_NAME=DATABASE_URL_POOLER+ipv4host');
  });
});
