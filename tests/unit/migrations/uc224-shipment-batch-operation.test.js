const fs = require('fs');
const path = require('path');
const root = path.resolve(__dirname, '../../..');
const read = name => fs.readFileSync(path.join(root, name), 'utf8').replace(/\r\n/g, '\n');

describe('UC224 shipment batch operation asynchronous completion contract (not DB execution)', () => {
  test('UC224 binds both returned owned runs before bounded asynchronous completion', () => {
    const pgtap = read('supabase/tests/pgtap/0zz_uc224_shipment_batch_operation_v1.sql');
    const binding = pgtap.slice(pgtap.indexOf('  SELECT array_agg(wr.id ORDER BY wr.id)'),
      pgtap.indexOf('  FOREACH v_workflow_run_id IN ARRAY v_workflow_run_ids LOOP'));
    expect(pgtap.indexOf('second selected shipment is soft-cancelled'))
      .toBeGreaterThan(pgtap.indexOf('PERFORM public.progress_workflow_run(v_workflow_run_id);'));
    expect(pgtap).toContain('UC224 completed batch item lacks immediate persisted cancellation');
    expect(pgtap).toContain('batch shipment delete counts completed and queued items separately');
    expect(binding).toContain("wr.id = NULLIF(item.value->>'workflow_run_id', '')::uuid");
    expect(binding).toContain("wt.name = 'shipment_delete_v1'");
    for (const key of ['shipment_id', 'selection_id'])
      expect(binding).toContain(`item.value->>'${key}' = wr.context->>'shipment_id'`);
    expect(binding).toContain("wr.context->>'shipment_id' IN (v_shipment_one::text, v_shipment_two::text)");
    for (const [key, id] of [['organization_id', 'v_org'], ['client_id', 'v_client'],
      ['sender_id', 'v_sender'], ['requested_by', 'v_user']])
      expect(binding).toContain(`wr.context->>'${key}' = ${id}::text`);
    expect(binding).toContain('HAVING COUNT(*) = 2');
    expect(binding).toContain('COUNT(DISTINCT wr.id) = 2');
    expect(binding).toContain("COUNT(DISTINCT wr.context->>'shipment_id') = 2");
    expect(binding).toContain('cardinality(v_workflow_run_ids) IS DISTINCT FROM 2');
    expect(binding).toContain("RAISE EXCEPTION 'UC224 batch result does not bind two distinct owned canonical workflow runs'");
    expect(pgtap).toMatch(/FOREACH v_workflow_run_id IN ARRAY v_workflow_run_ids LOOP\s+FOR v_attempt IN 1\.\.50 LOOP/);
    expect(pgtap).toContain('PERFORM public.progress_workflow_run(v_workflow_run_id);');
    expect(pgtap).toContain("EXIT WHEN v_run_status IN ('completed', 'failed', 'cancelled', 'blocked', 'waiting');");
    expect(pgtap).toContain("AND wr.workflow_status = 'completed'");
    expect(pgtap).toContain("    '2',\n    'batch shipment delete starts canonical shipment_delete_v1 workflow runs for both shipments'");
    expect(pgtap).toContain('SELECT plan(11);');
    expect(pgtap.match(/RETURN NEXT (?:is|ok|has_function)\(/g)).toHaveLength(11);
    expect(pgtap).toContain('ROLLBACK;');
    expect(pgtap).not.toMatch(/\b(?:skip|todo)\(|UPDATE public\.workflow_runs|run_workflow_engine_worker/i);
  });

  test('append-only batch repair preserves admission and classifies queued acceptance separately', () => {
    const original = read('supabase/migrations/202604081930_uc224_shipment_batch_operation_v1.sql');
    const body = read('supabase/migrations/20261020130000_shipment_batch_queued_results_v1.sql');
    const admission = source => source.slice(source.indexOf('CREATE OR REPLACE FUNCTION public.'),
      source.indexOf('  v_failure_count INT := 0;'));
    expect(admission(body)).toBe(admission(original));
    const guards = source => source.slice(source.indexOf('BEGIN\n  IF v_user_id IS NULL'),
      source.indexOf('          IF v_item_already_processed THEN'));
    expect(guards(body)).toBe(guards(original));
    expect(body).toContain("SELECT pg_advisory_xact_lock(hashtext('20261020130000_shipment_batch_queued_results_v1'))");
    expect(body).toContain("ELSIF v_item_ok AND v_result->>'workflow_status' = 'completed'");
    expect(body).toContain("v_result#>>'{operation_result,status}' = 'cancelled'");
    expect(body).toContain("v_result#>>'{operation_result,operation}' IN ('rescheduled', 'reschedule_no_change')");
    expect(body).toContain("v_result#>>'{operation_result,slot_date}' = v_slot_date::TEXT");
    expect(body).toContain("v_result->>'workflow_status' IN ('pending', 'in_progress', 'running', 'waiting')");
    expect(body).toContain("v_queued_count := v_queued_count + 1;\n            v_item_status := 'queued';");
    expect(body).toContain("'queued_count', v_queued_count");
    expect(body).not.toMatch(/CREATE OR REPLACE FUNCTION (?:api|public)\.shipment_amend_cancel_v1|pg_sleep|UPDATE public\.shipments/);
    expect(body).toContain('SET row_security = on');
    expect(body).toContain('REVOKE ALL ON FUNCTION public.ui_execute_shipment_batch_operation_v1');
    expect(body).toContain('COMMIT;');
  });
});
