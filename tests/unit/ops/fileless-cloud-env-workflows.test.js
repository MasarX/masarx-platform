const fs = require('fs');
const path = require('path');

function readWorkflow(name) {
  return fs.readFileSync(
    path.join(__dirname, '..', '..', '..', '.github', 'workflows', name),
    'utf8',
  );
}

describe('fileless cloud env workflow guards', () => {
  test('cloud-provision uses runner temp env and cleanup', () => {
    const body = readWorkflow('cloud-provision.yml');

    expect(body).toContain('ENV_FILE: ${{ runner.temp }}/cloud-provision.env');
    expect(body).toContain('out_file="${ENV_FILE}"');
    expect(body).toContain('Expected generated env file missing at ENV_FILE path');
    expect(body).toContain('rm -f "${ENV_FILE}"');
    expect(body).not.toContain('ENV_FILE: config/env/.env.cloud');
  });

  test('preview-prewarm uses runner temp env and cleanup', () => {
    const body = readWorkflow('preview-prewarm.yml');

    expect(body).toContain('ENV_FILE: ${{ runner.temp }}/preview-prewarm.env');
    expect(body).toContain('Remove preview env overlay');
    expect(body).toContain('rm -f "${ENV_FILE}"');
    expect(body).not.toContain('ENV_FILE: config/env/.env.cloud');
  });

  test('reviewer gate preview uses runner temp env and cleanup', () => {
    const body = readWorkflow('reviewer-gate-pr.yml');

    expect(body).toContain('ENV_FILE: ${{ runner.temp }}/reviewer-gate-preview.env');
    expect(body).toContain('uses: ./.github/actions/setup-reviewer-gate-preview');
    expect(body).toContain('ENV_FILE: ${{ steps.preview.outputs.env_file }}');
    expect(body).not.toContain('ENV_FILE: config/env/.env.cloud');
  });

  test('preview-run defaults to ephemeral .tmp env file and cleanup', () => {
    const body = readWorkflow('preview-run.yml');

    expect(body).toContain('default: ".tmp/preview-run.env"');
    expect(body).toContain('env_file_raw="$(echo "${ENV_FILE_INPUT:-.tmp/preview-run.env}" | xargs)"');
    expect(body).toContain(
      'PREVIEW_SUPABASE_BRANCH_PARENT_REF: ${{ vars.PREVIEW_SUPABASE_BRANCH_PARENT_REF || vars.SUPABASE_PROJECT_ID || secrets.SUPABASE_PROJECT_ID || secrets.SUPABASE_PARENT_PROJECT_REF || \'\' }}',
    );
    expect(body).toContain('Remove preview env overlay');
    expect(body).toContain('rm -f "${ENV_FILE}"');
  });
});

describe('fileless cloud env script guards', () => {
  test('cloud provision resolves ENV_FILE dynamically instead of hardcoding .env.cloud', () => {
    const body = fs.readFileSync(
      path.join(__dirname, '..', '..', '..', 'scripts', 'ops', 'workspace', 'provision.js'),
      'utf8',
    );

    expect(body).toContain('function resolveProvisionEnvFile(env = process.env)');
    expect(body).toContain('const envFile = resolveProvisionEnvFile(process.env);');
    expect(body).not.toContain("const envFile = path.join('config', 'env', '.env.cloud');");
  });

  test('cloud provision caps strict JWT propagation wait for newly created projects', () => {
    const body = fs.readFileSync(
      path.join(__dirname, '..', '..', '..', 'scripts', 'ops', 'workspace', 'provision.js'),
      'utf8',
    );

    expect(body).toContain('if (projectWasCreated) {');
    expect(body).toContain("strictEnsureEnv.SUPABASE_JWT_PROPAGATION_TIMEOUT_MS");
    expect(body).toContain("strictEnsureEnv.SUPABASE_JWT_PROPAGATION_TIMEOUT_MS || '180000'");
    expect(body).toContain("strictEnsureEnv.SUPABASE_JWT_PROPAGATION_INTERVAL_MS || '5000'");
  });

  test('waybill variants worker env does not hardcode .env.cloud fallback', () => {
    const body = fs.readFileSync(
      path.join(__dirname, '..', '..', '..', 'scripts', 'qa', 'generate-waybill-variants.js'),
      'utf8',
    );

    expect(body).toContain('const workerEnv = process.env.ENV_FILE');
    expect(body).toContain('env: workerEnv');
    expect(body).not.toContain("ENV_FILE: process.env.ENV_FILE || 'config/env/.env.cloud'");
  });
});
