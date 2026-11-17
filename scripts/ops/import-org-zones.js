#!/usr/bin/env node
/**
 * Import org zones and zone_district mappings from a JSON file.
 *
 * Usage:
 *   ENV_FILE=config/env/.env.cloud \
 *   node scripts/ops/import-org-zones.js \
 *     --organization-id <uuid> \
 *     --zones-file docs/ops/examples/zones-import.sample.json \
 *     [--dry-run] [--allow-reassign] [--replace-zone-membership]
 *
 * Alternate org resolution:
 *   --client-slug <slug>   (resolves organization_id from clients table)
 *
 * File format:
 * {
 *   "zones": [
 *     {
 *       "slug": "z-north",
 *       "name": "North",
 *       "description": "...",
 *       "sort_order": 10,
 *       "is_active": true,
 *       "metadata": { "any": "json" },
 *       "districts": [
 *         { "canonical_district_id": "uuid" },
 *         { "canonical_district_name": "Al Olaya" }
 *       ]
 *     }
 *   ]
 * }
 */

const fs = require('fs');
const path = require('path');
const { Pool } = require('pg');
const { loadEnv } = require('../utils/load-env');

function argVal(name) {
  const idx = process.argv.indexOf(`--${name}`);
  if (idx !== -1 && process.argv[idx + 1] && !process.argv[idx + 1].startsWith('--')) {
    return process.argv[idx + 1];
  }
  return undefined;
}
function hasFlag(name) {
  return process.argv.includes(`--${name}`);
}

function normalizeSlug(slug) {
  const s = String(slug || '').trim();
  if (!s) return '';
  return s.toLowerCase();
}

function readZonesDoc(filePath) {
  const abs = path.resolve(String(filePath));
  if (!fs.existsSync(abs)) throw new Error(`zones-file not found: ${abs}`);
  const raw = fs.readFileSync(abs, 'utf8');
  let doc;
  try { doc = JSON.parse(raw); } catch (e) { throw new Error(`Invalid JSON in zones-file: ${e.message}`); }
  if (!doc || typeof doc !== 'object' || Array.isArray(doc)) throw new Error('zones-file must be a JSON object');
  if (!Array.isArray(doc.zones)) throw new Error('zones-file must contain { "zones": [ ... ] }');
  return doc;
}

function parseDistrictRef(ref) {
  if (typeof ref === 'string') {
    return { canonicalDistrictId: '', canonicalDistrictName: ref.trim() };
  }
  if (!ref || typeof ref !== 'object' || Array.isArray(ref)) {
    throw new Error('district ref must be an object or a string');
  }
  const canonicalDistrictId = String(ref.canonical_district_id || ref.id || '').trim();
  const canonicalDistrictName = String(ref.canonical_district_name || ref.name_canonical || ref.name || '').trim();
  if (!canonicalDistrictId && !canonicalDistrictName) {
    throw new Error('district ref requires canonical_district_id or canonical_district_name');
  }
  return { canonicalDistrictId, canonicalDistrictName };
}

async function resolveOrgId(db, { organizationId, clientSlug }) {
  if (organizationId) return organizationId;
  if (!clientSlug) throw new Error('Provide --organization-id or --client-slug');
  const res = await db.query('SELECT organization_id FROM public.clients WHERE slug = $1 LIMIT 1', [clientSlug]);
  if (res.rowCount === 0) throw new Error(`Client not found: ${clientSlug}`);
  return res.rows[0].organization_id;
}

async function resolveCanonicalDistrictId(db, organizationId, ref) {
  if (ref.canonicalDistrictId) {
    const ok = await db.query(
      'SELECT 1 FROM public.canonical_districts WHERE id = $1 AND organization_id = $2 LIMIT 1',
      [ref.canonicalDistrictId, organizationId]
    );
    if (ok.rowCount === 0) throw new Error(`canonical_district_id not found in org: ${ref.canonicalDistrictId}`);
    return ref.canonicalDistrictId;
  }

  const name = ref.canonicalDistrictName;
  const hit = await db.query(
    `SELECT d.id, d.name_canonical, c.name_canonical AS city_name
       FROM public.canonical_districts d
       JOIN public.canonical_cities c ON c.id = d.city_id
      WHERE d.organization_id = $1
        AND lower(d.name_canonical) = lower($2)
      ORDER BY c.name_canonical, d.name_canonical
      LIMIT 2`,
    [organizationId, name]
  );
  if (hit.rowCount === 0) throw new Error(`canonical_district_name not found in org: ${name}`);
  if (hit.rowCount > 1) {
    throw new Error(`canonical_district_name is ambiguous in org: ${name} (provide canonical_district_id)`);
  }
  return hit.rows[0].id;
}

async function upsertZone(db, organizationId, zone) {
  const slug = normalizeSlug(zone.slug);
  if (!slug) throw new Error('zone.slug is required');
  if (!/^[a-z0-9-]+$/.test(slug)) throw new Error(`zone.slug invalid: ${slug}`);
  const name = String(zone.name || '').trim();
  if (!name) throw new Error(`zone.name is required for ${slug}`);

  const description = zone.description != null ? String(zone.description) : null;
  const sortOrder = zone.sort_order != null ? parseInt(zone.sort_order, 10) : null;
  const isActive = zone.is_active == null ? true : Boolean(zone.is_active);
  const metadata = zone.metadata != null ? zone.metadata : null;

  const res = await db.query(
    `INSERT INTO public.zones (organization_id, slug, name, description, sort_order, is_active, metadata)
     VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb)
     ON CONFLICT (organization_id, slug)
     DO UPDATE SET
       name = EXCLUDED.name,
       description = EXCLUDED.description,
       sort_order = EXCLUDED.sort_order,
       is_active = EXCLUDED.is_active,
       metadata = EXCLUDED.metadata,
       updated_at = now()
     RETURNING id`,
    [organizationId, slug, name, description, sortOrder, isActive, metadata == null ? null : JSON.stringify(metadata)]
  );
  return { id: res.rows[0].id, slug };
}

async function main() {
  loadEnv();
  const DATABASE_URL = process.env.DATABASE_URL;
  if (!DATABASE_URL) throw new Error('DATABASE_URL is required (use ENV_FILE or export).');

  const organizationId = (argVal('organization-id') || '').trim() || null;
  const clientSlug = (argVal('client-slug') || '').trim() || null;
  const zonesFile = argVal('zones-file');
  const dryRun = hasFlag('dry-run');
  const allowReassign = hasFlag('allow-reassign');
  const replaceZoneMembership = hasFlag('replace-zone-membership');

  if (!zonesFile) throw new Error('--zones-file is required');
  const doc = readZonesDoc(zonesFile);

  const pool = new Pool({ connectionString: DATABASE_URL });
  const db = await pool.connect();

  let zonesUpserted = 0;
  let districtsMapped = 0;
  let districtsReassigned = 0;
  let districtsRemoved = 0;

  try {
    await db.query('BEGIN');
    const orgId = await resolveOrgId(db, { organizationId, clientSlug });

    for (const rawZone of doc.zones) {
      if (!rawZone || typeof rawZone !== 'object' || Array.isArray(rawZone)) {
        throw new Error('zones[] must contain objects');
      }
      const zone = await upsertZone(db, orgId, rawZone);
      zonesUpserted += 1;

      const rawDistricts = Array.isArray(rawZone.districts) ? rawZone.districts : [];
      const desiredDistrictIds = [];
      for (const ref of rawDistricts) {
        const parsed = parseDistrictRef(ref);
        const districtId = await resolveCanonicalDistrictId(db, orgId, parsed);
        desiredDistrictIds.push(districtId);
      }

      for (const districtId of desiredDistrictIds) {
        const existing = await db.query(
          `SELECT zd.id, zd.zone_id, z.slug AS zone_slug
             FROM public.zone_districts zd
             JOIN public.zones z ON z.id = zd.zone_id
            WHERE zd.canonical_district_id = $1
            LIMIT 1`,
          [districtId]
        );

        if (existing.rowCount === 0) {
          await db.query(
            `INSERT INTO public.zone_districts (zone_id, canonical_district_id)
             VALUES ($1, $2)
             ON CONFLICT (zone_id, canonical_district_id) DO NOTHING`,
            [zone.id, districtId]
          );
          districtsMapped += 1;
          continue;
        }

        const row = existing.rows[0];
        if (row.zone_id === zone.id) continue;
        if (!allowReassign) {
          throw new Error(
            `canonical_district already assigned to zone '${row.zone_slug}'. Re-run with --allow-reassign to move it.`
          );
        }
        await db.query(
          `UPDATE public.zone_districts
              SET zone_id = $1
            WHERE id = $2`,
          [zone.id, row.id]
        );
        districtsReassigned += 1;
      }

      if (replaceZoneMembership) {
        if (desiredDistrictIds.length === 0) {
          const del = await db.query('DELETE FROM public.zone_districts WHERE zone_id = $1', [zone.id]);
          districtsRemoved += del.rowCount || 0;
        } else {
          const del = await db.query(
            'DELETE FROM public.zone_districts WHERE zone_id = $1 AND NOT (canonical_district_id = ANY($2::uuid[]))',
            [zone.id, desiredDistrictIds]
          );
          districtsRemoved += del.rowCount || 0;
        }
      }
    }

    if (dryRun) {
      await db.query('ROLLBACK');
      console.log(`[import-org-zones] DRY RUN: zones=${zonesUpserted}, mapped=${districtsMapped}, reassigned=${districtsReassigned}, removed=${districtsRemoved}`);
      return;
    }
    await db.query('COMMIT');
    console.log(`[import-org-zones] OK: zones=${zonesUpserted}, mapped=${districtsMapped}, reassigned=${districtsReassigned}, removed=${districtsRemoved}`);
  } catch (err) {
    await db.query('ROLLBACK');
    throw err;
  } finally {
    db.release();
    await pool.end();
  }
}

if (require.main === module) {
  main().catch((e) => {
    console.error('[import-org-zones] Failed:', e.message);
    process.exit(1);
  });
}

module.exports = {
  normalizeSlug,
  parseDistrictRef,
  readZonesDoc,
};

