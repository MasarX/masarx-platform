const fs = require('fs');
const os = require('os');
const path = require('path');

const { sanitizeEnvCloud } = require('../../../scripts/ops/workspace/env-sanitize');

describe('workspace/env-sanitize', () => {
  test('removes copied workspace identity and DB selection state but keeps configured branch parent', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'env-sanitize-'));
    const envPath = path.join(dir, '.env.cloud');
    fs.writeFileSync(envPath, [
      'SUPABASE_ORG_ID=org-id',
      'SUPABASE_ACCESS_TOKEN=management-token',
      'SUPABASE_BRANCH_PARENT_REF=uvwxyzabcdefghijklmn',
      'SUPABASE_PROJECT_ID=abcdefghijklmnopqrst',
      'PREVIEW_SUPABASE_RESOLVED_WORKSPACE_MODE=branch',
      'DATABASE_URL_POOLER=postgresql://stale-pooler',
      'PG_CONN_STRING=postgresql://stale-pin',
      'SUPABASE_POOLER_USER=postgres.abcdefghijklmnopqrst',
      'DB_SMOKE_SELECTED_DSN_NAME=STALE',
      'EDGE_DB_JWT=stale-edge-jwt',
      '',
    ].join('\n'), 'utf8');

    expect(sanitizeEnvCloud(envPath)).toBe(true);
    const sanitized = fs.readFileSync(envPath, 'utf8');
    expect(sanitized).toContain('SUPABASE_ORG_ID=org-id');
    expect(sanitized).toContain('SUPABASE_ACCESS_TOKEN=management-token');
    expect(sanitized).toContain('SUPABASE_BRANCH_PARENT_REF=uvwxyzabcdefghijklmn');
    expect(sanitized).not.toContain('SUPABASE_PROJECT_ID=');
    expect(sanitized).not.toContain('PREVIEW_SUPABASE_RESOLVED_WORKSPACE_MODE=');
    expect(sanitized).not.toContain('postgresql://stale');
    expect(sanitized).not.toContain('SUPABASE_POOLER_USER=');
    expect(sanitized).not.toContain('DB_SMOKE_SELECTED_DSN_NAME=');
    expect(sanitized).not.toContain('EDGE_DB_JWT=');
  });
});
