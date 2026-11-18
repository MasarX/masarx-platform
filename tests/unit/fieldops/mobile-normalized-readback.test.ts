import * as assert from 'node:assert/strict';
import { pendingExpectation, normalizedExpectation, normalizedReadbackMatches as matches } from '../../../apps/fieldops/src/mobile-normalized-readback';
test("strict canonical proof predicate union", () => {
  const e = { action:'tasks.complete', taskId:'task', taskEventId:'event',taskStatus:'completed',routeStopId:'stop',stopKind:'delivery',completionKind:'partial',deliveredBoxNumbers:[1,2],artifactIds:['photo'],signatureArtifactId:'signature',otpConfirmed:true,identityPresent:true,geostampPresent:true,paymentOutcome:'collected',paymentMethod:'cash',collectedAmount:12.5 };
  const r = { task:{id:'task',status:'completed'},task_event_id:'event',shipment_action_id:'action',stop:{id:'stop',kind:'delivery',canonical_status:'delivery_failed',route_stop_outcome:'attempted',delivery_attempt_outcome:'partial_delivery',delivery_attempt_reason:'partial_delivery'},completion:{completion_kind:'partial',delivered_box_numbers:[2,1],payment_collection:{outcome:'collected',method:'cash',collected_amount:'12.50',variance_amount:'2.5',discrepancy_kind:'shortfall',has_discrepancy:true}},proof:{artifact_ids:['photo','signature'],signature_artifact_id:'signature',otp_confirmed:true,identity_present:true,geostamp_present:true} };
  assert.equal(matches(e,r),true);
  const {taskEventId,taskStatus,...pending} = e;
  assert.deepEqual(pendingExpectation(pending),pending);
  assert.equal(normalizedExpectation(pending),null);
  assert.equal(pendingExpectation({taskId:'task'}),null);
  assert.equal(pendingExpectation({...pending,action:'tasks.exception',statusReason:''}),null);
  assert.equal(pendingExpectation({...pending,deliveredBoxNumbers:[null]}),null);
  assert.equal('taskEventId' in pendingExpectation(e)!,false);
  const {stopKind,...withoutKind} = pending;
  assert.deepEqual(pendingExpectation(withoutKind),withoutKind);
  assert.equal(matches({...withoutKind,taskEventId,taskStatus},r),true);
  assert.equal(matches({...withoutKind,taskEventId,taskStatus},{...r,stop:{...r.stop,kind:null}}),false);
  assert.equal(pendingExpectation({action:'tasks.complete',taskId:'task',routeStopId:'stop'}),null);
  assert.equal(matches({action:'tasks.complete',taskId:'task',routeStopId:'stop',taskEventId,taskStatus},r),false);
  for (const bad of [{}, {taskEventId:'event'}, {...e,action:'unknown'},{...e,artifactIds:[]},{...e,artifactIds:['photo',null]},{...e,deliveredBoxNumbers:[1,'2']},{...e,collectedAmount:NaN},{...e,taskId:''},{...e,otpConfirmed:'yes'},{...e,paymentOutcome:undefined}]) assert.equal(normalizedExpectation(bad),null);
  for (const delta of [{taskId:'other'},{taskEventId:'old'},{routeStopId:'other'},{taskStatus:'pending'},{stopKind:'pickup'},{deliveredBoxNumbers:[1]},{artifactIds:['missing']},{signatureArtifactId:'photo'},{collectedAmount:0}]) assert.equal(matches({...e,...delta},r),false);
  assert.equal(matches(e,{...r,shipment_action_id:null}),false);
  for (const delta of [{route_stop_outcome:'completed'},{delivery_attempt_outcome:null},{delivery_attempt_reason:'other'}]) assert.equal(matches(e,{...r,stop:{...r.stop,...delta}}),false);
  for (const delta of [{variance_amount:null},{has_discrepancy:false},{discrepancy_kind:'matched'},{collected_amount:''}]) assert.equal(matches(e,{...r,completion:{...r.completion,payment_collection:{...r.completion.payment_collection,...delta}}}),false);
  assert.equal(matches(e,{...r,proof:{}}),false);
  const failure = {action:'tasks.exception',taskId:'task',taskEventId:'event',taskStatus:'completed',routeStopId:'stop',stopKind:'delivery',statusReason:'no_answer'};
  const failed = {...r,stop:{...r.stop,delivery_attempt_outcome:'not_delivered',delivery_attempt_reason:'customer_not_available',dispatch_exception_reason:'no_answer'}};
  assert.equal(matches(failure,failed),true);
  assert.equal(matches({...failure,statusReason:'customer_not_available'},failed),false);
  assert.equal(matches({...failure,statusReason:''},failed),false);
  const full = {...e,completionKind:'full',deliveredBoxNumbers:[1,2]};
  assert.equal(matches(full,{...r,stop:{...r.stop,canonical_status:'delivered',route_stop_outcome:'completed',delivery_attempt_outcome:'delivered',delivery_attempt_reason:null},completion:{...r.completion,completion_kind:'full'}}),true);
  assert.equal(JSON.stringify(normalizedExpectation({...e,otp:'SECRET',recipient_identity_last4:'SECRET',payload:{secret:'SECRET'}})).includes('SECRET'),false);
  const pickup = {action:'tasks.complete',taskId:'task',taskEventId:'event',taskStatus:'completed',routeStopId:'stop',confirmedQuantity:4,handoverContactPresent:true,handoverNotesPresent:true,receiptContextPresent:true};
  const pickupReceipt = {...r,stop:{id:'stop',kind:'pickup'},pickup:{confirmed_quantity:4,handover_contact_present:true,handover_notes_present:true,receipt_context_present:true}};
  assert.equal(matches(pickup,pickupReceipt),true);
  assert.equal(matches(pickup,{...pickupReceipt,pickup:{...pickupReceipt.pickup,confirmed_quantity:3}}),false);
  assert.equal(matches(pickup,{...pickupReceipt,pickup:{...pickupReceipt.pickup,handover_contact_present:false}}),false);
  assert.equal(matches(pickup,r),false);
  for (const quantity of [0,-1,NaN,1.5,'4']) assert.equal(pendingExpectation({...pickup,confirmedQuantity:quantity}),null);
  assert.equal(pendingExpectation({action:'tasks.complete',taskId:'task',routeStopId:'stop',handoverNotesPresent:true}),null);
  assert.equal(matches({...failure,stopKind:undefined,statusReason:'sender_unavailable'},{...pickupReceipt,stop:{id:'stop',kind:'pickup',dispatch_exception_reason:'sender_unavailable'}}),true);


  // Explicit persisted delivery_attempt.outcome takes precedence over status/completion fallbacks.
  assert.equal(matches(e,{...r,stop:{...r.stop,canonical_status:'delivered'}}),true);
  assert.equal(matches(e,{...r,stop:{...r.stop,canonical_status:'out_for_delivery',delivery_attempt_outcome:'not_delivered',delivery_attempt_reason:'customer_not_available'}}),true);
});
