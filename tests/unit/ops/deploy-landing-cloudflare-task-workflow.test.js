const fs = require('fs');
const path = require('path');

describe('deploy-landing-cloudflare-task workflow guards', () => {
  const workflowFile = path.join(
    __dirname,
    '..',
    '..',
    '..',
    '.github',
    'workflows',
    'deploy-landing-cloudflare-task.yml',
  );

  test('enforces preflight deploy guard and required Cloudflare inputs', () => {
    const body = fs.readFileSync(workflowFile, 'utf8');

    expect(body).toContain('stage:');
    expect(body).toContain('workflow_name:');
    expect(body).toContain('STAGE: ${{ inputs.stage }}');
    expect(body).toContain('LANDING_PAGES_DEPLOY_GUARD');
    expect(body).toContain('LANDING_CONTACT_ENDPOINT');
    expect(body).toContain('LANDING_TENANT_SIGNUP_ENDPOINT: ${{ vars.LANDING_TENANT_SIGNUP_ENDPOINT }}');
    expect(body).toContain('LANDING_DRIVER_SIGNUP_ENDPOINT: ${{ vars.LANDING_DRIVER_SIGNUP_ENDPOINT }}');
    expect(body).toContain('LANDING_DRIVER_STATUS_ENDPOINT: ${{ vars.LANDING_DRIVER_STATUS_ENDPOINT }}');
    expect(body).toContain('LANDING_CLIENTS_ENDPOINT: ${{ vars.LANDING_CLIENTS_ENDPOINT }}');
    expect(body).toContain('LANDING_LEGACY_DOMAINS: ${{ vars.LANDING_LEGACY_DOMAINS }}');
    expect(body).toContain('RUNNER_LABELS_CI_PLAYWRIGHT_JSON');
    expect(body).toContain('RUNNER_LABELS_CI_PRIVILEGED_PROD_JSON');
    expect(body).not.toContain("contains(inputs.environment, '-prod') && 'ci_privileged_prod' || 'ci_deploy_shared'");
    expect(body).not.toContain('LANDING_DEMO_ENDPOINT');
    expect(body).toContain('Guard - landing pages deploy enabled');
    expect(body).toContain('Missing secret CLOUDFLARE_API_TOKEN');
    expect(body).toContain('Missing environment variable CLOUDFLARE_ACCOUNT_ID');
    expect(body).toContain('Missing environment variable CLOUDFLARE_ZONE_NAME');
    expect(body).toContain('Missing environment variable CLOUDFLARE_PAGES_PROJECT_LANDING');
    expect(body).toContain('Missing environment variable LANDING_DRIVER_SIGNUP_ENDPOINT');
    expect(body).toContain('Missing environment variable LANDING_DRIVER_STATUS_ENDPOINT');
    expect(body).toContain('LANDING_DRIVER_SIGNUP_ENDPOINT must point to the driver signup intake endpoint');
    expect(body).toContain('LANDING_DRIVER_STATUS_ENDPOINT must point to the driver application status endpoint');
    expect(body).toContain('Missing environment variable LANDING_CLIENTS_ENDPOINT');
    expect(body).toContain('LANDING_CLIENTS_ENDPOINT must point to the marketing-lead-intake clients feed');
    expect(body).toContain('*/marketing-lead-intake/clients');
  });

  test('builds and deploys landing using dynamic env-driven project + branch inputs', () => {
    const body = fs.readFileSync(workflowFile, 'utf8');

    const buildCmd = 'node scripts/frontend/build-landing.js --out "${{ inputs.out_dir }}"';

    expect(body).toContain('Ensure Turnstile widget + resolve site key (optional override)');
    expect(body).toContain('node scripts/ops/cloudflare/ensure-turnstile-widget.js');
    expect(body).toContain(buildCmd);
    expect(body).toContain('Start landing E2E server (prebuilt artifact)');
    expect(body).toContain('LANDING_SKIP_BUILD=1');
    expect(body).toContain('LANDING_BASE_URL: "http://landing-ci.localhost:3333"');
    expect(body).toContain('LANDING_TENANT_SIGNUP_ENDPOINT: "/__tenant-signup"');
    expect(body).toContain('LANDING_CLIENTS_ENDPOINT: "/__marketing-lead-intake/clients"');
    expect(body).toContain('node scripts/ops/ci/install-playwright-chromium.js');
    expect(body).not.toContain('npx playwright install chromium');
    expect(body).toContain('Stop landing E2E server');
    expect(body).toContain('wrangler pages project create "${CLOUDFLARE_PAGES_PROJECT_LANDING}"');
    expect(body).toContain('--production-branch "${{ inputs.pages_branch }}"');
    expect(body).toContain('wrangler pages deploy "${{ inputs.out_dir }}"');
    expect(body).toContain('--project-name "${CLOUDFLARE_PAGES_PROJECT_LANDING}"');
    expect(body).toContain('--branch "${{ inputs.pages_branch }}"');
    expect(body).toContain('WRANGLER_CLI_VERSION: ${{ vars.WRANGLER_CLI_VERSION }}');
    expect(body).toContain('Resolve Wrangler CLI contract');
    expect(body).toContain('node scripts/ops/ci/require-cli-version.js --tool wrangler --format github-output');
    expect(body).not.toContain('Install Wrangler');
    expect(body).not.toContain('npm i -g "${{ steps.wrangler_cli.outputs.package_spec }}"');
    expect(body).toContain('npm exec --yes --package "${{ steps.wrangler_cli.outputs.package_spec }}" -- wrangler pages project create');
    expect(body).toContain('npm exec --yes --package "${{ steps.wrangler_cli.outputs.package_spec }}" -- wrangler pages deploy');
    expect(body).toContain('Sync Pages domains (canonical + legacy prune)');
    expect(body).toContain('node scripts/ops/cloudflare/sync-pages-domain.js');
    expect(body).toContain('--legacy-domains "${LANDING_LEGACY_DOMAINS:-}"');
    expect(body).toContain('Write landing deploy evidence manifest');
    expect(body).toContain('node scripts/ops/ci/deploy-evidence-manifest.js');
    expect(body).toContain('--surface landing');
    expect(body).toContain('--workflow "${{ inputs.workflow_name }}"');
    expect(body).toContain('--report "tmp/landing-deploy-evidence-manifest.json"');
    expect(body).toContain('Upload landing evidence artifact');
    expect(body).toContain('landing-${{ inputs.stage }}-deploy-evidence');
    expect(body).toContain('continue-on-error: true');
    expect(body.indexOf(buildCmd)).toBe(body.lastIndexOf(buildCmd));
    expect(body).not.toContain('Rebuild landing (deploy artifact)');
  });
});
