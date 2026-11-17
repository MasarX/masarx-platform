const fs = require('fs');
const path = require('path');
const YAML = require('yaml');

const workflowFile = path.join(
  __dirname,
  '..', '..', '..',
  '.github', 'workflows', 'supabase-canary-create-delete.yml',
);

describe('Supabase create/delete canary workflow', () => {
  test('parses and keeps exact branch cleanup sparse without dependency setup', () => {
    const body = fs.readFileSync(workflowFile, 'utf8');
    const document = YAML.parseDocument(body, { uniqueKeys: true });
    expect(document.errors).toEqual([]);

    const cleanupCheckout = body.match(
      /- name: Checkout exact branch cleanup[\s\S]*?(?=\n\s{4}- name: Checkout canary workspace)/,
    );
    const regularCheckout = body.match(
      /- name: Checkout canary workspace[\s\S]*?(?=\n\s{4}- name: Setup Node \+ deps)/,
    );
    const setup = body.match(
      /- name: Setup Node \+ deps[\s\S]*?(?=\n\s{4}- name: Run canary)/,
    );
    expect(cleanupCheckout).toBeTruthy();
    expect(cleanupCheckout[0]).toContain("if: (github.event.inputs.mode || 'project') == 'branch_cleanup'");
    expect(cleanupCheckout[0]).toContain('timeout-minutes: 5');
    expect(cleanupCheckout[0]).toContain('fetch-depth: 1');
    expect(cleanupCheckout[0]).toContain('filter: blob:none');
    expect(cleanupCheckout[0]).toContain('scripts/ops/workspace/delete-branch.js');
    expect(cleanupCheckout[0]).toContain('scripts/utils/env-file.js');
    expect(cleanupCheckout[0]).toContain('scripts/utils/load-env.js');
    expect(regularCheckout[0]).toContain("if: (github.event.inputs.mode || 'project') != 'branch_cleanup'");
    expect(setup[0]).toContain("if: (github.event.inputs.mode || 'project') != 'branch_cleanup'");
  });

  test('branch cleanup selects the requested preview token before exact deletion', () => {
    const body = fs.readFileSync(workflowFile, 'utf8');
    const cleanup = body.match(
      /if \[ "\$\{MODE\}" = "branch_cleanup" \]; then[\s\S]*?exit 0/,
    );
    expect(cleanup).toBeTruthy();
    expect(cleanup[0]).toContain("BRANCH_TOKEN=\"${{ github.event.inputs.branch_token || 'supabase' }}\"");
    expect(cleanup[0]).toContain('export SUPABASE_ACCESS_TOKEN="${PREVIEW_SUPABASE_ACCESS_TOKEN}"');
    expect(cleanup[0]).toContain('node scripts/ops/workspace/delete-branch.js --id "${BRANCH_ID}"');
    expect(body).toContain('Token to use when mode=branch or branch_cleanup');
  });
});
