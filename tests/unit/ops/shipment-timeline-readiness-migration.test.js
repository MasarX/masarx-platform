const fs = require('fs');
const path = require('path');

const migrationPath = path.join(
  __dirname,
  '../../../supabase/migrations/202606101230_console_v2_shipment_timeline_comms_action_readiness_v1.sql',
);

describe('shipment timeline readiness migration', () => {
  const sql = fs.readFileSync(migrationPath, 'utf8');

  test('maps policy gaps and provider endpoint failures to operator-facing summaries', () => {
    expect(sql).toContain('shipment_timeline_operator_summary_v1');
    expect(sql).toContain('Policy configuration needs review');
    expect(sql).toContain('Communication provider endpoint needs configuration');
    expect(sql).toContain('provider_endpoint_invalid');
  });

  test('does not expose raw outbound provider errors in timeline metadata', () => {
    expect(sql).not.toContain("'error_message', oc.error_message");
    expect(sql).toContain("'error_class', public.shipment_timeline_provider_error_class_v1(oc.error_message)");
  });
});
