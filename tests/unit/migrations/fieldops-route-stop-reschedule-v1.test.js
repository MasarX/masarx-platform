const fs = require('fs');
const path = require('path');

const migration = fs.readFileSync(path.resolve(
  __dirname,
  '../../../supabase/migrations/20260914004000_fieldops_route_stop_reschedule_v1.sql',
), 'utf8');
const pgtap = fs.readFileSync(path.resolve(
  __dirname,
  '../../../supabase/tests/pgtap/0zz_f675_route_stop_reschedule_v1.sql',
), 'utf8');

describe('F675 FieldOps route-stop reschedule proposal', () => {
  test('ships browser-safe public/api command and readback contracts', () => {
    for (const name of [
      'ui_propose_route_stop_reschedule_v1',
      'ui_accept_route_stop_reschedule_v1',
    ]) {
      expect(migration).toContain(`CREATE OR REPLACE FUNCTION public.${name}(`);
      expect(migration).toContain(`CREATE OR REPLACE FUNCTION api.${name}(`);
      expect(migration).toContain('p_action_key TEXT,p_resource_key TEXT,p_selection_ids TEXT[] DEFAULT NULL');
      expect(migration).toContain('p_selection_id TEXT DEFAULT NULL,p_selection_count INTEGER DEFAULT NULL');
      expect(migration).toContain("p_params JSONB DEFAULT '{}'::jsonb");
      expect(migration).toContain(
        `GRANT EXECUTE ON FUNCTION api.${name}(TEXT,TEXT,TEXT[],TEXT,INTEGER,JSONB) TO authenticated;`,
      );
    }
    expect(migration).toContain('CREATE OR REPLACE FUNCTION public.ui_get_route_stop_reschedule_readback_v1(');
    expect(migration).toContain('CREATE OR REPLACE FUNCTION api.ui_get_route_stop_reschedule_readback_v1(');
    expect(migration).toContain(
      'GRANT EXECUTE ON FUNCTION api.ui_get_route_stop_reschedule_readback_v1(UUID,UUID,UUID) TO authenticated;',
    );
  });
  test('requires explicit read authority for commands and bounded operator readback', () => {
    expect((migration.match(/assert_capability_v1\('tasks\.read'/g) ?? []).length)
      .toBeGreaterThanOrEqual(3);
    expect(migration).toContain("assert_capability_v1('shipments.write'");
    expect(migration).toContain("v_source_visible:=public.ui_get_resource_v1('tasks',p_source_task_id) IS NOT NULL");
    expect(migration).toContain("v_operator_visible:=public.ui_get_resource_v1('tasks',p_proposal_task_id) IS NOT NULL");
  });

  test('requires the assigned active route-stop executor and derives shipment server-side', () => {
    for (const required of [
      "assert_capability_v1('tasks.complete'",
      "tt.key='route_stop_execute'",
      't.assigned_to=v_actor',
      "lower(t.status) IN ('open','pending','assigned','in_progress')",
      't.completed_at IS NULL AND t.canceled_at IS NULL',
      'FROM public.route_stops_visible_v1 rs',
      "'shipment_id',v_stop.shipment_id",
      "'task_type_key','dispatch_reschedule_delivery'",
      'FROM public.create_task_system_v1(',
      'public.resolve_task_assignee_user_v1',
      'public.assign_task_system_v1',
    ]) expect(migration).toContain(required);
    expect(migration).not.toContain("p_params->>'shipment_id'");
  });

  test('binds proposal replay to actor, retry key, task, stop, shipment, and exact date', () => {
    for (const required of [
      "'fieldops:route-stop-reschedule:propose:'||v_actor||':'||v_retry",
      "v_proposal.metadata->>'source_task_id' IS DISTINCT FROM v_source.id::text",
      "v_proposal.metadata->>'route_stop_id' IS DISTINCT FROM v_stop.id::text",
      "v_proposal.metadata->>'shipment_id' IS DISTINCT FROM v_stop.shipment_id::text",
      "v_proposal.metadata->>'proposed_slot_date' IS DISTINCT FROM v_slot_date::text",
      "RAISE EXCEPTION 'route_stop_reschedule_idempotency_conflict'",
      "ev.event_type='reschedule_proposed'",
    ]) expect(migration).toContain(required);
  });

  test('locks and revalidates the original active route-stop executor before rescheduling', () => {
    for (const required of [
      "assert_capability_v1('shipments.write'",
      "pt.key='dispatch_reschedule_delivery'",
      'FOR UPDATE OF p',
      "st.key='route_stop_execute'",
      "t.assigned_to=(v_proposal.metadata->>'reported_by_user_id')::uuid",
      "lower(t.status) IN ('open','pending','assigned','in_progress')",
      't.completed_at IS NULL AND t.canceled_at IS NULL',
      'FOR UPDATE OF t',
      "v_slot_date:=NULLIF(v_proposal.metadata->>'proposed_slot_date','')::date",
      'public.shipment_amend_cancel_v1(jsonb_build_object(',
      "'operation','reschedule'",
      "'surface','console'",
      "'idempotency_key','fieldops:route-stop-reschedule:accept:'||v_proposal.id",
      "COALESCE((v_amend->>'ok')::boolean,FALSE) IS DISTINCT FROM TRUE",
    ]) expect(migration).toContain(required);
  });

  test('completes through Tasks SSOT and replays immutable action/workflow evidence', () => {
    for (const required of [
      "ev.event_type='status_changed' AND ev.to_status='completed'",
      "ev.payload->>'status_reason'='route_stop_reschedule_accepted'",
      "ev.payload->>'proposal_task_id'=v_proposal.id::text",
      "ev.payload->>'shipment_id'=v_shipment_id::text",
      "ev.payload->>'slot_date'=v_slot_date::text",
      "sa.id=(accepted.payload->>'shipment_action_id')::uuid",
      "'accepted_by_user_id',(accepted.payload->>'accepted_by_user_id')::uuid",
      'public.transition_task_system_v1(',
      "'completed','route_stop_reschedule_accepted'",
      "'proposal_task_id',v_proposal.id",
      "'shipment_action_id',v_action_id",
      "'workflow_run_id',v_workflow_run_id",
      "'slot_date',v_slot_date",
      "set_config('request.jwt.claims',v_prev_claims,true)",
    ]) expect(migration).toContain(required);
    expect(migration).toMatch(
      /public\.transition_task_system_v1\([\s\S]*?'fieldops_route_stop_reschedule',\s*'fieldops:route-stop-reschedule:accept:'\|\|v_proposal\.id\|\|':accepted'\)/,
    );
    expect(migration).toMatch(/ev\.idempotency_key=[^\n]+\n\s+ORDER BY ev\.created_at DESC/);
    expect(migration).not.toMatch(/LIMIT 1\s+AND ev\.idempotency_key/);
    expect(migration).not.toContain("v_proposal.id,v_org,'reschedule_accepted'");
  });

  test('registers exactly the propose and accept commands with least privilege', () => {
    expect(migration).toContain("'key','tasks.propose_route_stop_reschedule'");
    expect(migration).toContain("'key','tasks.accept_route_stop_reschedule'");
    expect(migration).toMatch(/'key','tasks\.propose_route_stop_reschedule'[\s\S]*?'capability','tasks\.complete'/);
    expect(migration).toMatch(/'key','tasks\.accept_route_stop_reschedule'[\s\S]*?'capability','shipments\.write'/);
    expect(migration).not.toContain("'capability','tasks.write'");
    expect(migration).toContain("'ui_command_registry',r.scope_type,r.scope_id");
  });
  test('ships rollback-contained actor, stale-source, failure, and replay integration coverage', () => {
    for (const required of [
      'BEGIN;',
      'ROLLBACK;',
      'unassigned driver identity is denied',
      'reassigned source is denied before shipment mutation',
      'completed source is denied before shipment mutation',
      'same actor and retry replay one proposal/event',
      'same retry with changed date conflicts',
      'failed amend rolls back completion/action/workflow evidence',
      'double acceptance replays immutable completion evidence',
      'double acceptance yields one shipment action',
      'double acceptance yields one workflow',
      'non-owner without operator capabilities cannot read proposal',
      'service transition restores operator claims',
    ]) expect(pgtap).toContain(required);
    expect(pgtap).toMatch(
      /INSERT INTO public\.workflow_runs\([\s\S]*?IF current_setting\('pgtap\.f675_amend_mode',true\)='fail'[\s\S]*?INSERT INTO public\.shipment_actions\(/,
    );
  });
});
