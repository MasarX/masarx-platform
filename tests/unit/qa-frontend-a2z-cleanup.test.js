const fs = require('fs');
const os = require('os');
const path = require('path');

const {
  parseArgs,
  parseManifestEntries,
  dedupeEntries,
  sortEntriesForCleanup,
  cleanupTask,
  cleanupSettingsView,
  resolveDatabaseUrl,
} = require('../../scripts/qa/frontend-a2z-cleanup');

describe('frontend a2z cleanup helpers', () => {
  test('parseArgs supports manifest/out flags', () => {
    const parsed = parseArgs([
      '--manifest',
      'tmp/mutation-manifest.ndjson',
      '--out=tmp/cleanup-report.json',
    ]);

    expect(parsed.manifest).toBe('tmp/mutation-manifest.ndjson');
    expect(parsed.out).toBe('tmp/cleanup-report.json');
  });

  test('parseManifestEntries reads ndjson rows', () => {
    const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'frontend-a2z-cleanup-'));
    const manifestPath = path.join(tmpRoot, 'manifest.ndjson');
    fs.writeFileSync(
      manifestPath,
      [
        JSON.stringify({ kind: 'shipment', id: '11111111-1111-1111-1111-111111111111', label: 'seed-shipment' }),
        JSON.stringify({ kind: 'label', id: '33333333-3333-3333-3333-333333333333', label: 'seed-label' }),
        JSON.stringify({ kind: 'workflow_template', id: '22222222-2222-2222-2222-222222222222', label: 'wf-draft' }),
      ].join('\n') + '\n',
      'utf8'
    );

    const entries = parseManifestEntries(manifestPath);
    expect(entries).toHaveLength(3);
    expect(entries[0].kind).toBe('shipment');
    expect(entries[1].kind).toBe('label');
    expect(entries[2].kind).toBe('workflow_template');

    fs.rmSync(tmpRoot, { recursive: true, force: true });
  });

  test('dedupeEntries removes duplicate kind+id pairs and invalid rows', () => {
    const entries = dedupeEntries([
      { kind: 'shipment', id: '1', label: 'a' },
      { kind: 'shipment', id: '1', label: 'b' },
      { kind: 'label', id: '3', label: 'label-a' },
      { kind: 'workflow_template', id: '2', label: 'c' },
      { kind: 'shipment', id: '', label: 'invalid' },
    ]);

    expect(entries).toEqual([
      {
        kind: 'shipment',
        id: '1',
        label: 'a',
        runId: null,
        metadata: null,
      },
      {
        kind: 'label',
        id: '3',
        label: 'label-a',
        runId: null,
        metadata: null,
      },
      {
        kind: 'workflow_template',
        id: '2',
        label: 'c',
        runId: null,
        metadata: null,
      },
    ]);
  });

  test('sortEntriesForCleanup deletes tasks before their dependent shipments', () => {
    const sorted = sortEntriesForCleanup([
      { kind: 'shipment', id: 'shipment' },
      { kind: 'unknown', id: 'unknown' },
      { kind: 'workflow_template', id: 'workflow' },
      { kind: 'label', id: 'label' },
      { kind: 'task', id: 'task' },
      { kind: 'settings_view', id: 'settings' },
    ]);

    expect(sorted.map((entry) => entry.kind)).toEqual([
      'settings_view',
      'task',
      'label',
      'shipment',
      'workflow_template',
      'unknown',
    ]);
  });

  test('cleanupTask deletes the exact task id', async () => {
    const query = jest.fn().mockResolvedValue({ rowCount: 1 });
    await expect(cleanupTask({ query }, '4d1fbd36-6b6e-4c35-acc4-5e3ad9043830')).resolves.toEqual({
      action: 'delete',
      ok: true,
      rowCount: 1,
    });
    expect(query).toHaveBeenCalledWith(
      'DELETE FROM tasks WHERE id = $1::uuid',
      ['4d1fbd36-6b6e-4c35-acc4-5e3ad9043830'],
    );
  });

  test('cleanupSettingsView restores the exact previous governed value', async () => {
    const query = jest
      .fn()
      .mockResolvedValueOnce({})
      .mockResolvedValueOnce({})
      .mockResolvedValueOnce({
        rows: [{ settings_version_id: '4d1fbd36-6b6e-4c35-acc4-5e3ad9043830' }],
      })
      .mockResolvedValueOnce({ rowCount: 1, rows: [{ value: { resources: {} } }] })
      .mockResolvedValueOnce({ rowCount: 1 })
      .mockResolvedValueOnce({});
    await expect(cleanupSettingsView({ query }, {
      kind: 'settings_view',
      id: '4d1fbd36-6b6e-4c35-acc4-5e3ad9043830',
      label: 'fixture',
      metadata: {
        scope_type: 'client',
        scope_id: '22222222-2222-4222-8222-222222222222',
        previous_settings_version_id: '33333333-3333-4333-8333-333333333333',
      },
    })).resolves.toEqual({ action: 'restore', ok: true, rowCount: 1 });
    expect(query).toHaveBeenCalledWith(
      expect.stringContaining('FROM public.upsert_settings_value_v1'),
      [
        'client',
        '22222222-2222-4222-8222-222222222222',
        JSON.stringify({ resources: {} }),
        'fixture:recover',
      ],
    );
  });

  test('cleanupSettingsView noops only when a newer version excludes the fixture view', async () => {
    const query = jest
      .fn()
      .mockResolvedValueOnce({})
      .mockResolvedValueOnce({})
      .mockResolvedValueOnce({
        rows: [{
          settings_version_id: '99999999-9999-4999-8999-999999999999',
          cached_value: { resources: { shipments: { views: {} } } },
        }],
      })
      .mockResolvedValueOnce({});
    await expect(cleanupSettingsView({ query }, {
      kind: 'settings_view',
      id: '4d1fbd36-6b6e-4c35-acc4-5e3ad9043830',
      label: 'fixture',
      metadata: {
        scope_type: 'client',
        scope_id: '22222222-2222-4222-8222-222222222222',
        resource_key: 'shipments',
        view_id: '33333333-3333-4333-8333-333333333333',
      },
    })).resolves.toEqual({ action: 'noop', ok: true, rowCount: 0 });
    expect(query).toHaveBeenLastCalledWith('COMMIT');
  });

  test('cleanupSettingsView fails closed when a newer version inherits the fixture view', async () => {
    const query = jest
      .fn()
      .mockResolvedValueOnce({})
      .mockResolvedValueOnce({})
      .mockResolvedValueOnce({
        rows: [{
          settings_version_id: '99999999-9999-4999-8999-999999999999',
          cached_value: {
            resources: {
              shipments: {
                views: {
                  '33333333-3333-4333-8333-333333333333': { label: 'fixture' },
                },
              },
            },
          },
        }],
      })
      .mockResolvedValueOnce({});
    await expect(cleanupSettingsView({ query }, {
      kind: 'settings_view',
      id: '4d1fbd36-6b6e-4c35-acc4-5e3ad9043830',
      label: 'fixture',
      metadata: {
        scope_type: 'client',
        scope_id: '22222222-2222-4222-8222-222222222222',
        resource_key: 'shipments',
        view_id: '33333333-3333-4333-8333-333333333333',
      },
    })).resolves.toMatchObject({
      action: 'failed',
      ok: false,
      error: 'settings_view fixture inherited by a newer version',
    });
    expect(query).toHaveBeenLastCalledWith('ROLLBACK');
  });

  test('resolveDatabaseUrl chooses first available candidate', () => {
    const original = {
      DATABASE_URL: process.env.DATABASE_URL,
      DATABASE_URL_DIRECT: process.env.DATABASE_URL_DIRECT,
      DATABASE_URL_POOLER: process.env.DATABASE_URL_POOLER,
    };

    process.env.DATABASE_URL = '';
    process.env.DATABASE_URL_DIRECT = 'postgres://direct';
    process.env.DATABASE_URL_POOLER = 'postgres://pooler';

    expect(resolveDatabaseUrl()).toBe('postgres://direct');

    process.env.DATABASE_URL = 'postgres://primary';
    expect(resolveDatabaseUrl()).toBe('postgres://primary');

    process.env.DATABASE_URL = original.DATABASE_URL;
    process.env.DATABASE_URL_DIRECT = original.DATABASE_URL_DIRECT;
    process.env.DATABASE_URL_POOLER = original.DATABASE_URL_POOLER;
  });
});
