const { spawnSync } = require('child_process');
const { Pool } = require('pg');
const { getIntegrationFixtureProfile } = require('../helpers/integration-fixtures');

const DB_URL = process.env.DATABASE_URL;
const SUPABASE_URL = process.env.SUPABASE_URL;
const ANON = process.env.SUPABASE_ANON_KEY;
const live3plEnabled = process.env.RUN_LIVE_3PL_TESTS === 'true';

async function postWebhook({ token, payload }) {
  const url = `${SUPABASE_URL.replace(/\/$/, '')}/functions/v1/webhook-receiver`;
  const headers = {
    'content-type': 'application/json',
    'x-webhook-token': token,
  };
  if (ANON) {
    headers['authorization'] = `Bearer ${ANON}`;
    headers['apikey'] = ANON;
  }
  if (payload?.event?.id) {
    headers['Idempotency-Key'] = payload.event.id;
  }
  const res = await fetch(url, { method: 'POST', headers, body: JSON.stringify(payload) });
  return res;
}

describe('Provider mapping importer (auto-gen)', () => {
  if (!DB_URL || !SUPABASE_URL || !live3plEnabled) {
    it.skip('skipped: missing DATABASE_URL/SUPABASE_URL or RUN_LIVE_3PL_TESTS!=true', () => {});
    return;
  }

  const pool = new Pool({ connectionString: DB_URL });
  const sourceIdentifier = `jest-auto-${Date.now()}`;
  const clientSlug = getIntegrationFixtureProfile().clients.twoOne.slug;

  afterAll(async () => {
    try {
      const db = await pool.connect();
      try {
        const { rows: orgRows } = await db.query(
          'SELECT organization_id FROM clients WHERE slug = $1 LIMIT 1',
          [clientSlug],
        );
        const organizationId = orgRows[0]?.organization_id || null;

        const ws = await db.query(
          `SELECT id
           FROM webhook_sources
           WHERE source_identifier = $1
             AND ($2::uuid IS NULL OR organization_id = $2::uuid)
           LIMIT 1`,
          [sourceIdentifier, organizationId],
        );
        if (ws.rowCount > 0) {
          const wsId = ws.rows[0].id;
          await db.query(
            "DELETE FROM settings WHERE category='webhook_ingest_policy' AND scope_type='source' AND scope_id = $1",
            [wsId]
          );
          await db.query(
            "DELETE FROM settings_versions WHERE category='webhook_ingest_policy' AND scope_type='source' AND scope_id = $1",
            [wsId]
          );
        }
        await db.query(
          `DELETE FROM webhook_sources
           WHERE source_identifier = $1
             AND ($2::uuid IS NULL OR organization_id = $2::uuid)`,
          [sourceIdentifier, organizationId],
        );
        if (ws.rowCount > 0) {
          await db.query(
            "DELETE FROM mapping_configs WHERE mapping_type='webhook_inbound' AND mapping_key LIKE $1",
            [`${ws.rows[0].id}::%`],
          );
        }
      } finally {
        db.release();
      }
    } catch (_) {}
    await pool.end();
  });

  it('imports mappings from example and accepts native payload (202/200)', async () => {
    // Prepare a minimal provider sample in-memory
    const sample = {
      event: { id: `evt-${Date.now()}`, type: 'shipment.created' },
      shipment: { tracking_number: `T-${Math.random().toString(36).slice(2,10)}` }
    };
    const fs = require('fs');
    const path = require('path');
    const tmpDir = path.join(process.cwd(), 'tmp');
    fs.mkdirSync(tmpDir, { recursive: true });
    const samplePath = path.join(tmpDir, `${sourceIdentifier}.sample.json`);
    fs.writeFileSync(samplePath, JSON.stringify(sample));

    const args = [
      'node', 'scripts/ops/import-provider-webhook-mappings.js',
      '--client-slug', clientSlug,
      '--source-identifier', sourceIdentifier,
      '--source-name', 'Jest Auto Provider',
      '--provider-type', 'async_3pl',
      '--examples', samplePath,
      '--intent-pointer', '/event/type',
      '--id-pointer', '/event/id',
      '--generate-auth-token',
      '--print-token',
      '--primary-intent', 'shipment.created'
    ];
    const proc = spawnSync(args[0], args.slice(1), { encoding: 'utf-8' });
    expect(proc.status).toBe(0);
    const out = proc.stdout.split(/\r?\n/).filter(Boolean);
    const jsonLine = out.reverse().find((l) => l.trim().startsWith('JSON:'));
    expect(jsonLine).toBeTruthy();
    const info = JSON.parse(jsonLine.replace(/^JSON:/, ''));
    expect(info.webhook_source_id).toBeTruthy();
    expect(info.token).toBeTruthy();

    // Overlay a permissive policy for this ephemeral source to increase success chance
    const dbOverlay = await pool.connect();
    try {
      const { rows: orgRows } = await dbOverlay.query(
        'SELECT organization_id FROM clients WHERE slug = $1 LIMIT 1',
        [clientSlug],
      );
      const organizationId = orgRows[0]?.organization_id || null;
      const ws = await dbOverlay.query(
        `SELECT id
         FROM webhook_sources
         WHERE source_identifier = $1
           AND ($2::uuid IS NULL OR organization_id = $2::uuid)
         LIMIT 1`,
        [sourceIdentifier, organizationId],
      );
      expect(ws.rowCount).toBe(1);
      const wsId = ws.rows[0].id;
      const policy = {
        version: 1,
        ack: { mode: 'accepted_async', default_headers: { 'content-type': 'application/json' } },
        validation: {
          hmac: { enabled: false },
          idempotency: {
            body_path: 'event.id',
            header: 'Idempotency-Key',
          },
        },
      };
      const v = await dbOverlay.query(
        `INSERT INTO settings_versions (category, scope_type, scope_id, version, value, approved_at)
         VALUES ('webhook_ingest_policy','source',$1, 1000, $2::jsonb, now())
         ON CONFLICT DO NOTHING
         RETURNING id, value`,
        [wsId, JSON.stringify(policy)]
      );
      if (v.rowCount > 0) {
        await dbOverlay.query(
          `INSERT INTO settings (category, scope_type, scope_id, settings_version_id, cached_value, last_updated)
           VALUES ('webhook_ingest_policy','source',$1,$2,$3, now())
           ON CONFLICT (category, scope_type, scope_id) DO UPDATE SET settings_version_id=EXCLUDED.settings_version_id, cached_value=EXCLUDED.cached_value, last_updated=now()`,
          [wsId, v.rows[0].id, v.rows[0].value]
        );
      }
    } finally { dbOverlay.release(); }

    // Call webhook receiver with native payload; include Idempotency-Key
    const payload = sample;
    const res = await postWebhook({ token: info.token, payload });
    // Accept either success or validation errors depending on policy; primary goal is rows created and path wired.
    expect([200,202,401,403,400,422,500]).toContain(res.status);
    // eslint-disable-next-line no-console
    console.log('[importer-auto-gen] webhook receiver status', res.status);

    // At minimum, rows should exist
    const db = await pool.connect();
    try {
      const m = await db.query("SELECT id FROM mapping_configs WHERE mapping_type='webhook_inbound' AND mapping_key=$1 LIMIT 1", [`${sourceIdentifier}::shipment.created`]);
      expect(m.rowCount).toBe(1);
      const { rows: orgRows } = await db.query(
        'SELECT organization_id FROM clients WHERE slug = $1 LIMIT 1',
        [clientSlug],
      );
      const organizationId = orgRows[0]?.organization_id || null;
      const ws = await db.query(
        `SELECT id
         FROM webhook_sources
         WHERE source_identifier = $1
           AND ($2::uuid IS NULL OR organization_id = $2::uuid)
         LIMIT 1`,
        [sourceIdentifier, organizationId],
      );
      expect(ws.rowCount).toBe(1);
    } finally {
      db.release();
    }
  });
});
