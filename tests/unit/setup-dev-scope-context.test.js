const fs = require('fs');
const path = require('path');

const repoRoot = path.resolve(__dirname, '..', '..');

function read(relPath) {
  return fs.readFileSync(path.join(repoRoot, relPath), 'utf8');
}

describe('Setup/dev scripts avoid implicit selection + global scope leakage', () => {
  test('setup_label_e2e does not select addresses by created_at', () => {
    const body = read('scripts/setup/setup_label_e2e.js');

    expect(body).not.toMatch(/SELECT\s+id\s+FROM\s+addresses[\s\S]*ORDER\s+BY\s+created_at/i);
    expect(body).toMatch(/--organization-slug/);
    expect(body).toMatch(/--client-slug/);
  });

  test('debug-label-print-workflow uses a deterministic workflow template lookup', () => {
    const body = read('scripts/dev/debug-label-print-workflow.js');

    expect(body).not.toMatch(/workflow_templates[\s\S]*ORDER\s+BY\s+created_at[\s\S]*LIMIT\s+1/i);
    expect(body).toMatch(/SELECT id FROM workflow_templates WHERE name = \$1::text LIMIT 1/);
  });

  test('debug-label-print-workflow scopes settings to tenant', () => {
    const body = read('scripts/dev/debug-label-print-workflow.js');

    expect(body).toMatch(/category:\s*'label_provider'[\s\S]*scopeType:\s*'tenant'[\s\S]*scopeId:\s*organizationId/);
    expect(body).toMatch(/category:\s*'label_print_defaults'[\s\S]*scopeType:\s*'tenant'[\s\S]*scopeId:\s*organizationId/);
  });
});
