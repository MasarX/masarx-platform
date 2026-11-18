// Unit coverage for the mobile-v2 trace-context helper. Closes the audit's
// MINOR follow-up by pinning the contract for newMobileV2Uuid /
// uuidToTraceId / newSpanId / newMobileV2TraceContext / emitMobileV2TraceEvent
// so callRpc's correlation-id emission stays predictable across RN targets.

import {
  emitMobileV2TraceEvent,
  newMobileV2TraceContext,
  newMobileV2Uuid,
  newSpanId,
  uuidToTraceId,
} from "../../../apps/fieldops/src/mobile-v2-trace-context";

const UUID_CANONICAL_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const TRACE_ID_RE = /^[0-9a-f]{32}$/;
const SPAN_ID_RE = /^[0-9a-f]{16}$/;
const TRACEPARENT_RE = /^00-[0-9a-f]{32}-[0-9a-f]{16}-01$/;

describe("newMobileV2Uuid", () => {
  test("produces a canonical RFC 4122 v4 UUID", () => {
    const out = newMobileV2Uuid();
    expect(UUID_CANONICAL_RE.test(out)).toBe(true);
    // v4 byte 6 high nibble must be 4, byte 8 high nibble must be 8/9/a/b
    expect(out[14]).toBe("4");
    expect(["8", "9", "a", "b"]).toContain(out[19]?.toLowerCase());
  });

  test("returns a fresh UUID on each call", () => {
    const a = newMobileV2Uuid();
    const b = newMobileV2Uuid();
    expect(a).not.toBe(b);
  });
});

describe("uuidToTraceId", () => {
  test("strips dashes and lowercases", () => {
    expect(uuidToTraceId("AAAAAAAA-BBBB-4CCC-9DDD-EEEEEEEEEEEE")).toBe(
      "aaaaaaaabbbb4ccc9dddeeeeeeeeeeee",
    );
    expect(TRACE_ID_RE.test(uuidToTraceId(newMobileV2Uuid()))).toBe(true);
  });

  test("throws on non-canonical input", () => {
    expect(() => uuidToTraceId("not-a-uuid")).toThrow(/not a canonical UUID/);
  });
});

describe("newSpanId", () => {
  test("produces a 16-char hex string", () => {
    const out = newSpanId();
    expect(SPAN_ID_RE.test(out)).toBe(true);
  });

  test("returns a fresh id on each call", () => {
    expect(newSpanId()).not.toBe(newSpanId());
  });
});

describe("newMobileV2TraceContext", () => {
  test("returns a frozen context with a valid W3C traceparent", () => {
    const ctx = newMobileV2TraceContext();
    expect(UUID_CANONICAL_RE.test(ctx.correlationId)).toBe(true);
    expect(TRACE_ID_RE.test(ctx.traceId)).toBe(true);
    expect(SPAN_ID_RE.test(ctx.parentId)).toBe(true);
    expect(TRACEPARENT_RE.test(ctx.traceparent)).toBe(true);
    expect(Object.isFrozen(ctx)).toBe(true);
  });

  test("traceId is derived from correlationId via uuidToTraceId", () => {
    const ctx = newMobileV2TraceContext();
    expect(ctx.traceId).toBe(uuidToTraceId(ctx.correlationId));
  });

  test("traceparent embeds traceId and parentId verbatim", () => {
    const ctx = newMobileV2TraceContext();
    expect(ctx.traceparent).toBe(`00-${ctx.traceId}-${ctx.parentId}-01`);
  });
});

describe("emitMobileV2TraceEvent", () => {
  test("emits a console.debug line with the structured tag + body", () => {
    const spy = jest.spyOn(console, "debug").mockImplementation(() => {});
    try {
      emitMobileV2TraceEvent("rpc.start", {
        rpc: "submit_fieldops_proof_v1",
        correlationId: "00000000-0000-4000-8000-000000000001",
      });
      expect(spy).toHaveBeenCalledTimes(1);
      const [tag, body] = spy.mock.calls[0] ?? [];
      expect(tag).toBe("MV2-RPC");
      expect(typeof body).toBe("string");
      const parsed = JSON.parse(body as string);
      expect(parsed.step).toBe("rpc.start");
      expect(parsed.rpc).toBe("submit_fieldops_proof_v1");
      expect(parsed.correlationId).toBe("00000000-0000-4000-8000-000000000001");
      expect(typeof parsed.ts).toBe("string");
    } finally {
      spy.mockRestore();
    }
  });

  test("swallows logging errors without throwing", () => {
    const spy = jest.spyOn(console, "debug").mockImplementation(() => {
      throw new Error("console broke");
    });
    try {
      expect(() =>
        emitMobileV2TraceEvent("rpc.end", { rpc: "x", correlationId: "y" }),
      ).not.toThrow();
    } finally {
      spy.mockRestore();
    }
  });
});
