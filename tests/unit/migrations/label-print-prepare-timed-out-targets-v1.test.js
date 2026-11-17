const fs = require('fs');
const path = require('path');

const migration = fs.readFileSync(path.resolve(
  __dirname,
  '../../../supabase/migrations/20260920007000_label_print_prepare_timed_out_targets_v1.sql',
), 'utf8').replace(/\r\n/g, '\n');
const effectiveHandlerSource = fs.readFileSync(path.resolve(
  __dirname,
  '../../../supabase/migrations/202603061750_label_print_prepare_async_dispatch_v1.sql',
), 'utf8').replace(/\r\n/g, '\n');
const extractFragment = (name) => migration
  .match(new RegExp(`${name} text := \\$fragment\\$([\\s\\S]*?)\\$fragment\\$;`))?.[1];

describe('label print prepare legacy timeout targets', () => {
  test('patches one exact effective-handler anchor without copying the handler', () => {
    const oldFragment = extractFragment('v_old');
    expect(oldFragment).toBeTruthy();
    expect(effectiveHandlerSource.split(oldFragment).length - 1).toBe(1);
    expect(migration).toContain('pg_get_functiondef(v_target)');
    expect(migration).toContain('label print prepare timed-out target anchor drifted');
    expect(migration).toContain('EXECUTE v_definition');
    expect(migration).not.toContain(
      'CREATE OR REPLACE FUNCTION workflow_handlers.execute_label_print_prepare_v4',
    );
  });

  test('adds only legacy timed-out rows to the existing ready and pending target union', () => {
    const newFragment = extractFragment('v_new');
    expect(newFragment).toBeTruthy();
    expect(newFragment).toContain("operation_result->'ready'");
    expect(newFragment).toContain("operation_result->'pending'");
    expect(newFragment).toContain("operation_result->'timed_out'");
    expect(newFragment).not.toContain("operation_result->'out_of_scope'");
    expect(newFragment).not.toContain("operation_result->'invalid_boxes'");
  });

  // Native bulk coverage remains unavailable with the provisioning adapter.
});
