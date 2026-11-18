import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from '@jest/globals';

describe('tracking geographic projection PostGIS binding', () => {
  it('resolves all geographic symbols through the established extension-aware search path', () => {
    const sql = readFileSync(resolve(process.cwd(), 'supabase/migrations/20260911220000_tracking_geographic_projections_v1.sql'), 'utf8');
    expect(sql).toMatch(/SET LOCAL search_path TO public,\s*extensions,\s*pg_temp;/);
    expect(sql).not.toMatch(/\b(?:public|extensions)\.(?:ST_\w+|geometry|geography)\b/i);
    expect(sql.match(/ST_[XY]\([ga]\.coordinates::geometry\)/g)).toHaveLength(4);
  });
});
