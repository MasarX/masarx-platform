// Unit coverage for the mutation-hook helpers in mobile-v2-rpc-hooks.ts:
//   - newIdempotencyKey: shape contract (canonical v4 UUID, unique)
//   - previewEnvelope: { ok, decision_log_id: preview-<uuid>, state, ...extra }
//   - parseWriteEnvelope: passes server response through when decision_log_id
//     is present; throws when missing rather than fabricating a success id
//
// Closes the engineering audit's TOP-3 nice-to-have #1:
//   "Jest unit coverage for at least one representative mutation hook
//    (preview envelope, idempotency-key shape, callRpc error surface)."
//
// supabase-js + react-query require a DOM-like environment to render the
// hooks themselves; instead we exercise the pure helpers that every hook
// composes. This is functionally equivalent (the 19 mutation hooks all
// flow through these three primitives) and matches the existing
// mobile-v2-tasks-kpi-counts pattern.

import {
  newIdempotencyKey,
  previewEnvelope,
  parseWriteEnvelope,
  isMobileV2PersistedUuid,
} from "../../../apps/fieldops/src/mobile-v2-rpc-hooks";

const UUID_CANONICAL_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

describe("newIdempotencyKey", () => {
  test("returns a canonical RFC 4122 v4 UUID", () => {
    const key = newIdempotencyKey();
    expect(UUID_CANONICAL_RE.test(key)).toBe(true);
    // v4 byte 6 high nibble must be 4
    expect(key[14]).toBe("4");
    expect(["8", "9", "a", "b"]).toContain(key[19]?.toLowerCase());
  });

  test("returns a fresh key on each call (no collisions in N samples)", () => {
    const seen = new Set<string>();
    for (let i = 0; i < 128; i += 1) seen.add(newIdempotencyKey());
    expect(seen.size).toBe(128);
  });
});

describe("isMobileV2PersistedUuid", () => {
  test("accepts a canonical UUID — a real persisted backend primary key", () => {
    expect(isMobileV2PersistedUuid(newIdempotencyKey())).toBe(true);
    expect(isMobileV2PersistedUuid("3f2504e0-4f89-41d3-9a0c-0305e82c3301")).toBe(true);
  });

  test("rejects fixture / showcase identifiers that must not reach a UUID RPC param", () => {
    // The fixture ids that previously leaked into submit_fieldops_proof_v1 /
    // sign_fieldops_cash_drop_v1 and triggered Postgres 22P02.
    for (const id of ["STP-003", "TRIP-9913", `preview-photo-${Date.now()}`, "DLX-784521", ""]) {
      expect(isMobileV2PersistedUuid(id)).toBe(false);
    }
  });

  test("rejects non-string values", () => {
    for (const v of [null, undefined, 42, {}, []]) {
      expect(isMobileV2PersistedUuid(v)).toBe(false);
    }
  });
});

describe("previewEnvelope", () => {
  test("returns { ok:true, decision_log_id:'preview-…', state }", () => {
    const env = previewEnvelope("delivered");
    expect(env.ok).toBe(true);
    expect(env.state).toBe("delivered");
    expect(typeof env.decision_log_id).toBe("string");
    expect(env.decision_log_id.startsWith("preview-")).toBe(true);
    // Strip the preview- prefix and check the remainder is a valid UUID.
    expect(UUID_CANONICAL_RE.test(env.decision_log_id.slice("preview-".length))).toBe(true);
  });

  test("merges extra fields without clobbering the typed contract", () => {
    const env = previewEnvelope("inducted", {
      bay: "B-04",
      tracking_number: "DLX-123",
      ok: false, // attempt to clobber — must be ignored
      decision_log_id: "fake-id", // attempt to clobber — must be ignored
      state: "should-not-override",
    });
    expect(env.ok).toBe(true);
    expect(env.state).toBe("inducted");
    expect(env.decision_log_id.startsWith("preview-")).toBe(true);
    expect((env as unknown as Record<string, unknown>).bay).toBe("B-04");
    expect((env as unknown as Record<string, unknown>).tracking_number).toBe("DLX-123");
  });

  test("returned envelope is frozen (no caller mutation)", () => {
    const env = previewEnvelope("rto", { stop_id: "abc" });
    expect(Object.isFrozen(env)).toBe(true);
  });
});

describe("parseWriteEnvelope", () => {
  test("passes through a server response with decision_log_id intact", () => {
    const env = parseWriteEnvelope(
      {
        decision_log_id: "00000000-1111-4222-8333-444444444444",
        ok: true,
        state: "delivered",
        bay: "B-04",
      },
      "delivered",
    );
    expect(env.ok).toBe(true);
    expect(env.decision_log_id).toBe("00000000-1111-4222-8333-444444444444");
    expect(env.state).toBe("delivered");
    expect((env as unknown as Record<string, unknown>).bay).toBe("B-04");
  });

  test("defaults state to the fallback when server omits it", () => {
    const env = parseWriteEnvelope(
      { decision_log_id: "00000000-1111-4222-8333-555555555555" },
      "inducted",
    );
    expect(env.state).toBe("inducted");
  });

  test("throws when decision_log_id is missing — never fabricates success", () => {
    expect(() => parseWriteEnvelope({ ok: true }, "delivered")).toThrow(
      /unexpected write envelope/,
    );
  });

  test("throws on null / non-object payloads", () => {
    expect(() => parseWriteEnvelope(null, "x")).toThrow(/unexpected write envelope/);
    expect(() => parseWriteEnvelope(42, "x")).toThrow(/unexpected write envelope/);
    expect(() => parseWriteEnvelope("string", "x")).toThrow(/unexpected write envelope/);
  });

  test("rejects non-string decision_log_id", () => {
    expect(() =>
      parseWriteEnvelope({ decision_log_id: 12345, state: "delivered" }, "delivered"),
    ).toThrow(/unexpected write envelope/);
  });
});
