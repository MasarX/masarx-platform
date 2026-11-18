import { createOutbox, type KeyValueStore } from "@masarx/mobile-core";
import { createMemoryOutboxStore } from "../mobile-core/memory-outbox-fixture";
import { completionSuccessObserver, rememberCompletionReadback, latestCompletionReadback, verifyCompletionReadback, rememberIncidentReadback, forgetUnqueuedIncident, listIncidentReadbacks, latestIncidentReadback, incidentReadbackMatches, incidentReadbackDisplayState, activateCompletionReadbackScope, invalidateCompletionReadbacks, completionReadbackScopeVersion, completionReadbackScopeMatches, writeCompletionScopedValue, forgetUnqueuedCompletion, syncCompletionOutbox, clearCompletionReadbacks, boundedCompletionRead, resolveVerifiedCompletionScope, rememberAcceptedReturnScan, latestAcceptedReturnScan, rememberPendingReturnScan, latestPendingReturnScan, forgetUnqueuedReturnScan, listReturnScans, returnScanForQueue } from "../../../apps/fieldops/src/mobile-completion-readback-storage";
import { acceptedReturnScan, verifiedReturnScanReceipt } from "../../../apps/fieldops/src/mobile-return-scan";

function memoryKv(): KeyValueStore {
  const values = new Map<string, unknown>();
  return { init: async () => {}, get: async key => values.get(key) ?? null,
    set: async (key, value) => { values.set(key, value); },
    remove: async key => { values.delete(key); }, clear: async () => { const count = values.size; values.clear(); return count; } };
}
const receipt = { version: 1 as const, queueId: "queue", actor: "actor", scope: "tenant",
  taskId: "task", actionKey: "tasks.complete", expected: { action: "tasks.complete", taskId: "task", routeStopId: "stop", completionKind: "full" } };
const response = { status: "task_transitioned", action_key: "tasks.complete", resource_key: "tasks",
  items: [{ task_id: "task", task_event_id: "event", to_status: "completed", status_reason: null }],
  secret: "must-not-be-persisted" };

beforeEach(async () => { await invalidateCompletionReadbacks(); activateCompletionReadbackScope("actor", "tenant"); });

test("incident display treats offline, refetching and failed reads as unverified", () => {
  const success = { isSuccess: true, isFetching: false, isError: false };
  expect(incidentReadbackDisplayState(true, success)).toBe("verified");
  expect(incidentReadbackDisplayState(false, success)).toBe("pending");
  expect(incidentReadbackDisplayState(true, { ...success, isFetching: true })).toBe("pending");
  expect(incidentReadbackDisplayState(true, { ...success, isSuccess: false, isError: true })).toBe("error");
  expect(incidentReadbackDisplayState(false, { ...success, isSuccess: false, isError: true })).toBe("error");
});

test("incident receipt survives offline queue and background sync, then requires matching fresh proof", async () => {
  const ids = {
    source: "4d1fbd36-6b6e-4c35-acc4-5e3ad9043830", stop: "22222222-2222-4222-8222-222222222222",
    artifact: "33333333-3333-4333-8333-333333333333", review: "44444444-4444-4444-8444-444444444444",
    event: "55555555-5555-4555-8555-555555555555", run: "66666666-6666-4666-8666-666666666666",
  };
  const kv = memoryKv(), store = createMemoryOutboxStore(), outbox = createOutbox(store);
  const pending = { version: 1 as const, queueId: "incident-queue", actor: "actor", scope: "tenant",
    taskId: ids.source, routeStopId: ids.stop, artifactIds: [ids.artifact] };
  const args = { p_action_key: "tasks.report_incident", p_resource_key: "tasks",
    p_selection_id: ids.source, p_selection_ids: [ids.source],
    p_params: { retry_key: pending.queueId, artifact_ids: [ids.artifact] } };
  const proof = { source_task: { id: ids.source, status: "in_progress" },
    incident_task: { id: ids.review, task_event_id: ids.event, status: "open" },
    incident: { type: "blocked", summary: "Blocked gate", artifact_ids: [ids.artifact], reported_by_user_id: "actor" },
    route_stop_id: ids.stop, route_run_id: ids.run, secret: "never persist raw proof" };
  await rememberIncidentReadback(kv, pending);
  await outbox.enqueue({ id: pending.queueId, rpc: "ui_report_route_stop_incident_v1", args });
  expect((await latestIncidentReadback(kv, "actor", "tenant", ids.source))?.accepted).toBeUndefined();
  const execute = jest.fn(async () => proof);
  // This is the same adapter used by background location, with no mounted UI callback.
  const result = await syncCompletionOutbox(outbox, execute, kv, async () => ({ actor: "actor", scope: "tenant" }));
  expect(result.succeededIds).toEqual([pending.queueId]);
  expect(execute).toHaveBeenCalledTimes(1);
  expect(await store.get(pending.queueId)).toBeNull();
  const accepted = await latestIncidentReadback(kv, "actor", "tenant", ids.source);
  expect(accepted?.accepted).toEqual({ incidentTaskId: ids.review, taskEventId: ids.event });
  expect(JSON.stringify(accepted)).not.toContain("never persist raw proof");
  expect(accepted && incidentReadbackMatches(proof, accepted)).toBe(true);
  expect(accepted && incidentReadbackMatches({ ...proof, route_stop_id: ids.source }, accepted)).toBe(false);
  expect(await latestIncidentReadback(kv, "other", "tenant", ids.source)).toBeNull();
  expect(await latestIncidentReadback(kv, "actor", "other", ids.source)).toBeNull();
});

test("incident observer rejects wrong actor, target, evidence and malformed results", async () => {
  const source = "4d1fbd36-6b6e-4c35-acc4-5e3ad9043830", stop = "22222222-2222-4222-8222-222222222222";
  const artifact = "33333333-3333-4333-8333-333333333333";
  const pending = { version: 1 as const, queueId: "q", actor: "actor", scope: "tenant", taskId: source, routeStopId: stop, artifactIds: [artifact] };
  const args = { p_action_key: "tasks.report_incident", p_resource_key: "tasks", p_selection_id: source,
    p_selection_ids: [source], p_params: { retry_key: "q", artifact_ids: [artifact] } };
  const proof = { source_task: { id: source, status: "open" }, incident_task: {
    id: "44444444-4444-4444-8444-444444444444", task_event_id: "55555555-5555-4555-8555-555555555555", status: "open" },
    incident: { type: "blocked", summary: "Blocked gate", artifact_ids: [artifact], reported_by_user_id: "actor" }, route_stop_id: stop,
    route_run_id: "66666666-6666-4666-8666-666666666666" };
  for (const [result, readScope] of [
    [proof, async () => ({ actor: "other", scope: "tenant" })],
    [{ ...proof, route_stop_id: source }, async () => ({ actor: "actor", scope: "tenant" })],
    [{ ...proof, incident: { ...proof.incident, artifact_ids: [] } }, async () => ({ actor: "actor", scope: "tenant" })],
    [{ incident_task: { id: "bad" } }, async () => ({ actor: "actor", scope: "tenant" })],
  ] as const) {
    const kv = memoryKv(), store = createMemoryOutboxStore(), outbox = createOutbox(store);
    await rememberIncidentReadback(kv, pending);
    await outbox.enqueue({ id: "q", rpc: "ui_report_route_stop_incident_v1", args });
    await syncCompletionOutbox(outbox, async () => result, kv, readScope);
    expect((await latestIncidentReadback(kv, "actor", "tenant", source))?.accepted).toBeUndefined();
  }
});

test("two incidents on one task retain distinct accepted task, event and evidence proof", async () => {
  const kv = memoryKv(), outbox = createOutbox(createMemoryOutboxStore());
  const source = "4d1fbd36-6b6e-4c35-acc4-5e3ad9043830", stop = "22222222-2222-4222-8222-222222222222";
  const run = "66666666-6666-4666-8666-666666666666";
  const one = { queueId: "A", artifact: "33333333-3333-4333-8333-333333333333",
    review: "44444444-4444-4444-8444-444444444444", event: "55555555-5555-4555-8555-555555555555" };
  const two = { queueId: "B", artifact: "77777777-7777-4777-8777-777777777777",
    review: "88888888-8888-4888-8888-888888888888", event: "99999999-9999-4999-8999-999999999999" };
  for (const item of [one, two]) {
    await rememberIncidentReadback(kv, { version: 1, queueId: item.queueId, actor: "actor", scope: "tenant",
      taskId: source, routeStopId: stop, artifactIds: [item.artifact] });
    await outbox.enqueue({ id: item.queueId, rpc: "ui_report_route_stop_incident_v1", args: {
      p_action_key: "tasks.report_incident", p_resource_key: "tasks", p_selection_id: source,
      p_selection_ids: [source], p_params: { retry_key: item.queueId, artifact_ids: [item.artifact] } } });
  }
  const result = await syncCompletionOutbox(outbox, async (_rpc, args) => {
    const item = args.p_params && (args.p_params as { retry_key: string }).retry_key === "A" ? one : two;
    return { source_task: { id: source, status: "in_progress" },
      incident_task: { id: item.review, task_event_id: item.event, status: "open" },
      incident: { type: "blocked", summary: item.queueId, artifact_ids: [item.artifact], reported_by_user_id: "actor" },
      route_stop_id: stop, route_run_id: run };
  }, kv, async () => ({ actor: "actor", scope: "tenant" }));
  expect(result.succeededIds).toEqual(["A", "B"]);
  expect((await listIncidentReadbacks(kv, "actor", "tenant", source)).map(row => row.accepted)).toEqual([
    { incidentTaskId: one.review, taskEventId: one.event },
    { incidentTaskId: two.review, taskEventId: two.event },
  ]);
});

test("failed second enqueue removes only its draft, preserving the first accepted incident", async () => {
  const kv = memoryKv(), store = createMemoryOutboxStore();
  const source = "4d1fbd36-6b6e-4c35-acc4-5e3ad9043830", stop = "22222222-2222-4222-8222-222222222222";
  const one = { version: 1 as const, queueId: "A", actor: "actor", scope: "tenant", taskId: source,
    routeStopId: stop, artifactIds: ["33333333-3333-4333-8333-333333333333"] };
  await rememberIncidentReadback(kv, one);
  const outbox = createOutbox({ ...store, enqueue: async input => {
    if (input.id === "B") throw new Error("enqueue failed");
    return store.enqueue(input);
  } });
  await outbox.enqueue({ id: "A", rpc: "ui_report_route_stop_incident_v1", args: {
    p_action_key: "tasks.report_incident", p_resource_key: "tasks", p_selection_id: source,
    p_selection_ids: [source], p_params: { retry_key: "A", artifact_ids: one.artifactIds } } });
  await syncCompletionOutbox(outbox, async () => ({
    source_task: { id: source, status: "open" }, incident_task: {
      id: "44444444-4444-4444-8444-444444444444", task_event_id: "55555555-5555-4555-8555-555555555555", status: "open" },
    incident: { type: "blocked", summary: "First", artifact_ids: one.artifactIds, reported_by_user_id: "actor" },
    route_stop_id: stop, route_run_id: "66666666-6666-4666-8666-666666666666",
  }), kv, async () => ({ actor: "actor", scope: "tenant" }));
  const accepted = await listIncidentReadbacks(kv, "actor", "tenant", source);
  expect(accepted[0].accepted).toBeDefined();
  const two = { ...one, queueId: "B", artifactIds: ["77777777-7777-4777-8777-777777777777"] };
  await rememberIncidentReadback(kv, two);
  await expect(outbox.enqueue({ id: "B", rpc: "ui_report_route_stop_incident_v1", args: {} })).rejects.toThrow("enqueue failed");
  if (await outbox.get("B") === null) await forgetUnqueuedIncident(kv, two);
  expect(await listIncidentReadbacks(kv, "actor", "tenant", source)).toEqual(accepted);
});

test("shared production sync adapter records acceptance for a later fresh read", async () => {
  const kv = memoryKv(), store = createMemoryOutboxStore(), outbox = createOutbox(store);
  await rememberCompletionReadback(kv, receipt);
  await outbox.enqueue({ id: "queue", rpc: "ui_execute_command_v1",
    args: { p_action_key: "tasks.complete" } });
  const result = await syncCompletionOutbox(outbox, async () => response, kv, async () => ({ actor: "actor", scope: "tenant" }));
  expect(result.succeededIds).toEqual(["queue"]);
  expect(await store.get("queue")).toBeNull();
  const saved = await latestCompletionReadback(kv, "actor", "tenant", "task");
  expect(saved?.accepted).toEqual({ taskId: "task", taskEventId: "event", status: "completed", reason: null });
  expect(JSON.stringify(saved)).not.toContain("must-not-be-persisted");
  expect(await latestCompletionReadback(kv, "other", "tenant", "task")).toBeNull();
  expect(await latestCompletionReadback(kv, "actor", "other", "task")).toBeNull();
});

test("shared sync adapter also forwards accepted scan results without replaying mutations", async () => {
  const kv = memoryKv(), store = createMemoryOutboxStore(), outbox = createOutbox(store);
  const observer = jest.fn(async () => {});
  const execute = jest.fn(async () => [{ scan_event_id: "4d1fbd36-6b6e-4c35-acc4-5e3ad9043830", created: true }]);
  await outbox.enqueue({ id: "return-scan", rpc: "record_scan_event_v1",
    args: { p_scan: { scan_type: "return_to_branch_intake", idempotency_key: "return-scan" } } });
  const result = await syncCompletionOutbox(outbox, execute, kv,
    async () => ({ actor: "actor", scope: "tenant" }), { onSucceeded: observer });
  expect(result.succeeded).toBe(1);
  expect(observer).toHaveBeenCalledTimes(1);
  expect(observer.mock.calls[0][0].id).toBe("return-scan");
  expect(execute).toHaveBeenCalledTimes(1);
});

test("observation failure never marks accepted execution retryable or replays it", async () => {
  const store = createMemoryOutboxStore(), outbox = createOutbox(store), execute = jest.fn(async () => response);
  await outbox.enqueue({ id: "queue", rpc: "ui_execute_command_v1", args: {} });
  const result = await outbox.sync(execute, { onSucceeded: async () => { throw new Error("storage unavailable"); } });
  expect(result).toMatchObject({ succeeded: 1, failed: 0, dead: 0 });
  await outbox.sync(execute);
  expect(execute).toHaveBeenCalledTimes(1);
});

test("actor switch during observation cannot publish another actor's result", async () => {
  const kv = memoryKv(), store = createMemoryOutboxStore(), outbox = createOutbox(store);
  await rememberCompletionReadback(kv, receipt);
  await outbox.enqueue({ id: "queue", rpc: "ui_execute_command_v1", args: { p_action_key: "tasks.complete" } });
  const currentActor = jest.fn().mockResolvedValueOnce({ actor: "actor", scope: "tenant" }).mockResolvedValueOnce({ actor: "other", scope: "tenant" });
  await outbox.sync(async () => response, { onSucceeded: completionSuccessObserver(kv, currentActor) });
  expect((await latestCompletionReadback(kv, "actor", "tenant", "task"))?.accepted).toBeUndefined();
});

test("wrong target response cannot satisfy the queued expectation", async () => {
  const kv = memoryKv(), store = createMemoryOutboxStore(), outbox = createOutbox(store);
  await rememberCompletionReadback(kv, receipt);
  await outbox.enqueue({ id: "queue", rpc: "ui_execute_command_v1", args: { p_action_key: "tasks.complete" } });
  await outbox.sync(async () => ({ ...response, items: [{ task_id: "other", task_event_id: "event", to_status: "completed" }] }),
    { onSucceeded: completionSuccessObserver(kv, async () => ({ actor: "actor", scope: "tenant" })) });
  expect((await latestCompletionReadback(kv, "actor", "tenant", "task"))?.accepted).toBeUndefined();
});

test("bounded fresh reads wait for persisted evidence and never accept stale actor results", async () => {
  const record = { ...receipt, expected: { action: "tasks.complete", taskId: "task", routeStopId: "stop", completionKind: "full" },
    accepted: { taskId: "task", taskEventId: "event", status: "completed", reason: null } };
  const proof = { task: { id: "task", status: "completed" }, task_event_id: "event",
    shipment_action_id: "action", stop: { id: "stop", kind: "delivery", canonical_status: "delivered", delivery_attempt_outcome: "delivered", route_stop_outcome: "completed" }, completion: { completion_kind: "full" }, proof: {} };
  const read = jest.fn().mockResolvedValueOnce(null).mockResolvedValue(proof);
  expect(await verifyCompletionReadback(record, read, () => true, async () => {})).toBe(true);
  expect(read).toHaveBeenCalledTimes(2);
  let current = true;
  expect(await verifyCompletionReadback(record, async () => { current = false; return proof; }, () => current)).toBeNull();
});

test("missing projection has a finite read budget and read errors never resend", async () => {
  const record = { ...receipt, expected: { action: "tasks.complete", taskId: "task", routeStopId: "stop", completionKind: "full" },
    accepted: { taskId: "task", taskEventId: "event", status: "completed", reason: null } };
  const read = jest.fn(async () => null);
  expect(await verifyCompletionReadback(record, read, () => true, async () => {})).toBe(false);
  expect(read).toHaveBeenCalledTimes(3);
  const failed = jest.fn(async () => { throw new Error("network"); });
  expect(await verifyCompletionReadback(record, failed, () => true)).toBe(false);
  expect(failed).toHaveBeenCalledTimes(1);
});

test("clear during observer network wait cannot resurrect a receipt", async () => {
  const kv = memoryKv(), outbox = createOutbox(createMemoryOutboxStore());
  await rememberCompletionReadback(kv, receipt);
  let release!: (value: { actor: string; scope: string }) => void, entered!: () => void;
  const started = new Promise<void>(resolve => { entered = resolve; });
  const actor = new Promise<{ actor: string; scope: string }>(resolve => { release = resolve; });
  await outbox.enqueue({ id: "queue", rpc: "ui_execute_command_v1", args: { p_action_key: "tasks.complete" } });
  const syncing = outbox.sync(async () => response, { onSucceeded: completionSuccessObserver(kv, () => { entered(); return actor; }) });
  await started;
  await invalidateCompletionReadbacks();
  await kv.clear();
  release({ actor: "actor", scope: "tenant" });
  expect((await syncing).succeeded).toBe(1);
  expect(await latestCompletionReadback(kv, "actor", "tenant", "task")).toBeNull();
});

test("clear drains in-flight remember writes without retaining late target pointers", async () => {
  const kv = memoryKv(), original = kv.set;
  let release!: () => void, entered!: () => void;
  const started = new Promise<void>(resolve => { entered = resolve; });
  const gate = new Promise<void>(resolve => { release = resolve; });
  kv.set = async (key, value) => { entered(); await gate; await original(key, value); };
  const remembering = rememberCompletionReadback(kv, receipt);
  await started;
  const invalidated = invalidateCompletionReadbacks();
  release();
  await expect(remembering).rejects.toThrow("session changed");
  await invalidated;
  await kv.clear();
  expect(await latestCompletionReadback(kv, "actor", "tenant", "task")).toBeNull();
});

test("missing or corrupt frozen proof never verifies based only on accepted event IDs", async () => {
  const kv = memoryKv();
  await expect(rememberCompletionReadback(kv, { ...receipt, expected: {} })).rejects.toThrow("Invalid");
  await rememberCompletionReadback(kv, receipt);
  await kv.set("fieldops:completion-readback:queue", { ...receipt, expected: {},
    accepted: { taskId: "task", taskEventId: "event", status: "completed", reason: null } });
  await expect(latestCompletionReadback(kv, "actor", "tenant", "task")).rejects.toThrow("Invalid");
});

test("proven absent enqueue draft is removed without deleting another target pointer", async () => {
  const kv = memoryKv();
  await rememberCompletionReadback(kv, receipt);
  await rememberCompletionReadback(kv, { ...receipt, queueId: "newer" });
  await forgetUnqueuedCompletion(kv, receipt);
  expect((await latestCompletionReadback(kv, "actor", "tenant", "task"))?.queueId).toBe("newer");
});

test("full clear closes new admission and only reopens verified remaining scope", async () => {
 const kv = memoryKv();
 let release!: () => void, entered!: () => void;
 const started = new Promise<void>(resolve => { entered = resolve; });
 const gate = new Promise<void>(resolve => { release = resolve; });
 const clearing = clearCompletionReadbacks(async () => { entered(); await gate; await kv.clear(); },
  async () => ({ actor:"actor",scope:"tenant" }));
 await started;
 await expect(rememberCompletionReadback(kv,receipt)).rejects.toThrow("session changed");
 await completionSuccessObserver(kv,async () => ({actor:"actor",scope:"tenant"}))(
  {id:"queue",args:{p_action_key:"tasks.complete"}} as any,response);
 release();
 await clearing;
 expect(await latestCompletionReadback(kv,"actor","tenant","task")).toBeNull();
 await rememberCompletionReadback(kv,receipt);
 await clearCompletionReadbacks(() => kv.clear(),async () => null);
 await expect(rememberCompletionReadback(kv,receipt)).rejects.toThrow("session changed");
});
test("never-settling read is aborted and late success cannot become proof", async () => {
 jest.useFakeTimers();
 try {
  let release!: (value: string) => void;
  let signal!: AbortSignal;
  const reading = boundedCompletionRead(s => { signal=s;return new Promise<string>(resolve => {release=resolve;}); },10);
  const failure = expect(reading).rejects.toThrow("timed out");
  await Promise.resolve();
  await jest.advanceTimersByTimeAsync(11);
  await failure;
  expect(signal.aborted).toBe(true);
  release("late success");
 } finally { jest.useRealTimers(); }
});

test("verified background authority rejects user mismatch and uses server scope", async () => {
 const me={user:{id:"actor"},org:{id:"org"},access_scope:{scope_type:"sender",scope_id:"sender"}};
 const client={auth:{getUser:jest.fn(async()=>({data:{user:{id:"actor"}},error:null}))},
  schema:jest.fn(()=>({rpc:jest.fn(()=>({abortSignal:()=>Promise.resolve({data:me,error:null})}))}))};
 expect(await resolveVerifiedCompletionScope(client as any)).toEqual({actor:"actor",scope:JSON.stringify(["org","sender","sender"])});
 me.user.id="other";
 expect(await resolveVerifiedCompletionScope(client as any)).toBeNull();
});
test("clear failure never reopens receipt admission", async () => {
 const kv=memoryKv();
 await expect(clearCompletionReadbacks(async()=>{throw new Error("clear failed");},
  async()=>({actor:"actor",scope:"tenant"}))).rejects.toThrow("clear failed");
 await expect(rememberCompletionReadback(kv,receipt)).rejects.toThrow("session changed");
});

test("failed clear cannot be reopened by a valid observer before a new remember", async () => {
 const kv=memoryKv();
 await rememberCompletionReadback(kv,receipt);
 await expect(clearCompletionReadbacks(async()=>{throw new Error("clear failed");},
  async()=>({actor:"actor",scope:"tenant"}))).rejects.toThrow("clear failed");
 await completionSuccessObserver(kv,async()=>({actor:"actor",scope:"tenant"}))(
  {id:"queue",args:{p_action_key:"tasks.complete"}} as any,response);
 expect((await latestCompletionReadback(kv,"actor","tenant","task"))?.accepted).toBeUndefined();
 await expect(rememberCompletionReadback(kv,{...receipt,queueId:"after-failed-clear"})).rejects.toThrow("session changed");
});
test("accepted return scan survives outbox removal and restart but is scope-isolated", async () => {
 const kv=memoryKv(), store=createMemoryOutboxStore(), outbox=createOutbox(store);
 const scope={actor:"actor",scope:"tenant"};
 const scanId="4d1fbd36-6b6e-4c35-acc4-5e3ad9043830";
 await rememberPendingReturnScan(kv,{...scope,queueId:"return-scan",barcode:"MX-42"});
 await outbox.enqueue({id:"return-scan",rpc:"record_scan_event_v1",
  args:{p_scan:{scan_type:"return_to_branch_intake",idempotency_key:"return-scan",barcode:"MX-42"}}});
 const synced=await syncCompletionOutbox(outbox,async()=>[{scan_event_id:scanId}],kv,async()=>scope,{
  onSucceeded:async(entry,result)=>{
   const accepted=acceptedReturnScan(entry,result,scope.actor);
   if(accepted) await rememberAcceptedReturnScan(kv,scope,accepted);
  },
 });
 expect(synced.succeeded).toBe(1);
 expect(await store.get("return-scan")).toBeNull();
 const restored=await latestAcceptedReturnScan(kv,scope);
 expect(restored).toMatchObject({actor:"actor",queueId:"return-scan",scanEventId:scanId,barcode:"MX-42"});
 expect(await latestAcceptedReturnScan(kv,{actor:"other",scope:"tenant"})).toBeNull();
 expect(await latestAcceptedReturnScan(kv,{actor:"actor",scope:"other"})).toBeNull();
 await invalidateCompletionReadbacks();
 activateCompletionReadbackScope("other","tenant");
 expect(await latestAcceptedReturnScan(kv,{actor:"other",scope:"tenant"})).toBeNull();
 activateCompletionReadbackScope("actor","tenant");
 expect(await latestAcceptedReturnScan(kv,scope)).toEqual(restored);
 const projected={version:1,scan_event_id:scanId,scan_type:"return_to_branch_intake",barcode:"MX-42",
  shipment_id:"22222222-2222-4222-8222-222222222222",
  inventory_movement_id:"33333333-3333-4333-8333-333333333333",
  shipment_action_id:"44444444-4444-4444-8444-444444444444",
  shipment_status:"returned_to_branch",next_action:"reattempt"};
 expect(verifiedReturnScanReceipt(projected,restored!)).toBe(true);
 expect(verifiedReturnScanReceipt({...projected,scan_event_id:"55555555-5555-4555-8555-555555555555"},restored!)).toBe(false);
 await kv.clear();
 expect(await latestAcceptedReturnScan(kv,scope)).toBeNull();
});
test("pending return survives accepted outbox deletion and stays actor/scope isolated", async () => {
 const kv=memoryKv(),scope={actor:"actor",scope:"tenant"};
 const pending={...scope,queueId:"crash-key",barcode:"MX-42"};
 await rememberPendingReturnScan(kv,pending);
 expect(await latestPendingReturnScan(kv,scope)).toEqual(pending);
 expect(await latestPendingReturnScan(kv,{actor:"peer",scope:"tenant"})).toBeNull();
 expect(await latestPendingReturnScan(kv,{actor:"actor",scope:"other"})).toBeNull();
 await invalidateCompletionReadbacks();
 activateCompletionReadbackScope("actor","tenant");
 expect(await latestPendingReturnScan(kv,scope)).toEqual(pending);
 await rememberAcceptedReturnScan(kv,scope,{actor:"actor",queueId:"wrong",barcode:"MX-42",
  scanEventId:"4d1fbd36-6b6e-4c35-acc4-5e3ad9043830"});
 expect(await latestAcceptedReturnScan(kv,scope)).toBeNull();
 await rememberAcceptedReturnScan(kv,scope,{actor:"actor",queueId:"crash-key",barcode:"MX-42",
  scanEventId:"4d1fbd36-6b6e-4c35-acc4-5e3ad9043830"});
 expect(await latestAcceptedReturnScan(kv,scope)).toMatchObject({queueId:"crash-key"});
 await rememberPendingReturnScan(kv,{...pending,queueId:"unsent"});
 await forgetUnqueuedReturnScan(kv,{...pending,queueId:"crash-key"});
 expect((await latestPendingReturnScan(kv,scope))?.queueId).toBe("unsent");
});
test("A remains selectable after offline B and v1 receipt migrates without eviction", async () => {
 const kv=memoryKv(),scope={actor:"actor",scope:"tenant"};
 const aId="4d1fbd36-6b6e-4c35-acc4-5e3ad9043830";
 const bId="22222222-2222-4222-8222-222222222222";
 const key="fieldops:return-scan:v1:"+JSON.stringify(["actor","tenant"]);
 await kv.set(key,{version:1,...scope,queueId:"A",barcode:"MX-A",scanEventId:aId});
 await rememberPendingReturnScan(kv,{...scope,queueId:"B",barcode:"MX-B"});
 expect((await listReturnScans(kv,scope)).map(scan=>scan.queueId)).toEqual(["A","B"]);
 expect((await returnScanForQueue(kv,scope,"A"))?.scanEventId).toBe(aId);
 expect((await returnScanForQueue(kv,scope,"B"))?.scanEventId).toBeUndefined();
 await rememberAcceptedReturnScan(kv,scope,{actor:"actor",queueId:"B",barcode:"MX-B",scanEventId:bId});
 expect((await returnScanForQueue(kv,scope,"A"))?.scanEventId).toBe(aId);
 expect((await returnScanForQueue(kv,scope,"B"))?.scanEventId).toBe(bId);
 expect(await listReturnScans(kv,{actor:"peer",scope:"tenant"})).toEqual([]);
 expect(await listReturnScans(kv,{actor:"actor",scope:"other"})).toEqual([]);
 await invalidateCompletionReadbacks();
 activateCompletionReadbackScope("actor","tenant");
 expect((await returnScanForQueue(kv,scope,"A"))?.scanEventId).toBe(aId);
 for(let n=2;n<102;n++) await rememberPendingReturnScan(kv,{...scope,queueId:"Q"+n,barcode:"MX-"+n});
 await rememberPendingReturnScan(kv,{...scope,queueId:"after-100",barcode:"MX-X"});
 expect((await listReturnScans(kv,scope)).length).toBe(103);
 expect((await returnScanForQueue(kv,scope,"A"))?.scanEventId).toBe(aId);
});
test("offline return queue uses cached verified scope before enqueue and server checks only on read", () => {
 const source=require("fs").readFileSync(require("path").resolve("apps/fieldops/App.tsx"),"utf8");
 const queue=source.slice(source.indexOf("  const queueScan = async"),source.indexOf("  const onBarcodeScanned"));
 expect(queue).toContain("actor: actorId, scope: returnScope");
 expect(queue).not.toContain("resolveVerifiedCompletionScope");
 expect(queue.indexOf("rememberPendingReturnScan")).toBeLessThan(queue.indexOf("outbox.enqueue"));
 expect(source).toContain("queryKey: [\"accepted-return-scan\", actorId, returnScope, selectedReturnQueueId]");
});
test("late A acceptance cannot be overwritten by newer pending B", async () => {
 const kv=memoryKv(),scope={actor:"actor",scope:"tenant"};
 await rememberPendingReturnScan(kv,{...scope,queueId:"A",barcode:"MX-A"});
 await rememberPendingReturnScan(kv,{...scope,queueId:"B",barcode:"MX-B"});
 expect((await listReturnScans(kv,scope)).map(scan=>scan.queueId)).toEqual(["A","B"]);
 await rememberAcceptedReturnScan(kv,scope,{actor:"actor",queueId:"A",barcode:"MX-A",
  scanEventId:"4d1fbd36-6b6e-4c35-acc4-5e3ad9043830"});
 expect((await returnScanForQueue(kv,scope,"A"))?.scanEventId).toBe("4d1fbd36-6b6e-4c35-acc4-5e3ad9043830");
 expect((await returnScanForQueue(kv,scope,"B"))?.scanEventId).toBeUndefined();
});

test("wallet draft set racing sign-out clear cannot resurrect a stale key", async () => {
 const kv=memoryKv();
 const originalSet=kv.set.bind(kv);
 let entered!:()=>void, release!:()=>void;
 const enteredSet=new Promise<void>(resolve=>{entered=resolve;});
 const holdSet=new Promise<void>(resolve=>{release=resolve;});
 kv.set=async(key,value)=>{entered();await holdSet;await originalSet(key,value);};
 const epoch=completionReadbackScopeVersion();
 const writing=writeCompletionScopedValue(kv,epoch,"actor","tenant",
  ()=>kv.set("wallet-request",{key:"stable"}));
 await enteredSet;
 const clearing=clearCompletionReadbacks(()=>kv.clear(),async()=>null);
 release();
 await expect(writing).rejects.toThrow("Completion evidence session changed.");
 await clearing;
 expect(await kv.get("wallet-request")).toBeNull();
 expect(completionReadbackScopeMatches(epoch,"actor","tenant")).toBe(false);
 await expect(writeCompletionScopedValue(kv,epoch,"actor","tenant",
  ()=>kv.set("wallet-request",{key:"late"}))).rejects.toThrow("Completion evidence session changed.");
 expect(await kv.get("wallet-request")).toBeNull();
});

test("wallet accepted receipt set racing sign-out clear cannot reappear", async () => {
 const kv=memoryKv(),epoch=completionReadbackScopeVersion();
 await writeCompletionScopedValue(kv,epoch,"actor","tenant",
  ()=>kv.set("wallet-request",{key:"stable"}));
 let entered!:()=>void,release!:()=>void;
 const enteredSet=new Promise<void>(resolve=>{entered=resolve;});
 const hold=new Promise<void>(resolve=>{release=resolve;});
 const originalSet=kv.set.bind(kv);
 kv.set=async(key,value)=>{entered();await hold;await originalSet(key,value);};
 const writing=writeCompletionScopedValue(kv,epoch,"actor","tenant",
  ()=>kv.set("wallet-request",{key:"stable",taskId:"accepted"}));
 await enteredSet;
 const clearing=clearCompletionReadbacks(()=>kv.clear(),async()=>null);
 release();
 await expect(writing).rejects.toThrow("Completion evidence session changed.");
 await clearing;
 expect(await kv.get("wallet-request")).toBeNull();
});
