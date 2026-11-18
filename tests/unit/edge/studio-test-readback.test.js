const assert = require('node:assert/strict');
let readStudioTest;
beforeAll(async()=>({readStudioTest}=await import('../../../supabase/functions/integration-plugin-studio/studio-test-readback.mjs')));
const source='00000000-0000-4000-8000-000000000001';
const event='00000000-0000-4000-8000-000000000002';
const inbox='00000000-0000-4000-8000-000000000003';
const shipment='00000000-0000-4000-8000-000000000004';
const run='00000000-0000-4000-8000-000000000005';
const step='00000000-0000-4000-8000-000000000006';
function fixture(state='pending') {
  const data={state,source_id:source,external_id:event,inbox_id:inbox,shipment_id:null,workflow_run_id:run,workflow_run_step_id:null,decision_log_ids:[],raw_payload:'SECRET'};
  const rows=[{id:inbox,webhook_source_id:source,external_id:event,raw_payload:'SECRET'}];
  const calls=[];
  return { data, rows, calls, args:{body:{source_id:source,external_id:event},userClient:{rpc:async(name,params)=>{
    calls.push({name,params}); return name==='ui_list_resource_v1'?{data:{items:rows}}:
      params.p_inbox_id===null?{data:{state:'pending',source_id:source,external_id:event}}:{data};
  }}} };
}
test('pending fixed projection never exposes private registry columns',async()=>{
  const f=fixture(); const result=await readStudioTest(f.args);
  assert.equal(result.state,'pending'); assert(!JSON.stringify(result).includes('SECRET'));
  assert.deepEqual(f.calls[1].params.p_filters,{webhook_source_id:source,external_id:event});
});
test('success requires persisted shipment and completed step proof from guarded RPC',async()=>{
  const f=fixture('succeeded'); await assert.rejects(readStudioTest(f.args));
  f.data.shipment_id=shipment; f.data.workflow_run_step_id=step;
  await assert.rejects(readStudioTest(f.args));
  f.data.decision_log_ids=[event];
  assert.equal((await readStudioTest(f.args)).shipment_id,shipment);
});
test('foreign inbox and ambiguous identities fail closed',async()=>{
  const f=fixture(); f.rows[0].webhook_source_id=shipment;
  await assert.rejects(readStudioTest(f.args)); assert.equal(f.calls.length,2);
  f.rows[0].webhook_source_id=source; f.rows.push({...f.rows[0]});
  await assert.rejects(readStudioTest(f.args));
});
test('absent inbox is pending, not terminal success',async()=>{
  const f=fixture(); f.rows.length=0;
  assert.deepEqual(await readStudioTest(f.args),{state:'pending',source_id:source,external_id:event});
  assert.equal(f.calls.length,2);
});
test('rejected upstream errors are sanitized before handler logging',async()=>{
  const f=fixture(); f.args.userClient.rpc=async()=>{throw new Error('PRIVATE TOKEN');};
  await assert.rejects(readStudioTest(f.args),error=>error.message==='studio.test.readback_unavailable' && !JSON.stringify(error).includes('PRIVATE'));
});
test('source eligibility denial prevents even missing-inbox lookup',async()=>{
  const f=fixture(); f.args.userClient.rpc=async()=>({error:new Error('denied')});
  await assert.rejects(readStudioTest(f.args),/studio.test.readback_unavailable/);
});
