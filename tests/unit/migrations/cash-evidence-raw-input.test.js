const fs = require('node:fs');
const path = require('node:path');

// Static boundary guard only; native COD tests execute both rejection and omission.
test('cash evidence raw validation precedes replay and null stripping without changing scope gates', () => {
  const sql = fs.readFileSync(path.resolve(process.cwd(),
    'supabase/migrations/20260911101000_cash_evidence_raw_input_guard_v1.sql'), 'utf8');
  const guard = sql.indexOf('-- Validate supplied evidence');
  expect(guard).toBeGreaterThan(sql.indexOf("requires tasks.complete permission"));
  expect(guard).toBeLessThan(sql.indexOf('IF v_idempotency IS NOT NULL THEN'));
  expect(guard).toBeLessThan(sql.indexOf('jsonb_strip_nulls(v_payload'));
  expect(sql).toContain("tt.metadata ? 'completion_evidence_contract'");
  for (const key of ['photo_artifact_id', 'supervisor_name'])
    expect(sql).toContain("jsonb_typeof(v_payload->'" + key + "') IS DISTINCT FROM 'string'");
  expect(sql).toContain("IF v_payload ? 'cash_handover_evidence_version' THEN");
});
