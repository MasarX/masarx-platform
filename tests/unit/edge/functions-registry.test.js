const fs = require('fs');
const path = require('path');
const os = require('os');
const { DEFAULT_REGISTRY_PATH, loadRegistry, planDeploy } = require('../../../scripts/edge/functions-registry');

function writeTempRegistry(data) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'edge-registry-'));
  const file = path.join(dir, 'functions.json');
  fs.writeFileSync(file, JSON.stringify(data), 'utf8');
  return file;
}

describe('edge/functions-registry', () => {
  test('default registry includes tenant signup functions with expected auth modes', () => {
    const entries = loadRegistry(DEFAULT_REGISTRY_PATH);
    const byName = new Map(entries.map((entry) => [entry.name, entry]));

    expect(byName.get('tenant-signup-intake')).toMatchObject({
      name: 'tenant-signup-intake',
      authMode: 'public_no_jwt',
      enabled: true,
    });
    expect(byName.get('tenant-signup-review')).toMatchObject({
      name: 'tenant-signup-review',
      authMode: 'supabase_jwt',
      enabled: true,
    });
  });

  test('loadRegistry supports array and { functions: [] } shapes', () => {
    const file = writeTempRegistry([
      { name: 'api-caller', auth_mode: 'supabase_jwt', enabled: true },
      { name: 'webhook-receiver', auth_mode: 'public_no_jwt' },
    ]);
    const entries = loadRegistry(file);
    expect(entries).toEqual([
      { name: 'api-caller', authMode: 'supabase_jwt', enabled: true },
      { name: 'webhook-receiver', authMode: 'public_no_jwt', enabled: true },
    ]);

    const file2 = writeTempRegistry({
      functions: [{ name: 'label-renderer', authMode: 'public_no_jwt', enabled: false }],
    });
    const entries2 = loadRegistry(file2);
    expect(entries2).toEqual([
      { name: 'label-renderer', authMode: 'public_no_jwt', enabled: false },
    ]);
  });

  test('planDeploy partitions by authMode and enabled', () => {
    const entries = [
      { name: 'api-caller', authMode: 'supabase_jwt', enabled: true },
      { name: 'webhook-receiver', authMode: 'public_no_jwt', enabled: true },
      { name: 'label-renderer', authMode: 'none', enabled: true },
      { name: 'disabled-fn', authMode: 'public_no_jwt', enabled: false },
    ];
    const { withJwt, noVerifyJwt } = planDeploy(entries);
    expect(withJwt.map((e) => e.name)).toEqual(['api-caller']);
    expect(noVerifyJwt.map((e) => e.name)).toEqual(['webhook-receiver', 'label-renderer']);
  });
});
