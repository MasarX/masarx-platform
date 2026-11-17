import { parseFinancialTaskContext, resolveFinancialTaskSchema, financialTaskPayload, financialReadbackMatches, financialCompletionExpectation } from '../../../apps/fieldops/src/mobile-financial-task-contract';
import { createOutbox } from '@masarx/mobile-core';
import { createMemoryOutboxStore } from '../mobile-core/memory-outbox-fixture';
import { activateCompletionReadbackScope, invalidateCompletionReadbacks, rememberCompletionReadback, latestCompletionReadback, syncCompletionOutbox } from '../../../apps/fieldops/src/mobile-completion-readback-storage';
const context={version:1,actor_id:'actor',organization_id:'org',task_id:'task',task_type_key:'configured-type',settlement_id:'batch',task_status:'pending',
  amount_contract:{version:1,field:'amount',minimum:0},requires_session:true,required_session_type:'configured-session',sessions:[{id:'session',session_type:'configured-session',branch_id:null,opened_at:'2026-09-01'}]};
const evidenceContract={version:1,supervisor_name:'optional_annotation',photo_artifact_id:'optional_owned_task_photo'};
test('optional evidence requires matching context and exact configured variant, never cashier fallback',()=>{
 const enabled=parseFinancialTaskContext({...context,evidence_contract:evidenceContract},'actor','org','task')!;
 const amount={key:'amount',type:'number',required:true,label:'Amount'};
 const annotation={key:'supervisor_name',type:'text',required:false,label:'Supervisor annotation (optional)'};
 const variant={normalization:'financial_amount_v1',title:'Amount',description:'Record amount',evidence_contract:evidenceContract,fields:[amount,annotation]};
 const schema={task_type_overrides:{'configured-type':variant}};
 expect(resolveFinancialTaskSchema(schema,enabled)?.fields).toEqual([amount,annotation]);
 expect(resolveFinancialTaskSchema(schema,parseFinancialTaskContext(context,'actor','org','task')!)).toBeNull();
 for(const delta of [{fields:[amount]},{fields:[amount,{...annotation,required:true}]},{fields:[amount,{...annotation,key:'approver_id'}]},{evidence_contract:null}])
  expect(resolveFinancialTaskSchema({task_type_overrides:{'configured-type':{...variant,...delta}}},enabled)).toBeNull();
 for(const capability of [{...evidenceContract,version:2},{...evidenceContract,photo_artifact_id:'required'},{...evidenceContract,approver:true}])
  expect(parseFinancialTaskContext({...context,evidence_contract:capability},'actor','org','task')).toBeNull();
});
test('optional annotation and photo preserve amount-only omission and cannot widen unconfigured task payloads',()=>{
 const enabled=parseFinancialTaskContext({...context,evidence_contract:evidenceContract},'actor','org','task')!;
 const disabled=parseFinancialTaskContext(context,'actor','org','task')!;
 expect(financialTaskPayload('0','session',enabled)).toEqual({amount:0,ops_session_id:'session'});
 expect(financialTaskPayload('0','session',enabled,{supervisorName:'  Sam  ',photoArtifactId:'photo'}))
  .toEqual({amount:0,ops_session_id:'session',supervisor_name:'Sam',photo_artifact_id:'photo'});
 expect(financialTaskPayload('0','session',enabled,{supervisorName:' '})).toEqual({amount:0,ops_session_id:'session'});
 expect(()=>financialTaskPayload('0','session',disabled,{photoArtifactId:'photo'})).toThrow();
 expect(()=>financialTaskPayload('0','session',disabled,{supervisorName:'Sam'})).toThrow();
});
test('persisted financial expectation retains exact optional event annotation and photo for replay readback',()=>{
 const expected={kind:'financial_amount_v1',action:'tasks.complete',taskId:'task',taskEventId:'event',taskStatus:'completed',actorId:'actor',organizationId:'org',settlementId:'batch',opsSessionId:null,sessionType:null,amount:0,supervisorName:'Sam',photoArtifactId:'photo'};
 const persisted=financialCompletionExpectation(expected)!;
 expect(persisted).toMatchObject({supervisorName:'Sam',photoArtifactId:'photo'});
 const proof={version:1,actor_id:'actor',organization_id:'org',task_id:'task',task_event_id:'event',task_status:'completed',event_status:'completed',settlement_id:'batch',ops_session_id:null,session_type:null,amount:0,settlement_status:'pending',supervisor_name:'Sam',photo_artifact_id:'photo'};
 expect(financialReadbackMatches({...expected,...persisted},proof)).toBe(true);
 for(const delta of [{supervisor_name:null},{supervisor_name:'Other'},{photo_artifact_id:null},{photo_artifact_id:'other'},{task_event_id:'other'}])
  expect(financialReadbackMatches(expected,{...proof,...delta})).toBe(false);
 expect(financialCompletionExpectation({...expected,photoArtifactId:42})).toBeNull();
 expect(financialReadbackMatches({...expected,supervisorName:undefined,photoArtifactId:undefined},proof)).toBe(false);
});
test('context binds actor, organization, task and rejects malformed session list',()=>{
 expect(parseFinancialTaskContext(context,'actor','org','task')).not.toBeNull();
 for(const delta of [{actor_id:'other'},{organization_id:'other'},{task_id:'other'},{version:2},{amount_contract:{}},{sessions:[...context.sessions,...context.sessions]},{sessions:[{...context.sessions[0],session_type:'wrong'}]}]){
  expect(parseFinancialTaskContext({...context,...delta},'actor','org','task')).toBeNull();
 }
});
test('financial proof binds accepted event, session, amount and batch without claiming finalized settlement',()=>{
 const expected={kind:'financial_amount_v1',action:'tasks.complete',taskId:'task',taskEventId:'event',taskStatus:'completed',actorId:'actor',organizationId:'org',settlementId:'batch',opsSessionId:'session',sessionType:'cashier',amount:0};
 const proof={version:1,actor_id:'actor',organization_id:'org',task_id:'task',task_event_id:'event',task_status:'completed',event_status:'completed',settlement_id:'batch',ops_session_id:'session',session_type:'cashier',amount:0,settlement_status:'pending'};
 expect(financialReadbackMatches(expected,proof)).toBe(true);
 for(const delta of [{actor_id:'other'},{organization_id:'other'},{task_event_id:'other'},{settlement_id:'other'},{ops_session_id:'other'},{amount:'0'},{amount:1},{settlement_status:null}]) expect(financialReadbackMatches(expected,{...proof,...delta})).toBe(false);
});
test('one production outbox observer handles route and financial records without replay or a second store',async()=>{
 const values=new Map<string,unknown>();
 const kv={init:async()=>{},get:async(key:string)=>values.get(key)??null,set:async(key:string,value:unknown)=>{values.set(key,value);},remove:async(key:string)=>{values.delete(key);},clear:async()=>{const count=values.size;values.clear();return count;}};
 const scope=JSON.stringify(['org','tenant','org']);
 await invalidateCompletionReadbacks();activateCompletionReadbackScope('actor',scope);
 const outbox=createOutbox(createMemoryOutboxStore());
 const financial={kind:'financial_amount_v1',action:'tasks.complete',taskId:'financial',settlementId:'batch',opsSessionId:'session',sessionType:'cashier',amount:0};
 const route={action:'tasks.complete',taskId:'route',routeStopId:'stop',completionKind:'full'};
 for(const expected of [financial,route]){
  await rememberCompletionReadback(kv,{version:1,queueId:expected.taskId,actor:'actor',scope,taskId:expected.taskId,actionKey:'tasks.complete',expected});
  await outbox.enqueue({id:expected.taskId,rpc:'ui_execute_command_v1',args:{p_action_key:'tasks.complete',p_selection:{id:expected.taskId}}});
 }
 const execute=jest.fn(async(_rpc:string,args:Record<string,unknown>)=>({status:'task_transitioned',resource_key:'tasks',action_key:'tasks.complete',items:[{task_id:(args.p_selection as {id:string}).id,task_event_id:'event-'+(args.p_selection as {id:string}).id,to_status:'completed',status_reason:null}]}));
 expect((await syncCompletionOutbox(outbox,execute,kv,async()=>({actor:'actor',scope}))).succeeded).toBe(2);
 for(const task of ['financial','route']) expect((await latestCompletionReadback(kv,'actor',scope,task))?.accepted?.taskEventId).toBe('event-'+task);
 await syncCompletionOutbox(outbox,execute,kv,async()=>({actor:'actor',scope}));expect(execute).toHaveBeenCalledTimes(2);
 await invalidateCompletionReadbacks();
 await expect(rememberCompletionReadback(kv,{version:1,queueId:'after',actor:'actor',scope,taskId:'financial',actionKey:'tasks.complete',expected:financial})).rejects.toThrow();
});
test('matched schema cannot fall back to delivery or inject other fields',()=>{
 const valid=parseFinancialTaskContext(context,'actor','org','task')!;
 const variant={normalization:'financial_amount_v1',title:'Amount',description:'Record task amount',fields:[{key:'amount',type:'number',required:true,label:'Amount'}]};
 const schema={task_type_overrides:{'configured-type':variant}};
 expect(resolveFinancialTaskSchema(schema,valid)?.fields).toEqual(variant.fields);
 expect(resolveFinancialTaskSchema({},valid)).toBeNull();
 expect(resolveFinancialTaskSchema({task_type_overrides:{'configured-type':{...variant,fields:[...variant.fields,{key:'recipient'}]}}},valid)).toBeNull();
});
test('payload preserves zero and excludes delivery fields; requires selected eligible session',()=>{
 const valid=parseFinancialTaskContext(context,'actor','org','task')!;
 expect(financialTaskPayload('0','session',valid)).toEqual({amount:0,ops_session_id:'session'});
 expect(financialTaskPayload('12.125','session',valid).amount).toBe(12.125);
 for(const amount of ['',' ','-1','NaN','Infinity']) expect(()=>financialTaskPayload(amount,'session',valid)).toThrow();
 expect(()=>financialTaskPayload('1','other',valid)).toThrow();
});
test('optional-session policy retains amount-only completion and null accepted session lineage',()=>{
 const optional=parseFinancialTaskContext({...context,requires_session:false,required_session_type:null,sessions:[]},'actor','org','task');
 expect(optional).not.toBeNull();
 expect(financialTaskPayload('0','ignored',optional!)).toEqual({amount:0});
 expect(parseFinancialTaskContext({...context,required_session_type:'CONFIGURED-SESSION'},'actor','org','task')).toBeNull();
 const expected={kind:'financial_amount_v1',action:'tasks.complete',taskId:'task',taskEventId:'event',taskStatus:'completed',actorId:'actor',organizationId:'org',settlementId:'batch',opsSessionId:null,sessionType:null,amount:0};
 expect(financialReadbackMatches(expected,{version:1,actor_id:'actor',organization_id:'org',task_id:'task',task_event_id:'event',task_status:'completed',event_status:'completed',settlement_id:'batch',ops_session_id:null,session_type:null,amount:0,settlement_status:'pending'})).toBe(true);
});
