type Obj = Record<string, unknown>;
const obj = (x: unknown): Obj => x !== null && typeof x === 'object' && !Array.isArray(x) ? x as Obj : {};
const str = (x: unknown): x is string => typeof x === 'string' && x.trim().length > 0;
const numeric = (x: unknown): number | null => (typeof x === 'number' || (typeof x === 'string' && x.trim() !== '')) && Number.isFinite(Number(x)) ? Number(x) : null;
export type PendingExpectation = {
  action: 'tasks.complete' | 'tasks.exception'; taskId: string;
  routeStopId: string; stopKind?: string;
  completionKind?: 'full' | 'partial'; statusReason?: string;
  artifactIds?: string[]; signatureArtifactId?: string; deliveredBoxNumbers?: number[];
  otpConfirmed?: boolean; identityPresent?: boolean; geostampPresent?: boolean;
  paymentOutcome?: string; paymentMethod?: string; collectedAmount?: number;
  confirmedQuantity?: number; handoverContactPresent?: boolean; handoverNotesPresent?: boolean; receiptContextPresent?: boolean;
};
export type Expectation = PendingExpectation & { taskEventId: string; taskStatus: string };
// Persist only this whitelist; reject malformed requested proof rather than silently dropping it.
export function pendingExpectation(input: unknown): PendingExpectation | null {
  const x = obj(input);
  if (x.action !== 'tasks.complete' && x.action !== 'tasks.exception') return null;
  if (!['taskId','routeStopId'].every(k => str(x[k]))) return null;
  if (x.stopKind !== undefined && !str(x.stopKind)) return null;
  if (x.action === 'tasks.exception' && !str(x.statusReason)) return null;
  if (x.action === 'tasks.complete' && x.stopKind === 'delivery' && x.completionKind !== 'full' && x.completionKind !== 'partial') return null;
  if (x.completionKind !== undefined && x.completionKind !== 'full' && x.completionKind !== 'partial') return null;
  for (const k of ['statusReason','signatureArtifactId','paymentOutcome','paymentMethod']) if (x[k] !== undefined && !str(x[k])) return null;
  for (const k of ['otpConfirmed','identityPresent','geostampPresent']) if (x[k] !== undefined && typeof x[k] !== 'boolean') return null;
  if (x.artifactIds !== undefined && (!Array.isArray(x.artifactIds) || x.artifactIds.length === 0 || !x.artifactIds.every(str))) return null;
  if (x.deliveredBoxNumbers !== undefined && (!Array.isArray(x.deliveredBoxNumbers) || x.deliveredBoxNumbers.length === 0 || !x.deliveredBoxNumbers.every(n => typeof n === 'number' && Number.isInteger(n) && n > 0))) return null;
  if (x.completionKind === 'partial' && !Array.isArray(x.deliveredBoxNumbers)) return null;
  if (x.collectedAmount !== undefined && (typeof x.collectedAmount !== 'number' || !Number.isFinite(x.collectedAmount) || x.collectedAmount < 0)) return null;
  if ((x.collectedAmount !== undefined || x.paymentMethod !== undefined) && !str(x.paymentOutcome)) return null;
  if (x.paymentOutcome !== undefined && x.collectedAmount === undefined) return null;
  if (x.confirmedQuantity !== undefined && (x.action !== 'tasks.complete' || typeof x.confirmedQuantity !== 'number' || !Number.isInteger(x.confirmedQuantity) || x.confirmedQuantity <= 0)) return null;
  for (const k of ['handoverContactPresent','handoverNotesPresent','receiptContextPresent']) if (x[k] !== undefined && (typeof x[k] !== 'boolean' || x.confirmedQuantity === undefined)) return null;
  if (x.action === 'tasks.complete' && !(x.confirmedQuantity || x.completionKind || x.artifactIds || x.signatureArtifactId || x.deliveredBoxNumbers || x.otpConfirmed === true || x.identityPresent === true || x.geostampPresent === true || x.paymentOutcome)) return null;
  const keys = ['action','taskId','routeStopId','stopKind','completionKind','statusReason','artifactIds','signatureArtifactId','deliveredBoxNumbers','otpConfirmed','identityPresent','geostampPresent','paymentOutcome','paymentMethod','collectedAmount'];
  keys.push('confirmedQuantity','handoverContactPresent','handoverNotesPresent','receiptContextPresent');
  return Object.fromEntries(keys.filter(k => x[k] !== undefined).map(k => [k, Array.isArray(x[k]) ? [...x[k] as unknown[]] : x[k]])) as PendingExpectation;
}
export function normalizedExpectation(input: unknown): Expectation | null {
  const pending = pendingExpectation(input), x = obj(input);
  if (!pending || !str(x.taskEventId) || !str(x.taskStatus)) return null;
  return { ...pending, taskEventId:x.taskEventId, taskStatus:x.taskStatus };
}
export function normalizedReadbackMatches(input: unknown, receiptInput: unknown): boolean {
  const e = normalizedExpectation(input);
  if (!e) return false;
  const r = obj(receiptInput), task = obj(r.task), stop = obj(r.stop), proof = obj(r.proof), c = obj(r.completion), p = obj(c.payment_collection);
  if (task.id !== e.taskId || task.status !== e.taskStatus || r.task_event_id !== e.taskEventId || !str(r.shipment_action_id) || stop.id !== e.routeStopId || !str(stop.kind) || (e.stopKind !== undefined && stop.kind !== e.stopKind)) return false;
  if (e.completionKind && c.completion_kind !== e.completionKind) return false;
  if (e.statusReason && stop.dispatch_exception_reason !== e.statusReason) return false;
  if (e.confirmedQuantity !== undefined) {
    const pickup = obj(r.pickup);
    if (stop.kind !== 'pickup' || numeric(pickup.confirmed_quantity) !== e.confirmedQuantity) return false;
    for (const [expected,actual] of [[e.handoverContactPresent,pickup.handover_contact_present],[e.handoverNotesPresent,pickup.handover_notes_present],[e.receiptContextPresent,pickup.receipt_context_present]]) if (expected === true && actual !== true) return false;
  }
  if (stop.kind === 'delivery') {
    const outcome = stop.delivery_attempt_outcome;
    if (!str(outcome) || !str(stop.canonical_status)) return false;
    if (stop.route_stop_outcome !== (outcome === 'delivered' ? 'completed' : 'attempted')) return false;
    // 202604101100 route_stop_attempt_outcome_from_action_v1: canonical status,
    // not the UI command name, determines delivered; partial has its own outcome.
    if (outcome !== 'delivered' && !str(stop.delivery_attempt_reason)) return false;
    if (outcome === 'partial_delivery' && stop.delivery_attempt_reason !== 'partial_delivery') return false;
  }
  const artifacts = proof.artifact_ids;
  if (e.artifactIds && (!Array.isArray(artifacts) || e.artifactIds.some(id => !artifacts.includes(id)))) return false;
  if (e.signatureArtifactId && (proof.signature_artifact_id !== e.signatureArtifactId || !Array.isArray(artifacts) || !artifacts.includes(e.signatureArtifactId))) return false;
  if (e.deliveredBoxNumbers) {
    const actual = c.delivered_box_numbers;
    if (!Array.isArray(actual) || !actual.every(n => typeof n === 'number' && Number.isInteger(n) && n > 0)) return false;
    const set = (a: number[]) => JSON.stringify([...new Set(a)].sort((a,b) => a-b));
    if (set(actual) !== set(e.deliveredBoxNumbers)) return false;
  }
  for (const [expected, actual] of [[e.otpConfirmed,proof.otp_confirmed],[e.identityPresent,proof.identity_present],[e.geostampPresent,proof.geostamp_present]]) if (expected === true && actual !== true) return false;
  if (e.paymentOutcome) {
    const variance = numeric(p.variance_amount);
    if (p.outcome !== e.paymentOutcome || numeric(p.collected_amount) !== e.collectedAmount || variance === null) return false;
    if (e.paymentMethod && p.method !== e.paymentMethod) return false;
    // 202604101130_b08_cod_payment_task_contract_v1: variance = expected - collected.
    const kind = p.outcome === 'refused' ? 'refused' : variance > 0 ? 'shortfall' : variance < 0 ? 'over_collection' : 'matched';
    if (p.discrepancy_kind !== kind || p.has_discrepancy !== (p.outcome === 'refused' || variance !== 0)) return false;
  }
  return true;
}
export function submittedCompletionExpectation(action: string, taskId: string, routeStopId: unknown, payloadInput: unknown) {
  const payload = obj(payloadInput), completion = obj(payload.delivery_completion), pod = obj(payload.pod);
  const payment = obj(payload.payment_collection);
const pickupFields: Record<string, unknown> = {};
if (payload.confirmed_quantity !== undefined) {
  if (typeof payload.confirmed_quantity !== 'number' || !Number.isInteger(payload.confirmed_quantity) || payload.confirmed_quantity <= 0) return null;
  for (const key of ['handover_contact_name','handover_notes','receipt_context']) {
    if (payload[key] !== undefined && payload[key] !== null && typeof payload[key] !== 'string') return null;
  }
  Object.assign(pickupFields, {
    confirmedQuantity: payload.confirmed_quantity,
    handoverContactPresent: typeof payload.handover_contact_name === 'string' && payload.handover_contact_name.trim().length > 0,
    handoverNotesPresent: typeof payload.handover_notes === 'string' && payload.handover_notes.trim().length > 0,
    receiptContextPresent: typeof payload.receipt_context === 'string' && payload.receipt_context.trim().length > 0,
  });
}

  return pendingExpectation({
    ...pickupFields,
    action, taskId, routeStopId, completionKind: completion.completion_kind ?? undefined,
    deliveredBoxNumbers: completion.delivered_box_numbers ?? undefined,
    artifactIds: payload.artifact_ids ?? undefined,
    signatureArtifactId: payload.signature_artifact_id ?? undefined,
    otpConfirmed: Boolean(payload.otp_code || completion.otp_code),
    identityPresent: Boolean(completion.recipient_identity_kind || payload.recipient_identity_kind),
    geostampPresent: Boolean((action === "tasks.exception" ? obj(payload.exception_evidence) : pod).geostamp),
    statusReason: payload.exception_reason ?? undefined,
    paymentOutcome: payment.outcome ?? undefined, paymentMethod: payment.method ?? undefined,
    collectedAmount: payment.collected_amount ?? undefined,
  });
}
