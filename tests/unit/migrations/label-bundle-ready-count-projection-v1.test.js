const fs = require('fs');
const path = require('path');

const migration = fs.readFileSync(path.resolve(
  __dirname,
  '../../../supabase/migrations/20260920006000_label_bundle_ready_count_projection_v1.sql',
), 'utf8');
const nativeBulkTest = fs.readFileSync(path.resolve(
  __dirname,
  '../../integration/workflows/labels-print-webhook.test.js',
), 'utf8');
const effectiveHandlerSource = fs.readFileSync(path.resolve(
  __dirname,
  '../../../supabase/migrations/202603062010_label_bundle_edge_callback_progress_v1.sql',
), 'utf8').replace(/\r\n/g, '\n');

const extractFragment = (name) => migration
  .match(new RegExp(`${name} text := \\$fragment\\$([\\s\\S]*?)\\$fragment\\$;`))?.[1]
  ?.replace(/\r\n/g, '\n');

describe('label bundle ready-count projection', () => {
  test('patches the effective handler at two exact guarded anchors', () => {
    expect(migration).toContain("pg_get_functiondef(v_target)");
    expect(migration).toContain("label bundle ready-count initial anchor drifted");
    expect(migration).toContain("label bundle ready-count refreshed anchor drifted");
    expect(migration.match(/v_counts := jsonb_set\(/g)).toHaveLength(2);
    expect(migration).toContain("'{ready}'");
    expect(migration).not.toContain("'{pending}'");
  });

  test('both guarded anchors match the effective handler exactly once', () => {
    for (const name of ['v_initial_old', 'v_refreshed_old']) {
      const fragment = extractFragment(name);
      expect(fragment).toBeTruthy();
      expect(effectiveHandlerSource.split(fragment).length - 1).toBe(1);
    }
  });

  test('preserves the effective handler instead of copying it into migration history', () => {
    expect(migration).not.toContain(
      'CREATE OR REPLACE FUNCTION workflow_handlers.execute_label_bundle_v1',
    );
    expect(migration).toContain('EXECUTE v_definition');
    expect(migration).toContain('position(v_initial_new IN v_definition)');
    expect(migration).toContain('position(v_refreshed_new IN v_definition)');
  });

  test('native bulk coverage requires count and canonical-array agreement', () => {
    expect(nativeBulkTest).toContain(
      'expect(state.counts?.ready).toBe(ready.length);',
    );
    expect(nativeBulkTest).toContain(
      'expect(state.counts?.out_of_scope).toBe(outOfScope.length);',
    );
    expect(nativeBulkTest).toContain(
      'expect(state.counts?.invalid_box_requests).toBe(invalidBoxes.length);',
    );
  });
});
