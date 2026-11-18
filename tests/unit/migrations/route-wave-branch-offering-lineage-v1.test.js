const fs = require('fs');
const path = require('path');

const read = (name) => fs.readFileSync(path.resolve(__dirname, '../../../supabase', name), 'utf8');
const migration = read('migrations/20261010180000_route_wave_branch_offering_lineage_v1.sql');
const original = read('migrations/202604041100_route_plan_wave_builder_v1.sql');
const pgtap = read('tests/pgtap/0zz_route_plan_ui_api_contract_v1.sql');

describe('delivery-wave branch and offering lineage migration', () => {
  test('preserves the candidate signature, due/status filters, capacity, ranking, and grants', () => {
    const section = (source, start, end) => source.slice(source.indexOf(start), source.indexOf(end, source.indexOf(start)));
    for (const [start, end] of [
      ['CREATE OR REPLACE FUNCTION public.route_plan_delivery_wave_candidates_v1(', 'DECLARE'],
      ["  IF jsonb_typeof(v_input)", '  RETURN QUERY'],
      ['      AND NOT EXISTS (', '  ),\n  ranked AS ('],
      ['      row_number() OVER (', '      e.shipment_id,'],
      ['  FROM ranked r', 'END;'],
      ['REVOKE ALL ON FUNCTION public.route_plan_delivery_wave_candidates_v1', ';\n\n'],
    ]) {
      const normalized = (source) => source.replace(/\r\n/g, '\n');
      expect(section(normalized(migration), start, end)).toBe(section(normalized(original), start, end));
    }
    expect(migration.match(/CREATE OR REPLACE FUNCTION/g)).toHaveLength(1);
  });

  test('admits branch-only candidates but validates catalog entries before metadata preference', () => {
    expect(migration).toContain('AND (s.zone_id IS NOT NULL OR s.branch_id IS NOT NULL)');
    const offering = migration.slice(migration.indexOf('    JOIN LATERAL ('), migration.indexOf('    ) so_match ON TRUE'));
    for (const constraint of [
      'so.branch_id = cb.effective_branch_id', 'so.service_level_id = sl.id',
      'so.is_active IS TRUE', 'so.effective_from <= v_planned_reference_at',
      'so.effective_to > v_planned_reference_at', 'so.zone_id IS NULL OR so.zone_id = cb.zone_id',
    ]) expect(offering.split('ORDER BY')[0]).toContain(constraint);
    expect(offering).toContain('CASE WHEN so.id::text = cb.selected_service_offering_id THEN 0 ELSE 1 END');
    expect(offering).toContain('CASE WHEN so.zone_id IS NOT DISTINCT FROM cb.zone_id THEN 0 ELSE 1 END');
    expect(offering).toContain('LIMIT 1');
    for (const field of ['service_level_id', 'service_level_key', 'service_offering_id']) {
      expect(migration).toContain(`'${field}', r.`);
    }
  });

  test('defines rollback-only native branch/zone, unavailable-offering, and actor assertions', () => {
    expect(pgtap).toContain('SET zone_id = NULL,');
    expect(pgtap).toContain('selected metadata cannot retain an inactive offering');
    expect(pgtap).toContain('branch-only candidate is excluded when no active branch-wide offering remains');
    expect(pgtap).toContain('unselected zoned shipment prefers its exact-zone offering');
    expect(pgtap).toContain('branch-only wave retains server-derived tenant and actor authority');
    const planned = Number(pgtap.match(/SELECT plan\((\d+)\)/)[1]);
    // The success/exception branches of the final permission assertion emit one result.
    expect((pgtap.match(/RETURN NEXT /g) || []).length - 1).toBe(planned);
    expect(pgtap.trim()).toMatch(/ROLLBACK;$/);
  });
});
