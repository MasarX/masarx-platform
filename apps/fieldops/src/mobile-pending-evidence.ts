import { stableStringify, type KeyValueStore } from "@masarx/mobile-core";

export type EvidenceScope = {
  organizationId: string; actorId: string; subjectId: string; commandKey: string;
  bucket: string; registrationRpc: string;
};
export type PendingEvidence = {
  id: string; kind: "photo" | "signature"; storageKey: string; bucket: string;
  mimeType: string; capturedAt: string; evidenceTag?: string;
  registrationRpc: string; payload: Record<string, unknown>; bytes: string;
  phase: "pending" | "uploading" | "uploaded" | "registered";
  attempts: number; artifactId?: string; errorCode?: string; permanent?: boolean;
};
export type EvidenceTransport = {
  upload: (record: PendingEvidence, bytes: ArrayBuffer) => Promise<void>;
  register: (record: PendingEvidence) => Promise<string>;
};

export function evidenceScopeKey(scope: EvidenceScope): string {
  const parts = [scope.organizationId, scope.actorId, scope.subjectId, scope.commandKey, scope.bucket, scope.registrationRpc];
  if (parts.some(part => typeof part !== "string" || !part.trim())) throw new Error("evidence_scope_missing");
  return `pending-evidence:v1:${JSON.stringify(parts)}`;
}

export function encodeEvidenceBytes(value: ArrayBuffer): string {
  const bytes = new Uint8Array(value);
  let binary = "";
  for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
  return globalThis.btoa(binary);
}
function decodeBytes(value: string): ArrayBuffer {
  const binary = globalThis.atob(value);
  const result = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) result[i] = binary.charCodeAt(i);
  return result.buffer;
}
function readRecords(raw: unknown, scope: EvidenceScope): PendingEvidence[] {
  if (raw === null) return [];
  if (!raw || typeof raw !== "object" || !("version" in raw) || raw.version !== 1 ||
      !("records" in raw) || !Array.isArray(raw.records)) throw new Error("evidence_store_invalid");
  const ids = new Set<string>();
  for (const value of raw.records) {
    if (!value || typeof value !== "object") throw new Error("evidence_store_invalid");
    for (const key of ["id", "storageKey", "bucket", "mimeType", "capturedAt", "registrationRpc"])
      if (typeof value[key] !== "string" || !value[key]) throw new Error("evidence_store_invalid");
    if (ids.has(value.id) || !["photo", "signature"].includes(value.kind) ||
        !["pending", "uploading", "uploaded", "registered"].includes(value.phase) ||
        typeof value.bytes !== "string" || !Number.isInteger(value.attempts) || value.attempts < 0 ||
        (value.permanent !== undefined && typeof value.permanent !== "boolean") ||
        (value.errorCode !== undefined && typeof value.errorCode !== "string") ||
        !value.payload || typeof value.payload !== "object" || Array.isArray(value.payload) ||
        (value.phase === "registered" && (typeof value.artifactId !== "string" || !value.artifactId)))
      throw new Error("evidence_store_invalid");
    if (value.bucket !== scope.bucket || value.registrationRpc !== scope.registrationRpc ||
        !value.storageKey.startsWith(`${scope.organizationId}/${scope.subjectId}/`) ||
        value.payload.organization_id !== scope.organizationId || value.payload.storage_bucket !== value.bucket ||
        value.payload.storage_key !== value.storageKey || value.payload.mime_type !== value.mimeType ||
        !Number.isInteger(value.payload.size_bytes) || value.payload.size_bytes <= 0 ||
        (value.evidenceTag !== undefined && (typeof value.evidenceTag !== "string" ||
          !value.evidenceTag.trim() || value.evidenceTag.length > 100))) throw new Error("evidence_store_invalid");
    try {
      const decoded = decodeBytes(value.bytes);
      if (decoded.byteLength !== value.payload.size_bytes || encodeEvidenceBytes(decoded) !== value.bytes)
        throw new Error("evidence_store_invalid");
    } catch { throw new Error("evidence_store_invalid"); }
    ids.add(value.id);
  }
  return raw.records;
}
function immutableIdentity(record: PendingEvidence) {
  return stableStringify({ id: record.id, kind: record.kind, storageKey: record.storageKey,
    bucket: record.bucket, mimeType: record.mimeType, capturedAt: record.capturedAt,
    evidenceTag: record.evidenceTag, registrationRpc: record.registrationRpc, payload: record.payload, bytes: record.bytes });
}
function errorStatus(error: unknown): number {
  if (!error || typeof error !== "object") return 0;
  const row = error as Record<string, unknown>;
  return Number(row.statusCode ?? row.status ?? 0);
}
function transient(error: unknown): boolean {
  const status = errorStatus(error);
  return status === 429 || (status >= 500 && status < 600) || error instanceof TypeError;
}

// Only KV operations are serialized. Invalidation never waits for a network request.
export function createPendingEvidence(store: KeyValueStore) {
  let generation = 0;
  let invalidated = false;
  let writes: Promise<unknown> = Promise.resolve();
  const active = new Map<string, Promise<PendingEvidence>>();
  function assertCurrent(epoch: number) {
    if (invalidated || epoch !== generation) throw new Error("evidence_session_changed");
  }
  function exclusive<T>(epoch: number, operation: () => Promise<T>): Promise<T> {
    const result = writes.then(async () => { assertCurrent(epoch); return operation(); });
    writes = result.catch(() => undefined);
    return result;
  }
  async function load(key: string, scope: EvidenceScope) { return readRecords(await store.get(key), scope); }
  async function save(key: string, records: PendingEvidence[], epoch: number) {
    assertCurrent(epoch);
    if (records.length) await store.set(key, { version: 1, records });
    else await store.remove(key);
  }
  function update(scope: EvidenceScope, id: string, epoch: number,
    change: (record: PendingEvidence) => PendingEvidence) {
    const key = evidenceScopeKey(scope);
    return exclusive(epoch, async () => {
      const records = await load(key, scope);
      const record = records.find(entry => entry.id === id);
      if (!record) throw new Error("evidence_discarded");
      const next = change(record);
      await save(key, records.map(entry => entry.id === id ? next : entry).filter(entry =>
        !(record.phase !== "registered" && next.phase === "registered" && next.kind === "signature" &&
          entry.kind === "signature" && entry.id !== id)), epoch);
      return next;
    });
  }
  return {
    invalidate() {
      generation++;
      invalidated = true;
      active.clear();
      return writes.then(() => undefined);
    },
    list(scope: EvidenceScope) {
      const epoch = generation;
      return exclusive(epoch, () => load(evidenceScopeKey(scope), scope));
    },
    stage(scope: EvidenceScope, record: PendingEvidence, maxItems: number) {
      const epoch = generation;
      const key = evidenceScopeKey(scope);
      return exclusive(epoch, async () => {
        readRecords({ version: 1, records: [record] }, scope);
        if (record.phase !== "pending") throw new Error("evidence_stage_invalid");
        const records = await load(key, scope);
        const existing = records.find(entry => entry.id === record.id);
        if (existing) {
          if (immutableIdentity(existing) !== immutableIdentity(record)) throw new Error("evidence_identity_conflict");
          return existing;
        }
        if (record.kind === "signature" && records.some(entry => entry.kind === "signature" && entry.phase !== "registered"))
          throw new Error("evidence_signature_pending");
        if (!Number.isInteger(maxItems) || maxItems < 1 || records.filter(entry =>
          !(entry.kind === "signature" && record.kind === "signature")).length >= maxItems)
          throw new Error("evidence_limit");
        if (record.evidenceTag && records.some(entry => entry.evidenceTag === record.evidenceTag))
          throw new Error("evidence_tag");
        await save(key, [...records, record], epoch);
        return record;
      });
    },
    discard(scope: EvidenceScope, ids: readonly string[]) {
      const epoch = generation;
      const key = evidenceScopeKey(scope);
      return exclusive(epoch, async () => save(key, (await load(key, scope)).filter(entry => !ids.includes(entry.id)), epoch));
    },
    settle(scope: EvidenceScope, id: string, transport: EvidenceTransport): Promise<PendingEvidence> {
      const epoch = generation;
      const key = `${epoch}:${evidenceScopeKey(scope)}:${id}`;
      const running = active.get(key);
      if (running) return running;
      const work = (async () => {
        let record = await update(scope, id, epoch, value => value);
        if (record.phase === "registered") return record;
        if (record.permanent) throw new Error(record.errorCode || "evidence_permanent_failure");
        // No permissive read authority is established for ambiguous object verification.
        // Never overwrite an unknown upload or infer its success from a conflict.
        if (record.phase === "uploading") throw new Error("evidence_upload_unconfirmed");
        if (record.phase === "pending") {
          record = await update(scope, id, epoch, value => ({ ...value, phase: "uploading", attempts: value.attempts + 1 }));
          try {
            assertCurrent(epoch);
            await transport.upload(record, decodeBytes(record.bytes));
          } catch (error) {
            const status = errorStatus(error);
            const rejected = status >= 400 && status < 500 && status !== 409;
            await update(scope, id, epoch, value => ({ ...value,
              phase: rejected ? "pending" : "uploading",
              errorCode: rejected ? "evidence_upload_rejected" : "evidence_upload_unconfirmed",
              permanent: rejected && status !== 429,
            }));
            throw error;
          }
          record = await update(scope, id, epoch, value => ({ ...value, phase: "uploaded", errorCode: undefined }));
        }
        for (let attempt = 0; attempt < 2; attempt++) {
          record = await update(scope, id, epoch, value => ({ ...value, attempts: value.attempts + 1 }));
          try {
            assertCurrent(epoch);
            const artifactId = await transport.register(record);
            if (!artifactId.trim()) throw new Error("evidence_registration_empty");
            return await update(scope, id, epoch, value => ({ ...value, phase: "registered", artifactId,
              errorCode: undefined, permanent: false }));
          } catch (error) {
            const retryable = transient(error);
            await update(scope, id, epoch, value => ({ ...value,
              errorCode: retryable ? "evidence_registration_transient" : "evidence_registration_rejected",
              permanent: !retryable,
            }));
            if (!retryable || attempt === 1) throw error;
          }
        }
        throw new Error("evidence_registration_unconfirmed");
      })();
      active.set(key, work);
      void work.finally(() => { if (active.get(key) === work) active.delete(key); }).catch(() => undefined);
      return work;
    },
  };
}

// The outbox becomes the durable owner before local evidence can be pruned.
// Never report an already-enqueued action as failed merely because pruning failed.
export async function handoffPendingEvidence<T>(enqueue: () => Promise<T>, prune: () => Promise<void>,
  isCurrent: () => boolean, onPruneError: (error: unknown) => void): Promise<T> {
  if (!isCurrent()) throw new Error("evidence_session_changed");
  const receipt = await enqueue();
  if (isCurrent()) {
    try { await prune(); } catch (error) { onPruneError(error); }
  }
  return receipt;
}

export async function clearEvidenceLocalState(evidence: Pick<ReturnType<typeof createPendingEvidence>, "invalidate">,
  clearOutbox: () => Promise<unknown>, clearCache: () => Promise<unknown>) {
  await evidence.invalidate();
  await clearOutbox();
  await clearCache();
}

// Logout can fail while leaving the actor authenticated. Never revive the invalidated
// instance; only a verified remaining actor may obtain a fresh manager after clearing.
export async function replaceEvidenceManagerAfterClear(verifyActor: () => Promise<string | null>,
  expectedActor: string | null, isCurrent: () => boolean, replace: () => void): Promise<boolean> {
  if (!expectedActor || !isCurrent()) return false;
  try {
    const actor = await verifyActor();
    if (actor !== expectedActor || !isCurrent()) return false;
    replace();
    return true;
  } catch { return false; }
}
