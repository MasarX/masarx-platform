import { createPendingEvidence, encodeEvidenceBytes, evidenceScopeKey, handoffPendingEvidence, clearEvidenceLocalState, replaceEvidenceManagerAfterClear,
  type PendingEvidence, type EvidenceScope } from "../../../apps/fieldops/src/mobile-pending-evidence";
import { createMemoryKeyValueStore } from "../../../apps/fieldops/src/mobile-memory-store";

const scope: EvidenceScope = { organizationId: "org", actorId: "actor", subjectId: "task", commandKey: "complete",
  bucket: "evidence", registrationRpc: "register_mobile_artifact_v1" };
const bytes = new Uint8Array([0, 1, 127, 128, 255]).buffer;
function record(id = "capture", kind: "photo" | "signature" = "photo"): PendingEvidence {
  return { id, kind, storageKey: `org/task/${id}`, bucket: "evidence", mimeType: "image/jpeg",
    capturedAt: "2026-09-07T00:00:00Z", registrationRpc: "register_mobile_artifact_v1",
    payload: { organization_id: "org", storage_bucket: "evidence", storage_key: `org/task/${id}`,
      mime_type: "image/jpeg", size_bytes: bytes.byteLength },
    bytes: encodeEvidenceBytes(bytes), phase: "pending", attempts: 0 };
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}
async function fixture() {
  const store = createMemoryKeyValueStore();
  await store.init();
  const evidence = createPendingEvidence(store);
  const transport = { upload: jest.fn(async (_record: PendingEvidence, _bytes: ArrayBuffer) => undefined),
    register: jest.fn(async (_record: PendingEvidence) => "artifact") };
  return { store, evidence, transport };
}

describe("composer pending evidence lifecycle", () => {
  test.each(["photo", "signature"] as const)("persists %s bytes before upload, then registration identity", async kind => {
    const { store, evidence, transport } = await fixture();
    await evidence.stage(scope, record("capture", kind), 2);
    transport.upload.mockImplementation(async () => {
      const state = await store.get(evidenceScopeKey(scope)) as { records: PendingEvidence[] };
      expect(state.records[0].phase).toBe("uploading");
      expect(state.records[0].bytes).toBe(encodeEvidenceBytes(bytes));
    });
    const result = await evidence.settle(scope, "capture", transport);
    expect(result).toMatchObject({ phase: "registered", artifactId: "artifact", bytes: encodeEvidenceBytes(bytes) });
    expect(transport.upload.mock.calls[0][1]).toEqual(bytes);
    expect(transport.register).toHaveBeenCalledTimes(1);
  });

  test("storage failure prevents all network effects", async () => {
    const { store, transport } = await fixture();
    store.set = jest.fn(async () => { throw new Error("disk_full"); });
    const evidence = createPendingEvidence(store);
    await expect(evidence.stage(scope, record(), 2)).rejects.toThrow("disk_full");
    expect(transport.upload).not.toHaveBeenCalled();
  });

  test("registration transient failure retries once and preserves uploaded phase for later recovery", async () => {
    const { evidence, store, transport } = await fixture();
    await evidence.stage(scope, record(), 2);
    transport.register.mockRejectedValue({ status: 503 });
    await expect(evidence.settle(scope, "capture", transport)).rejects.toEqual({ status: 503 });
    expect(transport.register).toHaveBeenCalledTimes(2);
    expect((await evidence.list(scope))[0]).toMatchObject({ phase: "uploaded", permanent: false });
    const reopened = createPendingEvidence(store);
    transport.register.mockResolvedValue("artifact");
    await reopened.settle(scope, "capture", transport);
    expect(transport.upload).toHaveBeenCalledTimes(1);
    expect((await reopened.list(scope))[0].artifactId).toBe("artifact");
  });

  test.each([{ status: 403 }, { code: "42501" }])("permanent registration failure stops without automatic retry", async error => {
    const { evidence, transport } = await fixture();
    await evidence.stage(scope, record(), 2);
    transport.register.mockRejectedValue(error);
    await expect(evidence.settle(scope, "capture", transport)).rejects.toEqual(error);
    await expect(evidence.settle(scope, "capture", transport)).rejects.toThrow("evidence_registration_rejected");
    expect(transport.register).toHaveBeenCalledTimes(1);
  });

  test("empty registration result remains failed and cannot become a payload ID", async () => {
    const { evidence, transport } = await fixture();
    await evidence.stage(scope, record(), 2);
    transport.register.mockResolvedValue("");
    await expect(evidence.settle(scope, "capture", transport)).rejects.toThrow("evidence_registration_empty");
    expect((await evidence.list(scope))[0]).toMatchObject({ phase: "uploaded", permanent: true });
    expect((await evidence.list(scope))[0].artifactId).toBeUndefined();
  });

  test.each([{ status: 409 }, { status: 503 }, new TypeError("network")])("ambiguous upload never overwrites or assumes conflict success", async error => {
    const { evidence, transport, store } = await fixture();
    await evidence.stage(scope, record(), 2);
    transport.upload.mockRejectedValue(error);
    await expect(evidence.settle(scope, "capture", transport)).rejects.toEqual(error);
    const reopened = createPendingEvidence(store);
    await expect(reopened.settle(scope, "capture", transport)).rejects.toThrow("evidence_upload_unconfirmed");
    expect(transport.upload).toHaveBeenCalledTimes(1);
    expect(transport.register).not.toHaveBeenCalled();
    expect((await reopened.list(scope))[0].bytes).not.toBe("");
  });

  test("explicit throttling rejection keeps pending identity recoverable", async () => {
    const { evidence, transport } = await fixture();
    await evidence.stage(scope, record(), 2);
    transport.upload.mockRejectedValueOnce({ status: 429 });
    await expect(evidence.settle(scope, "capture", transport)).rejects.toEqual({ status: 429 });
    await evidence.settle(scope, "capture", transport);
    expect(transport.upload.mock.calls.map(call => call[0].storageKey)).toEqual(["org/task/capture", "org/task/capture"]);
  });

  test("registered recovery is idempotent and does not repeat registration", async () => {
    const { evidence, transport, store } = await fixture();
    await evidence.stage(scope, record(), 2);
    await evidence.settle(scope, "capture", transport);
    await createPendingEvidence(store).settle(scope, "capture", transport);
    expect(transport.register).toHaveBeenCalledTimes(1);
  });

  test.each(["organizationId", "actorId", "subjectId", "commandKey"] as const)("isolates %s", async key => {
    const { evidence } = await fixture();
    await evidence.stage(scope, record(), 2);
    expect(await evidence.list({ ...scope, [key]: "other" })).toEqual([]);
  });

  test("duplicate local ID does not replace bytes or create a second pending row", async () => {
    const { evidence } = await fixture();
    await evidence.stage(scope, record(), 2);
    await evidence.stage(scope, record(), 2);
    const changed = record();
    changed.bytes = encodeEvidenceBytes(new Uint8Array([1, 2, 3, 4, 5]).buffer);
    await expect(evidence.stage(scope, changed, 2)).rejects.toThrow("evidence_identity_conflict");
    expect(await evidence.list(scope)).toHaveLength(1);
    expect((await evidence.list(scope))[0].bytes).toBe(encodeEvidenceBytes(bytes));
  });

  test("concurrent settlement uses one upload and registration", async () => {
    const { evidence, transport } = await fixture();
    await evidence.stage(scope, record(), 2);
    const gate = deferred<void>();
    transport.upload.mockImplementation(() => gate.promise);
    const first = evidence.settle(scope, "capture", transport);
    const second = evidence.settle(scope, "capture", transport);
    expect(second).toBe(first);
    gate.resolve(undefined);
    await Promise.all([first, second]);
    expect(transport.upload).toHaveBeenCalledTimes(1);
    expect(transport.register).toHaveBeenCalledTimes(1);
  });

  test("serialized stage enforces limits across concurrent captures", async () => {
    const { evidence } = await fixture();
    const results = await Promise.allSettled([
      evidence.stage(scope, record("one"), 1), evidence.stage(scope, record("two"), 1),
    ]);
    expect(results.map(result => result.status)).toEqual(["fulfilled", "rejected"]);
    expect(await evidence.list(scope)).toHaveLength(1);
  });

  test("signature replacement keeps old proof until new registration succeeds", async () => {
    const { evidence, transport } = await fixture();
    await evidence.stage(scope, record("old", "signature"), 1);
    await evidence.settle(scope, "old", transport);
    await evidence.stage(scope, record("new", "signature"), 1);
    expect(await evidence.list(scope)).toHaveLength(2);
    await evidence.settle(scope, "old", transport);
    expect((await evidence.list(scope)).map(row => row.id)).toEqual(["old", "new"]);
    await expect(evidence.stage(scope, record("third", "signature"), 1)).rejects.toThrow("evidence_signature_pending");
    await evidence.settle(scope, "new", transport);
    expect((await evidence.list(scope)).map(row => row.id)).toEqual(["new"]);
  });

  test("duplicate evidence tags fail before network", async () => {
    const { evidence } = await fixture();
    await evidence.stage(scope, { ...record("one"), evidenceTag: "front" }, 2);
    await expect(evidence.stage(scope, { ...record("two"), evidenceTag: "front" }, 2)).rejects.toThrow("evidence_tag");
  });

  test("explicit local discard does not call a remote deletion seam", async () => {
    const { evidence, transport } = await fixture();
    await evidence.stage(scope, record(), 2);
    await evidence.discard(scope, ["capture"]);
    expect(await evidence.list(scope)).toEqual([]);
    await expect(evidence.settle(scope, "capture", transport)).rejects.toThrow("evidence_discarded");
    expect(transport.upload).not.toHaveBeenCalled();
  });

  test("invalidation drains storage but not network and prevents late clear-state resurrection", async () => {
    const { evidence, transport, store } = await fixture();
    await evidence.stage(scope, record(), 2);
    const started = deferred<void>();
    const gate = deferred<void>();
    transport.upload.mockImplementation(() => { started.resolve(undefined); return gate.promise; });
    const pending = evidence.settle(scope, "capture", transport);
    const rejection = expect(pending).rejects.toThrow("evidence_session_changed");
    await started.promise;
    await evidence.invalidate();
    await store.clear();
    gate.resolve(undefined);
    await rejection;
    expect(await createPendingEvidence(store).list(scope)).toEqual([]);
    await expect(evidence.stage(scope, record("late"), 2)).rejects.toThrow("evidence_session_changed");
    expect(transport.register).not.toHaveBeenCalled();
  });

  test("corrupt persisted records fail closed", async () => {
    const { evidence, store } = await fixture();
    await store.set(evidenceScopeKey(scope), { version: 1, records: [{ id: "broken" }] });
    await expect(evidence.list(scope)).rejects.toThrow("evidence_store_invalid");
    for (const patch of [
      { storageKey: "other/task/capture" }, { bucket: "different" }, { mimeType: "application/pdf" },
      { bytes: "not base64" }, { bytes: encodeEvidenceBytes(new Uint8Array([1]).buffer) },
      { payload: { ...record().payload, organization_id: "other" } },
      { payload: { ...record().payload, storage_key: "org/task/other" } },
      { payload: { ...record().payload, size_bytes: -1 } },
    ]) {
      await store.set(evidenceScopeKey(scope), { version: 1, records: [{ ...record(), ...patch }] });
      await expect(evidence.list(scope)).rejects.toThrow("evidence_store_invalid");
      const upload = jest.fn(); const register = jest.fn();
      await expect(evidence.settle(scope, "capture", { upload, register })).rejects.toThrow("evidence_store_invalid");
      expect(upload).not.toHaveBeenCalled(); expect(register).not.toHaveBeenCalled();
    }
    for (const phase of ["pending", "registered"] as const) {
      for (const patch of [
        { bucket: "altered", payload: { ...record().payload, storage_bucket: "altered" } },
        { registrationRpc: "unrelated_rpc" },
      ]) {
        await store.set(evidenceScopeKey(scope), { version: 1,
          records: [{ ...record(), phase, artifactId: "artifact", ...patch }] });
        // Registered rows cannot project either: App obtains them through this same list boundary.
        await expect(evidence.list(scope)).rejects.toThrow("evidence_store_invalid");
        const upload = jest.fn(); const register = jest.fn();
        await expect(evidence.settle(scope, "capture", { upload, register })).rejects.toThrow("evidence_store_invalid");
        expect(upload).not.toHaveBeenCalled(); expect(register).not.toHaveBeenCalled();
      }
    }
  });
});

describe("App evidence handoff and local-clear production composition", () => {
  test("enqueue must settle before prune; enqueue failure preserves capture", async () => {
    const gate = deferred<string>();
    const prune = jest.fn(async () => undefined);
    const warning = jest.fn();
    const handoff = handoffPendingEvidence(() => gate.promise, prune, () => true, warning);
    expect(prune).not.toHaveBeenCalled();
    gate.resolve("durable-receipt");
    await expect(handoff).resolves.toBe("durable-receipt");
    expect(prune).toHaveBeenCalledTimes(1);
    prune.mockClear();
    await expect(handoffPendingEvidence(async () => { throw new Error("enqueue_failed"); },
      prune, () => true, warning)).rejects.toThrow("enqueue_failed");
    expect(prune).not.toHaveBeenCalled();
  });

  test("failed prune does not encourage duplicate action submission", async () => {
    const warning = jest.fn();
    await expect(handoffPendingEvidence(async () => "queued",
      async () => { throw new Error("disk"); }, () => true, warning)).resolves.toBe("queued");
    expect(warning).toHaveBeenCalledTimes(1);
  });

  test("scope/session change during enqueue leaves new-scope records untouched", async () => {
    const gate = deferred<string>();
    let current = true;
    const prune = jest.fn(async () => undefined);
    const handoff = handoffPendingEvidence(() => gate.promise, prune, () => current, jest.fn());
    current = false;
    gate.resolve("old-receipt");
    await expect(handoff).resolves.toBe("old-receipt");
    expect(prune).not.toHaveBeenCalled();
    const enqueue = jest.fn(async () => "unexpected");
    await expect(handoffPendingEvidence(enqueue, prune, () => false, jest.fn())).rejects.toThrow("evidence_session_changed");
    expect(enqueue).not.toHaveBeenCalled();
  });

  test("shared signout/diagnostics clear seam drains writes before clearing both stores", async () => {
    const gate = deferred<void>();
    const events: string[] = [];
    const clear = clearEvidenceLocalState({ invalidate: async () => { events.push("invalidate"); await gate.promise; } },
      async () => { events.push("outbox"); }, async () => { events.push("cache"); });
    expect(events).toEqual(["invalidate"]);
    gate.resolve(undefined);
    await clear;
    expect(events).toEqual(["invalidate", "outbox", "cache"]);
  });

  test("verified failed logout replaces the closed manager without reviving it", async () => {
    const { store, evidence } = await fixture();
    await evidence.stage(scope, record(), 2);
    await clearEvidenceLocalState(evidence, async () => undefined, () => store.clear());
    let replacement = evidence;
    await expect(replaceEvidenceManagerAfterClear(async () => "actor", "actor", () => true,
      () => { replacement = createPendingEvidence(store); })).resolves.toBe(true);
    expect(replacement).not.toBe(evidence);
    await expect(evidence.stage(scope, record(), 2)).rejects.toThrow("evidence_session_changed");
    await expect(replacement.stage(scope, record(), 2)).resolves.toMatchObject({ id: "capture" });
  });

  test("logout recovery refuses absent, changed, failed or stale actor verification", async () => {
    const replace = jest.fn();
    for (const actor of [null, "other"]) {
      await expect(replaceEvidenceManagerAfterClear(async () => actor, "actor", () => true, replace)).resolves.toBe(false);
    }
    await expect(replaceEvidenceManagerAfterClear(async () => { throw new Error("auth_unavailable"); },
      "actor", () => true, replace)).resolves.toBe(false);
    const gate = deferred<string | null>();
    let current = true;
    const result = replaceEvidenceManagerAfterClear(() => gate.promise, "actor", () => current, replace);
    current = false;
    gate.resolve("actor");
    await expect(result).resolves.toBe(false);
    expect(replace).not.toHaveBeenCalled();
  });

  test("local-clear failure still permits verified remaining-session replacement and preserves the error", async () => {
    const { evidence } = await fixture();
    const replace = jest.fn();
    await expect(clearEvidenceLocalState(evidence, async () => undefined, async () => { throw new Error("disk"); })
      .finally(() => replaceEvidenceManagerAfterClear(async () => "actor", "actor", () => true, replace)))
      .rejects.toThrow("disk");
    expect(replace).toHaveBeenCalledTimes(1);
  });
});
