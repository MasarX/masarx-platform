const fs = require('fs');
const os = require('os');
const path = require('path');
jest.mock('../../scripts/utils/load-env', () => ({ loadEnv: jest.fn() }));
jest.mock('pg', () => ({ Pool: jest.fn(() => { throw new Error('unit fixtures must not open a database pool'); }) }));
const {
  readDemoManifestScopeIds,
  resolveClientSeeds,
  resolveSenderSeeds,
  buildLabelBarcode,
  resolveInsertableLabelColumns,
  seedPortalDispatchExceptionReview,
} = require('../../scripts/qa/frontend-a2z-seed-fixtures');
const { ensureBasePublicTrackingFixtures, deterministicUuid } = require('../../scripts/qa/lib/public-tracking-fixtures');

describe('public tracking natural-key fixture identity', () => {
  const demo = {
    organizationId: '4d1fbd36-6b6e-4c35-acc4-5e3ad9043830',
    clientId: '22222222-2222-4222-8222-222222222222',
    senderId: '33333333-3333-4333-8333-333333333333',
  };

  test.each([false, true])('propagates actual database IDs on fresh/conflict upserts: %s', async (conflict) => {
    const cityId = conflict ? '44444444-4444-4444-8444-444444444444'
      : deterministicUuid(`qa-public-tracking-city:${demo.organizationId}`);
    const districtId = conflict ? '55555555-5555-4555-8555-555555555555'
      : deterministicUuid(`qa-public-tracking-district:${demo.organizationId}`);
    const query = jest.fn(async (sql) => {
      if (/insert into public.canonical_cities/i.test(sql)) return { rows: [{ id: cityId }] };
      if (/insert into public.canonical_districts/i.test(sql)) return { rows: [{ id: districtId }] };
      return { rows: [] };
    });
    const first = await ensureBasePublicTrackingFixtures({ query }, demo);
    const repeated = await ensureBasePublicTrackingFixtures({ query }, demo);
    expect(first).toEqual(repeated);
    expect(first).toEqual(expect.objectContaining({ cityId, districtId }));
    const cityCalls = query.mock.calls.filter(([sql]) => /insert into public.canonical_cities/i.test(sql));
    const districtCalls = query.mock.calls.filter(([sql]) => /insert into public.canonical_districts/i.test(sql));
    const zoneCalls = query.mock.calls.filter(([sql]) => /insert into public.zone_districts/i.test(sql));
    expect(cityCalls).toHaveLength(2);
    expect(districtCalls).toHaveLength(2);
    expect(zoneCalls).toHaveLength(2);
    for (const [sql, values] of cityCalls) {
      expect(sql).toMatch(/returning id/i);
      expect(values[0]).toBe(deterministicUuid(`qa-public-tracking-city:${demo.organizationId}`));
    }
    for (const [sql, values] of districtCalls) {
      expect(sql).toMatch(/returning id/i);
      expect(values[2]).toBe(cityId);
    }
    for (const [, values] of zoneCalls) expect(values).toEqual([first.zoneId, districtId]);
  });

  test.each([
    ['city', []], ['city', [{ id: '' }]], ['city', [{ id: 1 }]],
    ['city', [{ id: 'one' }, { id: 'two' }]],
    ['district', []], ['district', [{ id: ' ' }]], ['district', [{ id: null }]],
    ['district', [{ id: 'one' }, { id: 'two' }]],
  ])('stops before dependent writes when %s identity readback is invalid: %j', async (kind, rows) => {
    const query = jest.fn(async (sql) => {
      const city = /insert into public.canonical_cities/i.test(sql);
      if ((kind === 'city' && city) || (kind === 'district' && !city)) return { rows };
      return { rows: [{ id: '44444444-4444-4444-8444-444444444444' }] };
    });
    await expect(ensureBasePublicTrackingFixtures({ query }, demo))
      .rejects.toThrow(`${kind} upsert returned no unique identity`);
    expect(query).toHaveBeenCalledTimes(kind === 'city' ? 1 : 2);
    expect(query.mock.calls.some(([sql]) => /insert into public.zones/i.test(sql))).toBe(false);
  });
});

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

  test('public tracking fixtures preserve the canonical Arabic Riyadh alias', () => {
    const scriptPath = path.join(
      process.cwd(),
      'scripts',
      'qa',
      'lib',
      'public-tracking-fixtures.js',
    );
    const source = fs.readFileSync(scriptPath, 'utf8');

    expect(source).toContain("array['Riyadh', 'Riyadh City', 'الرياض']::text[]");
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

  test('seedPortalDispatchExceptionReview creates a canonical task manifest entry', async () => {
    const query = jest.fn().mockResolvedValue({
      rows: [{ task_id: '88888888-8888-4888-8888-888888888888' }],
    });
    const seeded = await seedPortalDispatchExceptionReview({
      client: { query },
      runId: 'e2e-a2z-task',
      seededShipments: [{
        shipment_id: '4d1fbd36-6b6e-4c35-acc4-5e3ad9043830',
        organization_id: '22222222-2222-4222-8222-222222222222',
        client_id: '33333333-3333-4333-8333-333333333333',
        sender_id: '44444444-4444-4444-8444-444444444444',
        seed_source: 'demo_manifest',
      }],
    });

    const payload = JSON.parse(query.mock.calls[0][1][0]);
    expect(payload).toMatchObject({
      task_type_key: 'dispatch_exception_review',
      resource_type: 'shipment',
      resource_id: '4d1fbd36-6b6e-4c35-acc4-5e3ad9043830',
      actor_system: 'frontend-a2z-seed-fixtures',
      context: {
        organization_id: '22222222-2222-4222-8222-222222222222',
        client_id: '33333333-3333-4333-8333-333333333333',
        sender_id: '44444444-4444-4444-8444-444444444444',
        dispatch_exception_reason: 'customer_unavailable',
      },
      metadata: {
        e2e_seed: true,
        dispatch_exception_reason: 'customer_unavailable',
      },
    });
    expect(seeded.inserted_count).toBe(1);
    expect(seeded.manifestEntries).toEqual([
      expect.objectContaining({
        kind: 'task',
        id: '88888888-8888-4888-8888-888888888888',
      }),
    ]);
  });

  test('seedPortalDispatchExceptionReview rejects fallback shipments outside the demo manifest', async () => {
    const query = jest.fn();
    const seeded = await seedPortalDispatchExceptionReview({
      client: { query },
      runId: 'e2e-a2z-task',
      seededShipments: [{
        shipment_id: '4d1fbd36-6b6e-4c35-acc4-5e3ad9043830',
        organization_id: '22222222-2222-4222-8222-222222222222',
        client_id: '33333333-3333-4333-8333-333333333333',
        seed_source: 'latest_clients',
      }],
    });

    expect(query).not.toHaveBeenCalled();
    expect(seeded.inserted_count).toBe(0);
    expect(seeded.errors).toEqual([{ message: 'demo_manifest_visible_shipment_missing' }]);
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
