const fs = require('fs');
const os = require('os');
const path = require('path');
const {
  readDemoManifestScopeIds,
  resolveClientSeeds,
  resolveSenderSeeds,
  buildLabelBarcode,
  resolveInsertableLabelColumns,
} = require('../../scripts/qa/frontend-a2z-seed-fixtures');

describe('frontend-a2z fixture seed SQL contract', () => {
  test('casts run_id parameter to text inside shipment metadata payload', () => {
    const scriptPath = path.join(
      process.cwd(),
      'scripts',
      'qa',
      'frontend-a2z-seed-fixtures.js',
    );
    const source = fs.readFileSync(scriptPath, 'utf8');
    expect(source).toMatch(/'run_id', \$\d+::text/);
  });

  test('readDemoManifestScopeIds extracts client and sender scope ids from manifest', () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'seed-fixtures-manifest-'));
    const manifestPath = path.join(tempDir, 'demo-accounts.json');
    fs.writeFileSync(
      manifestPath,
      JSON.stringify({
        users: [
          { scope_type: 'client', scope_id: '4d1fbd36-6b6e-4c35-acc4-5e3ad9043830' },
          { scope_type: 'client', scope_id: '4d1fbd36-6b6e-4c35-acc4-5e3ad9043830' },
          { scope_type: 'sender', scope_id: '22222222-2222-4222-8222-222222222222' },
          { scope_type: 'tenant', scope_id: null },
        ],
      }),
      'utf8',
    );

    const scopeIds = readDemoManifestScopeIds(manifestPath);
    expect(scopeIds.clientIds).toEqual(['4d1fbd36-6b6e-4c35-acc4-5e3ad9043830']);
    expect(scopeIds.senderIds).toEqual(['22222222-2222-4222-8222-222222222222']);
  });

  test('resolveClientSeeds prefers demo manifest scoped clients', async () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'seed-fixtures-manifest-'));
    const manifestPath = path.join(tempDir, 'demo-accounts.json');
    fs.writeFileSync(
      manifestPath,
      JSON.stringify({
        users: [
          { scope_type: 'client', scope_id: '33333333-3333-4333-8333-333333333333' },
        ],
      }),
      'utf8',
    );

    const query = jest.fn(async () => ({
      rows: [
        {
          client_id: '33333333-3333-4333-8333-333333333333',
          organization_id: '44444444-4444-4444-8444-444444444444',
        },
      ],
    }));
    const resolved = await resolveClientSeeds({ query }, { demoManifestPath: manifestPath });

    expect(resolved.source).toBe('demo_manifest');
    expect(resolved.rows).toEqual([
      {
        client_id: '33333333-3333-4333-8333-333333333333',
        organization_id: '44444444-4444-4444-8444-444444444444',
      },
    ]);
    expect(query).toHaveBeenCalledTimes(1);
  });

  test('resolveSenderSeeds prefers demo manifest scoped senders', async () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'seed-fixtures-manifest-'));
    const manifestPath = path.join(tempDir, 'demo-accounts.json');
    fs.writeFileSync(
      manifestPath,
      JSON.stringify({
        users: [
          { scope_type: 'sender', scope_id: '55555555-5555-4555-8555-555555555555' },
        ],
      }),
      'utf8',
    );

    const query = jest.fn(async () => ({
      rows: [
        {
          sender_id: '55555555-5555-4555-8555-555555555555',
          client_id: '66666666-6666-4666-8666-666666666666',
          organization_id: '77777777-7777-4777-8777-777777777777',
        },
      ],
    }));
    const resolved = await resolveSenderSeeds({ query }, { demoManifestPath: manifestPath });

    expect(resolved.source).toBe('demo_manifest');
    expect(resolved.rows).toEqual([
      {
        sender_id: '55555555-5555-4555-8555-555555555555',
        client_id: '66666666-6666-4666-8666-666666666666',
        organization_id: '77777777-7777-4777-8777-777777777777',
      },
    ]);
    expect(query).toHaveBeenCalledTimes(1);
  });

  test('buildLabelBarcode creates deterministic uppercase label tokens', () => {
    const barcode = buildLabelBarcode('e2e-az-1234-test-run', 7);
    expect(barcode).toBe('E2E-LBL-Z1234TESTRUN-0008');
  });

  test('resolveInsertableLabelColumns validates required non-default columns', () => {
    const columns = [
      { column_name: 'id', is_nullable: 'NO', column_default: 'gen_random_uuid()' },
      { column_name: 'shipment_id', is_nullable: 'NO', column_default: null },
      { column_name: 'client_id', is_nullable: 'NO', column_default: null },
      { column_name: 'label_type', is_nullable: 'NO', column_default: null },
      { column_name: 'barcode', is_nullable: 'NO', column_default: null },
      { column_name: 'barcode_format', is_nullable: 'NO', column_default: null },
      { column_name: 'file_url', is_nullable: 'NO', column_default: null },
      { column_name: 'file_size_bytes', is_nullable: 'NO', column_default: null },
      { column_name: 'metadata', is_nullable: 'YES', column_default: null },
    ];
    const seedValues = {
      shipment_id: '4d1fbd36-6b6e-4c35-acc4-5e3ad9043830',
      client_id: '22222222-2222-4222-8222-222222222222',
      label_type: 'shipping',
      barcode: 'E2E-LBL-A-0001',
      barcode_format: 'CODE128',
      file_url: 'https://example.invalid/e2e/label.pdf',
      file_size_bytes: 1024,
      metadata: { e2e_seed: true },
    };

    const resolved = resolveInsertableLabelColumns(columns, seedValues);
    expect(resolved.ok).toBe(true);
    expect(resolved.missingRequired).toEqual([]);
    expect(resolved.columns).toEqual([
      'shipment_id',
      'client_id',
      'label_type',
      'barcode',
      'barcode_format',
      'file_url',
      'file_size_bytes',
      'metadata',
    ]);
  });
});
