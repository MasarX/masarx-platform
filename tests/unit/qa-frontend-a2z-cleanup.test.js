const fs = require('fs');
const os = require('os');
const path = require('path');

const {
  parseArgs,
  parseManifestEntries,
  dedupeEntries,
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
