const fs = jest.requireActual('fs');
const path = jest.requireActual('path');

const readMigration = (name) => fs.readFileSync(path.resolve(
  __dirname, '../../../supabase/migrations', name,
), 'utf8').replace(/\r\n/g, '\n');
const migration = readMigration('20261020180000_label_print_http_error_consumers_v1.sql');
const execute = readMigration('202603063330_label_print_execute_commit_async_v1.sql');
const ui = readMigration('202603071300_ui_get_workflow_run_output_status_v13_split_return_object.sql');
const outputGuard = readMigration('20260910001000_failed_print_output_admission_v1.sql')
  .match(/guard TEXT := \$guard\$([\s\S]*?)\$guard\$;/)[1];
const effectiveUi = ui.replace('  v_ready_source := v_output_source;',
  `${outputGuard}\n  v_ready_source := v_output_source;`);

const fragment = (name) => migration.match(
  new RegExp(`${name} text := \\$fragment\\$([\\s\\S]*?)\\$fragment\\$;`),
)[1];

describe('label print HTTP error consumers', () => {
  test.each([
    ['v_direct', execute], ['v_poll', execute],
    ['v_execute', effectiveUi], ['v_bundle', effectiveUi],
  ])('%s patches one exact effective-function anchor and reobserves it', (name, source) => {
    expect(source.split(fragment(`${name}_old`))).toHaveLength(2);
    expect(migration).toContain(`position(${name}_new IN v_definition)`);
    expect(migration).toContain(`length(replace(v_definition, ${name}_old, ''))`);
    const replacement = fragment(`${name}_new`);
    expect(replacement).toContain('NOT BETWEEN 200 AND 299');
    expect(replacement).toContain("'error', 'label_print_execute_http_error'");
    expect(replacement).toContain("'http_status', COALESCE(");
    expect(replacement).not.toMatch(/->>?'(?:message|headers|error)'/);
  });

  test('keeps incomplete and successful receipts on their existing paths', () => {
    const direct = fragment('v_direct_new');
    expect(direct).toContain("COALESCE((v_execute_response->>'completed')::boolean, false)");
    expect(direct).toContain("ELSE COALESCE(v_execute_response->'body', '{}'::jsonb)");
    expect(fragment('v_poll_new')).toContain("ELSE COALESCE(v_http_body, '{}'::jsonb)");
    for (const [name, completed, body, response] of [
      ['v_execute', 'v_execute_async_completed', 'v_execute_async_body', 'v_execute_async_response'],
      ['v_bundle', 'v_async_completed', 'v_async_body', 'v_async_response'],
    ]) {
      const replacement = fragment(`${name}_new`);
      expect(replacement).toContain(`IF ${completed}\n`);
      expect(replacement).toContain(`${body} := ${response}->'body';`);
      expect(replacement).toContain(`jsonb_set(${response}, '{body}', ${body})`);
    }
  });

  test('preserves later output-admission, authority and fresh-artifact guards byte-for-byte', () => {
    let repairedExecute = execute;
    let repairedUi = effectiveUi;
    for (const name of ['v_direct', 'v_poll']) {
      repairedExecute = repairedExecute.replace(fragment(`${name}_old`), fragment(`${name}_new`));
    }
    for (const name of ['v_execute', 'v_bundle']) {
      repairedUi = repairedUi.replace(fragment(`${name}_old`), fragment(`${name}_new`));
    }
    expect(repairedUi).toContain(outputGuard);
    expect(repairedUi).toContain("public.assert_capability_v1('workflow_runs.read', v_scope_type, v_scope_id)");
    expect(repairedUi).toContain('v_run_org_id IS DISTINCT FROM v_org_id');
    expect(repairedExecute).toContain("v_fresh_state := public.resolve_label_print_fresh_scope_v1(p_step.id, v_targets)");
    expect(repairedExecute).toContain("v_response.retry_attempt := LEAST(p_step.retry_attempt + 1, p_step.max_retries)");
    expect(repairedExecute).toContain("v_execute_request_id_text := COALESCE(");
    expect(migration).toContain('pg_advisory_xact_lock');
    expect(migration).not.toMatch(/CREATE OR REPLACE FUNCTION|GRANT |REVOKE |check_async_response|dispatch_api_request/);
  });
});
