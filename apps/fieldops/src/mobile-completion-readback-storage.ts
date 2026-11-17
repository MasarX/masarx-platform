import type { createMobileClient } from "@masarx/auth/mobile";
import type { KeyValueStore, OutboxEntry, OutboxSyncOptions, OutboxSyncResult, RpcExecutor } from "@masarx/mobile-core";
import type { AcceptedReturnScan } from "./mobile-return-scan";
import { pendingExpectation, normalizedReadbackMatches } from "./mobile-normalized-readback";
import { financialCompletionExpectation, financialReadbackMatches } from "./mobile-financial-task-contract";
const completionExpectation = (value: unknown) => object(value).kind === "financial_amount_v1" ? financialCompletionExpectation(value) : pendingExpectation(value);

type RecordValue = Record<string, unknown>;
const object = (value: unknown): RecordValue => value && typeof value === "object" && !Array.isArray(value) ? value as RecordValue : {};
const text = (value: unknown) => typeof value === "string" ? value.trim() : "";
const recordKey = (queueId: string) => "fieldops:completion-readback:" + queueId;
const targetKey = (actor: string, scope: string, taskId: string) =>
  "fieldops:completion-readback-target:" + JSON.stringify([actor, scope, taskId]);
const returnScanKey = (actor: string, scope: string) =>
  "fieldops:return-scan:v1:" + JSON.stringify([actor, scope]);

// Same generation + serialized-KV pattern as mobile-pending-evidence; network is never held by the write lane.
let generation = 0;
let activeIdentity = "";
let pristineColdAdmission = true;
let clearing = 0;
let writes: Promise<unknown> = Promise.resolve();
const identity = (actor: string, scope: string) => JSON.stringify([actor, scope]);
function assertCurrent(epoch: number, actor: string, scope: string) {
  if (clearing > 0 || epoch !== generation || activeIdentity !== identity(actor, scope)) throw new Error("Completion evidence session changed.");
}
function write<T>(epoch: number, actor: string, scope: string, operation: () => Promise<T>): Promise<T> {
  const next = writes.then(async () => { assertCurrent(epoch, actor, scope); return operation(); });
  writes = next.catch(() => undefined);
  return next;
}
export function activateCompletionReadbackScope(actor: string, scope: string) {
  if (clearing > 0) return;
  pristineColdAdmission = false;
  const next = identity(actor, scope);
  if (activeIdentity !== next) { generation += 1; activeIdentity = next; }
}
export const completionReadbackScopeVersion = () => generation;
export function invalidateCompletionReadbacks() {
  pristineColdAdmission = false;
  generation += 1;
  activeIdentity = "";
  return writes.then(() => undefined);
}
export function completionReadbackScopeMatches(epoch: number, actor: string, scope: string) {
  try { assertCurrent(epoch, actor, scope); return true; }
  catch { return false; }
}
// Wallet KV uses the same generation and serialized write lane as completion evidence.
// Sign-out clear waits for an in-flight set/remove before clearing local state.
export async function writeCompletionScopedValue<T>(
  store: KeyValueStore, epoch: number, actor: string, scope: string, operation: () => Promise<T>,
): Promise<T> {
  await store.init();
  return write(epoch, actor, scope, async () => {
    const result = await operation();
    assertCurrent(epoch, actor, scope);
    return result;
  });
}

export type CompletionReadbackRecord = {
  version: 1;
  queueId: string;
  actor: string;
  scope: string;
  taskId: string;
  actionKey: string;
  expected: RecordValue;
  accepted?: { taskId: string; taskEventId: string; status: string; reason: string | null };
};

// Call only with an explicitly whitelisted, non-secret expectation, never raw args.
export async function rememberCompletionReadback(store: KeyValueStore, record: CompletionReadbackRecord) {
  const expected = completionExpectation(record.expected);
  if (!expected || expected.action !== record.actionKey || expected.taskId !== record.taskId
    || !record.actor || !record.scope || !record.queueId || record.accepted) throw new Error("Invalid completion evidence.");
  const epoch = generation;
  await store.init();
  await write(epoch, record.actor, record.scope, async () => {
    await store.set(recordKey(record.queueId), { ...record, expected });
    assertCurrent(epoch, record.actor, record.scope);
    try {
      await store.set(targetKey(record.actor, record.scope, record.taskId), record.queueId);
    } catch (error) {
      // No enqueue occurred yet; these keys belong exclusively to this new queue ID.
      const key = targetKey(record.actor, record.scope, record.taskId);
      if (await store.get(key) === record.queueId) await store.remove(key);
      await store.remove(recordKey(record.queueId));
      throw error;
    }
  });
}

export async function forgetUnqueuedCompletion(store: KeyValueStore, record: CompletionReadbackRecord) {
  const epoch = generation;
  await write(epoch, record.actor, record.scope, async () => {
    const key = targetKey(record.actor, record.scope, record.taskId);
    if (await store.get(key) === record.queueId) await store.remove(key);
    await store.remove(recordKey(record.queueId));
  });
}

export type CompletionScope = { actor: string; scope: string };
export type PendingReturnScan = CompletionScope & { queueId: string; barcode: string };
export type ReturnScanRecord = PendingReturnScan & { scanEventId?: string };
// ponytail: keep all unresolved receipts; add proof-bound archival if device storage grows materially.
function returnScans(value: unknown, verified: CompletionScope): ReturnScanRecord[] {
 const saved = object(value);
 const rows = saved.version === 2 && Array.isArray(saved.scans) ? saved.scans :
   saved.version === 1 ? [saved] : [];
 return rows.map(object).filter(row => row.actor === verified.actor && row.scope === verified.scope &&
   text(row.queueId) && text(row.barcode) && (!row.scanEventId || text(row.scanEventId)))
   .map(row => ({actor:verified.actor,scope:verified.scope,queueId:text(row.queueId),
     barcode:text(row.barcode),...(text(row.scanEventId) ? {scanEventId:text(row.scanEventId)} : {})}));
}
export async function listReturnScans(store: KeyValueStore, verified: CompletionScope): Promise<ReturnScanRecord[]> {
 await store.init();
 return returnScans(await store.get(returnScanKey(verified.actor,verified.scope)),verified);
}
export async function returnScanForQueue(
 store: KeyValueStore, verified: CompletionScope, queueId: string,
): Promise<ReturnScanRecord | null> {
 return (await listReturnScans(store,verified)).find(scan => scan.queueId === queueId) ?? null;
}
export async function rememberPendingReturnScan(store: KeyValueStore, pending: PendingReturnScan) {
 if (!pending.actor || !pending.scope || !pending.queueId || !text(pending.barcode))
   throw new Error("Invalid pending return scan.");
 const epoch = generation;
 await store.init();
 await write(epoch, pending.actor, pending.scope, async () => {
  const key = returnScanKey(pending.actor,pending.scope);
  const scans = returnScans(await store.get(key),pending);
  if (scans.some(scan => scan.queueId === pending.queueId)) throw new Error("Duplicate return queue key.");
  await store.set(key,{version:2,scans:[...scans,pending]});
  assertCurrent(epoch,pending.actor,pending.scope);
 });
}
export async function latestPendingReturnScan(store: KeyValueStore, verified: CompletionScope): Promise<PendingReturnScan | null> {
 const scans = await listReturnScans(store,verified);
 const found = scans.findLast(scan => !scan.scanEventId);
 return found ? {actor:found.actor,scope:found.scope,queueId:found.queueId,barcode:found.barcode} : null;
}
export async function forgetUnqueuedReturnScan(store: KeyValueStore, pending: PendingReturnScan) {
 const epoch = generation;
 await write(epoch,pending.actor,pending.scope,async () => {
  const key = returnScanKey(pending.actor,pending.scope);
  const scans = returnScans(await store.get(key),pending);
  await store.set(key,{version:2,scans:scans.filter(scan => scan.queueId !== pending.queueId ||
    scan.barcode !== pending.barcode || Boolean(scan.scanEventId))});
  assertCurrent(epoch,pending.actor,pending.scope);
 });
}
export async function rememberAcceptedReturnScan(
 store: KeyValueStore, verified: CompletionScope, accepted: AcceptedReturnScan,
) {
 if (!verified.actor || !verified.scope || accepted.actor !== verified.actor ||
   !accepted.queueId || !accepted.scanEventId || !accepted.barcode) throw new Error("Invalid return scan identity.");
 const epoch = generation;
 await store.init();
 await write(epoch,verified.actor,verified.scope,async () => {
  const key = returnScanKey(verified.actor,verified.scope);
  const scans = returnScans(await store.get(key),verified);
  const index = scans.findIndex(scan => scan.queueId === accepted.queueId && scan.barcode === accepted.barcode &&
    (!scan.scanEventId || scan.scanEventId === accepted.scanEventId));
  if (index < 0) return;
  scans[index] = {...scans[index],scanEventId:accepted.scanEventId};
  await store.set(key,{version:2,scans});
  assertCurrent(epoch,verified.actor,verified.scope);
 });
}
export async function latestAcceptedReturnScan(store: KeyValueStore, verified: CompletionScope): Promise<AcceptedReturnScan | null> {
 const scans = await listReturnScans(store,verified);
 const found = scans.findLast(scan => Boolean(scan.scanEventId));
 return found?.scanEventId ? {actor:found.actor,queueId:found.queueId,scanEventId:found.scanEventId,
   barcode:found.barcode} : null;
}
export async function boundedCompletionRead<T>(
 read: (signal: AbortSignal) => PromiseLike<T>, timeoutMs = 5000,
): Promise<T> {
 const controller = new AbortController();
 let timer: ReturnType<typeof setTimeout> | undefined;
 try {
  return await Promise.race([
   Promise.resolve().then(() => read(controller.signal)),
   new Promise<never>((_, reject) => {
    timer = setTimeout(() => { reject(Object.assign(new Error("Completion read timed out."), { code: "ETIMEDOUT" })); controller.abort(); }, timeoutMs);
   }),
  ]);
 } finally { if (timer !== undefined) clearTimeout(timer); controller.abort(); }
}
export function completionScopeFromMe(input: unknown, actor: string): CompletionScope | null {
 const me=object(input),user=object(me.user),org=object(me.org),access=object(me.access_scope);
 if (user.id!==actor || !text(org.id) || !text(access.scope_type)) return null;
 return {actor,scope:JSON.stringify([text(org.id),text(access.scope_type).toLowerCase(),text(access.scope_id)||null])};
}
export async function resolveVerifiedCompletionScope(client: ReturnType<typeof createMobileClient>): Promise<CompletionScope | null> {
 const first = await boundedCompletionRead(() => client.auth.getUser());
 if (first.error || !first.data.user) return null;
 const result = await boundedCompletionRead(signal => client.schema("api").rpc("ui_me_v1").abortSignal(signal));
 if (result.error) throw result.error;
 const actor = first.data.user.id;
 const verifiedScope = completionScopeFromMe(result.data,actor);
 if (!verifiedScope) return null;
 const final = await boundedCompletionRead(() => client.auth.getUser());
 if (final.error || final.data.user?.id !== actor) return null;
 return verifiedScope;
}
export async function clearCompletionReadbacks<T>(
 operation: () => Promise<T>, readScope: () => Promise<CompletionScope | null>,
): Promise<T> {
 clearing += 1;
 await invalidateCompletionReadbacks();
 const epoch = generation;
 let completed = false;
 try { const result = await operation(); completed = true; return result; }
 finally {
  let verified: CompletionScope | null = null;
  try { if (completed) verified = await readScope(); }
  finally {
   clearing -= 1;
   if (!clearing && epoch === generation && verified) activateCompletionReadbackScope(verified.actor,verified.scope);
  }
 }
}
export function completionSuccessObserver(store: KeyValueStore, readScope: () => Promise<CompletionScope | null>) {
 return async (entry: OutboxEntry, result: unknown) => {
  const epoch = generation;
  if (clearing || !["tasks.complete","tasks.exception"].includes(text(entry.args.p_action_key))) return;
  const verified = await readScope();
  if (!verified || clearing || epoch !== generation) return;
  // Cold background scope is derived from fresh authenticated authority, never the saved receipt.
  if (!activeIdentity) {
   if (!pristineColdAdmission) return;
   pristineColdAdmission = false;
   activeIdentity = identity(verified.actor,verified.scope);
  }
  assertCurrent(epoch,verified.actor,verified.scope);
  await store.init();
  const saved = object(await store.get(recordKey(entry.id)));
  const expected = completionExpectation(saved.expected);
  if (saved.version !== 1 || saved.queueId !== entry.id || !expected ||
    saved.actor !== verified.actor || saved.scope !== verified.scope ||
    expected.taskId !== saved.taskId || expected.action !== saved.actionKey) return;
  const response = object(result);
  if (response.status !== "task_transitioned" || response.action_key !== saved.actionKey || response.resource_key !== "tasks") return;
  const items = Array.isArray(response.items) ? response.items.map(object) : [];
  const matches = items.filter(item => item.task_id === saved.taskId);
  if (matches.length !== 1 || !text(matches[0].task_event_id) || !text(matches[0].to_status)) return;
  const final = await readScope();
  if (!final || final.actor !== verified.actor || final.scope !== verified.scope) return;
  await write(epoch,verified.actor,verified.scope,async () => {
   const current = object(await store.get(recordKey(entry.id)));
   assertCurrent(epoch,verified.actor,verified.scope);
   if (current.queueId !== entry.id || current.actor !== saved.actor || current.scope !== saved.scope ||
      current.taskId !== saved.taskId || current.actionKey !== saved.actionKey || !completionExpectation(current.expected)) return;
   await store.set(recordKey(entry.id), { ...current, accepted: {
    taskId:text(matches[0].task_id),taskEventId:text(matches[0].task_event_id),
    status:text(matches[0].to_status),reason:text(matches[0].status_reason)||null,
   }});
  });
 };
}

export async function latestCompletionReadback(store: KeyValueStore, actor: string, scope: string, taskId: string) {
  await store.init();
  const id = await store.get(targetKey(actor, scope, taskId));
  if (typeof id !== "string") return null;
  const value = object(await store.get(recordKey(id)));
  if (value.version !== 1 || value.queueId !== id || value.actor !== actor
    || value.scope !== scope || value.taskId !== taskId) return null;
  const expected = completionExpectation(value.expected);
  if (!expected || expected.taskId !== taskId || expected.action !== value.actionKey) throw new Error("Invalid saved completion expectation.");
  const record: CompletionReadbackRecord = {
    version: 1, queueId: id, actor, scope, taskId, actionKey: expected.action, expected,
  };
  if (value.accepted !== undefined) {
    const accepted = object(value.accepted);
    const taskEventId = text(accepted.taskEventId);
    const status = text(accepted.status);
    if (accepted.taskId !== taskId || !taskEventId || !status
      || (accepted.reason !== null && typeof accepted.reason !== "string")) throw new Error("Invalid accepted completion identity.");
    record.accepted = {
      taskId, taskEventId, status, reason: accepted.reason,
    };
  }
  return record;
}

export async function verifyCompletionReadback(
  record: CompletionReadbackRecord,
  read: (taskId: string, eventId: string, signal: AbortSignal) => PromiseLike<unknown>,
  isCurrent: () => boolean,
  wait: () => Promise<void> = () => new Promise(resolve => setTimeout(resolve, 250)),
): Promise<boolean | null> {
  if (!record.accepted) return false;
  const expected = { ...record.expected, taskId: record.taskId,
    taskStatus: record.accepted.status, taskEventId: record.accepted.taskEventId };
  for (let attempt = 0; attempt < 3; attempt += 1) {
    if (!isCurrent()) return null;
    try {
      const value = await boundedCompletionRead(signal => read(record.taskId, record.accepted!.taskEventId, signal));
      if (!isCurrent()) return null;
      if (record.expected.kind === 'financial_amount_v1'
        ? financialReadbackMatches({ ...expected, actorId: record.actor, organizationId: JSON.parse(record.scope)[0] }, value)
        : normalizedReadbackMatches(expected, value)) return true;
    } catch {
      // Read errors never enter the mutation executor or outbox retry lane.
      return isCurrent() ? false : null;
    }
    if (attempt < 2) await wait();
  }
  return false;
}

export type IncidentReadbackRecord = CompletionScope & {
  version: 1; queueId: string; taskId: string; routeStopId: string; artifactIds: string[];
  accepted?: { incidentTaskId: string; taskEventId: string };
};
const incidentKey = (actor: string, scope: string) =>
  "fieldops:incident-readback:v1:" + JSON.stringify([actor, scope]);
const uuid = (value: unknown): value is string => typeof value === "string" &&
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
const artifactIds = (value: unknown): string[] | null => Array.isArray(value) && value.length > 0 &&
  value.every(uuid) && new Set(value).size === value.length ? value : null;
const sameIds = (a: string[], b: string[]) => a.length === b.length && a.every(id => b.includes(id));
// ponytail: retain unresolved incident receipts; add proof-bound archival only if device storage grows materially.
function incidentRows(value: unknown, verified: CompletionScope): IncidentReadbackRecord[] {
  if (value == null) return [];
  const saved = object(value);
  if (saved.version !== 1 || !Array.isArray(saved.records)) throw new Error("Invalid saved incident evidence.");
  return saved.records.map((raw: unknown) => {
    const row = object(raw), accepted = object(row.accepted);
    if (row.version !== 1 || !text(row.queueId) || row.actor !== verified.actor || row.scope !== verified.scope ||
      !uuid(row.taskId) || !uuid(row.routeStopId) || !artifactIds(row.artifactIds) ||
      (row.accepted !== undefined && (!uuid(accepted.incidentTaskId) || !uuid(accepted.taskEventId))))
      throw new Error("Invalid saved incident evidence.");
    return { version: 1, queueId: text(row.queueId), actor: verified.actor, scope: verified.scope,
      taskId: row.taskId, routeStopId: row.routeStopId, artifactIds: row.artifactIds,
      ...(row.accepted === undefined ? {} : { accepted: {
        incidentTaskId: accepted.incidentTaskId, taskEventId: accepted.taskEventId } }) } as IncidentReadbackRecord;
  });
}

export async function listIncidentReadbacks(store: KeyValueStore, actor: string, scope: string, taskId: string): Promise<IncidentReadbackRecord[]> {
  await store.init();
  return incidentRows(await store.get(incidentKey(actor, scope)), { actor, scope }).filter(row => row.taskId === taskId);
}

export async function rememberIncidentReadback(store: KeyValueStore, record: IncidentReadbackRecord) {
  if (!record.actor || !record.scope || !record.queueId || !uuid(record.taskId) ||
    !uuid(record.routeStopId) || !artifactIds(record.artifactIds) || record.accepted)
    throw new Error("Invalid incident evidence.");
  const epoch = generation;
  await store.init();
  await write(epoch, record.actor, record.scope, async () => {
    const key = incidentKey(record.actor, record.scope);
    const records = incidentRows(await store.get(key), record);
    if (records.some(row => row.queueId === record.queueId)) throw new Error("Duplicate incident queue key.");
    await store.set(key, { version: 1, records: [...records, record] });
    assertCurrent(epoch, record.actor, record.scope);
  });
}

export async function forgetUnqueuedIncident(store: KeyValueStore, record: IncidentReadbackRecord) {
  const epoch = generation;
  await write(epoch, record.actor, record.scope, async () => {
    const key = incidentKey(record.actor, record.scope);
    const records = incidentRows(await store.get(key), record);
    await store.set(key, { version: 1, records: records.filter(row => row.queueId !== record.queueId ||
      row.taskId !== record.taskId || row.routeStopId !== record.routeStopId || Boolean(row.accepted)) });
    assertCurrent(epoch, record.actor, record.scope);
  });
}

export async function latestIncidentReadback(store: KeyValueStore, actor: string, scope: string, taskId: string): Promise<IncidentReadbackRecord | null> {
  return (await listIncidentReadbacks(store, actor, scope, taskId)).at(-1) ?? null;
}

export function incidentReadbackMatches(value: unknown, record: IncidentReadbackRecord): boolean {
  const proof = object(value), source = object(proof.source_task), task = object(proof.incident_task), incident = object(proof.incident);
  const evidence = artifactIds(incident.artifact_ids);
  return Boolean(record.accepted && source.id === record.taskId && text(source.status) &&
    task.id === record.accepted.incidentTaskId && task.task_event_id === record.accepted.taskEventId &&
    text(task.status) && text(incident.type) && text(incident.summary) &&
    proof.route_stop_id === record.routeStopId && uuid(proof.route_run_id) &&
    incident.reported_by_user_id === record.actor && evidence && sameIds(evidence, record.artifactIds));
}

export function incidentReadbackDisplayState(
  online: boolean, query: { isSuccess: boolean; isFetching: boolean; isError: boolean },
): "verified" | "pending" | "error" {
  if (query.isError) return "error";
  return online && query.isSuccess && !query.isFetching ? "verified" : "pending";
}

export function incidentSuccessObserver(store: KeyValueStore, readScope: () => Promise<CompletionScope | null>) {
  return async (entry: OutboxEntry, result: unknown) => {
    if (entry.rpc !== "ui_report_route_stop_incident_v1" || entry.args.p_action_key !== "tasks.report_incident" ||
      entry.args.p_resource_key !== "tasks" || !Array.isArray(entry.args.p_selection_ids) ||
      entry.args.p_selection_ids.length !== 1 || entry.args.p_selection_id !== entry.args.p_selection_ids[0]) return;
    const epoch = generation;
    const verified = await readScope();
    if (!verified || clearing || epoch !== generation) return;
    if (!activeIdentity) {
      if (!pristineColdAdmission) return;
      pristineColdAdmission = false;
      activeIdentity = identity(verified.actor, verified.scope);
    }
    assertCurrent(epoch, verified.actor, verified.scope);
    const key = incidentKey(verified.actor, verified.scope);
    const saved = incidentRows(await store.get(key), verified).find(row => row.queueId === entry.id);
    const params = object(entry.args.p_params);
    if (!saved || saved.taskId !== entry.args.p_selection_id || params.retry_key !== entry.id ||
      !sameIds(saved.artifactIds, artifactIds(params.artifact_ids) ?? [])) return;
    const proof = object(result), task = object(proof.incident_task);
    if (!uuid(task.id) || !uuid(task.task_event_id)) return;
    const accepted = { incidentTaskId: task.id, taskEventId: task.task_event_id };
    const candidate = { ...saved, accepted };
    if (!incidentReadbackMatches(proof, candidate)) return;
    const final = await readScope();
    if (!final || final.actor !== verified.actor || final.scope !== verified.scope) return;
    await write(epoch, verified.actor, verified.scope, async () => {
      const records = incidentRows(await store.get(key), verified);
      const index = records.findIndex(row => row.queueId === entry.id);
      assertCurrent(epoch, verified.actor, verified.scope);
      if (index < 0 || records[index].accepted || records[index].taskId !== saved.taskId ||
        records[index].routeStopId !== saved.routeStopId || !sameIds(records[index].artifactIds, saved.artifactIds)) return;
      records[index] = candidate;
      await store.set(key, { version: 1, records });
    });
  };
}

export function syncCompletionOutbox(
  outbox: { sync: (executor: RpcExecutor, options?: OutboxSyncOptions) => Promise<OutboxSyncResult> },
  executor: RpcExecutor, store: KeyValueStore, readScope: () => Promise<CompletionScope | null>,
  options: OutboxSyncOptions = {},
) {
  const observeCompletion = completionSuccessObserver(store, readScope);
  const observeIncident = incidentSuccessObserver(store, readScope);
  return outbox.sync(executor, { ...options, onSucceeded: async (entry, result) => {
    try { await observeCompletion(entry, result); }
    finally {
      try { await observeIncident(entry, result); }
      finally { await options.onSucceeded?.(entry, result); }
    }
  } });
}
