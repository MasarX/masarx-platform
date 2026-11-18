import { createOutbox } from "@masarx/mobile-core";
import { AuthApiError, AuthRetryableFetchError, AuthSessionMissingError } from "@supabase/supabase-js";
import { isRetriableNetworkError, isRetriableSupabaseError } from "@masarx/api";
import { createMemoryOutboxStore } from "../../../apps/fieldops/src/mobile-memory-store";
import { createRouteDepartureExecutor, enqueueRouteDeparture, routeDepartureQueueId,
  routeDepartureRequestState, ROUTE_DEPARTURE_RPC } from "../../../apps/fieldops/src/mobile-route-departure";

const actor = "4d1fbd36-6b6e-4c35-acc4-5e3ad9043830";
const org = "22222222-2222-4222-8222-222222222222";
const route = "33333333-3333-4333-8333-333333333333";
const stop = "44444444-4444-4444-8444-444444444444";
const task = "55555555-5555-4555-8555-555555555555";
const shift = "66666666-6666-4666-8666-666666666666";
const context = { actor, scope: JSON.stringify([org, "tenant", org]) };
const input = { routeRunId: route, routeStopId: stop, taskId: task, opsSessionId: shift };
const payload = { route_run_id: route, route_stop_id: stop, task_id: task, ops_session_id: shift };
const args = { p_input: payload, fieldops_departure_context: context };
const shouldRetry = (error: unknown) => isRetriableNetworkError(error) || isRetriableSupabaseError(error);

function nativeClient() {
  const headers: Array<[string, string, string]> = [];
  const server = jest.fn(async (_name: string, _values?: unknown) => ({ data: { route_run_id: route,
    route_departure: { confirmed_at: "2026-10-08T00:00:00Z" } }, error: null, status: 200 } as any));
  const me = { user: { id: actor }, org: { id: org }, access_scope: { scope_type: "tenant", scope_id: org } };
  const scopeRead = jest.fn(async () => ({ data: me, error: null, status: 200 } as any));
  const rpc = jest.fn((name: string, values?: unknown) => {
    const result = name === "ui_me_v1" ? scopeRead() : server(name, values);
    const builder = Object.assign(result, {
      setHeader: (key: string, value: string) => { headers.push([name, key, value]); return builder; },
      abortSignal: (_signal: AbortSignal) => builder,
    });
    return builder;
  });
  const client = {
    auth: {
      getUser: jest.fn(async () => ({ data: { user: { id: actor } }, error: null })),
      getSession: jest.fn(async () => ({ data: { session: { user: { id: actor }, access_token: "private-test-token" } }, error: null })),
    },
    schema: jest.fn((_schema: string) => ({ rpc })),
  };
  return { client, rpc, server, me, headers, scopeRead };
}

test("offline enqueue survives a restarted caller and duplicate taps without dispatch or optimistic confirmation", async () => {
  const store = createMemoryOutboxStore();
  const outbox = createOutbox(store);
  const [one, two] = await Promise.all([
    enqueueRouteDeparture(outbox, context, input, "Request departure"),
    enqueueRouteDeparture(outbox, context, input, "Request departure"),
  ]);
  expect(one.id).toBe(two.id);
  const reopened = await enqueueRouteDeparture(createOutbox(store), context, input, "Request departure");
  expect(reopened.id).toBe(one.id);
  expect(await store.countPending()).toBe(1);
  expect(reopened.args).toEqual(args);
  expect(reopened.display).toEqual({ actionLabel: "Request departure", targetLabel: route });
  expect(routeDepartureRequestState(reopened)).toBe("pending");
  expect(JSON.stringify(reopened)).not.toContain("confirmed_at");
  expect(JSON.stringify(reopened)).not.toContain("token");
});

test("retained intent cannot silently change route-stop/task/shift lineage", async () => {
  const store = createMemoryOutboxStore(), outbox = createOutbox(store);
  await enqueueRouteDeparture(outbox, context, input, "Request departure");
  await expect(enqueueRouteDeparture(outbox, context, { ...input, taskId: null }, "Request departure"))
    .rejects.toThrow("different departure request");
  expect((await store.get(routeDepartureQueueId(context, route)))?.args).toEqual(args);
});

test("durable enqueue failure is not presented as an accepted request", async () => {
  const enqueue = jest.fn().mockRejectedValue(new Error("disk full"));
  await expect(enqueueRouteDeparture({ enqueue }, context, input, "Request departure")).rejects.toThrow("disk full");
});

test("canonical dispatch uses only the existing four-field API payload and a captured actor token", async () => {
  const native = nativeClient(), fallback = jest.fn();
  await createRouteDepartureExecutor(native.client as any, fallback)(ROUTE_DEPARTURE_RPC, args);
  expect(native.server).toHaveBeenCalledWith(ROUTE_DEPARTURE_RPC, { p_input: payload });
  expect(native.client.schema.mock.calls.every(([schema]) => schema === "api")).toBe(true);
  expect(native.headers).toEqual([
    ["ui_me_v1", "Authorization", "Bearer private-test-token"],
    [ROUTE_DEPARTURE_RPC, "Authorization", "Bearer private-test-token"],
  ]);
  expect(fallback).not.toHaveBeenCalled();
});

test.each([
  {}, { p_input: payload }, { ...args, unexpected: true },
  { ...args, fieldops_departure_context: null },
  { ...args, fieldops_departure_context: { ...context, actor: "invalid" } },
  { ...args, fieldops_departure_context: { ...context, scope: "not-json" } },
  { ...args, fieldops_departure_context: { ...context, scope: "[]" } },
  { ...args, p_input: { ...payload, route_run_id: "invalid" } },
  { ...args, p_input: { ...payload, task_id: false } },
  { ...args, p_input: { ...payload, bypass: true } },
])("malformed or unbound departure cannot reach the server: %j", async invalid => {
  const native = nativeClient();
  await expect(createRouteDepartureExecutor(native.client as any, jest.fn())(ROUTE_DEPARTURE_RPC, invalid))
    .rejects.toThrow();
  expect(native.server).not.toHaveBeenCalled();
});

test.each(["actor", "scope", "session", "logout", "token"])("replay rejects changed %s", async change => {
  const native = nativeClient();
  if (change === "actor") native.client.auth.getUser.mockResolvedValue({ data: { user: { id: org } }, error: null });
  if (change === "scope") native.me.org.id = route;
  if (change === "session") native.client.auth.getSession.mockResolvedValue({
    data: { session: { user: { id: org }, access_token: "other" } }, error: null });
  if (change === "logout" || change === "token") native.client.auth.getSession
    .mockResolvedValueOnce({ data: { session: { user: { id: actor }, access_token: "private-test-token" } }, error: null })
    .mockResolvedValueOnce({ data: { session: change === "logout" ? null :
      { user: { id: actor }, access_token: "changed" } }, error: null } as any);
  await expect(createRouteDepartureExecutor(native.client as any, jest.fn())(ROUTE_DEPARTURE_RPC, args)).rejects.toThrow();
  expect(native.server).not.toHaveBeenCalled();
});

test("departure cannot use Edge transport; unrelated outbox RPCs keep their existing executor", async () => {
  const native = nativeClient(), fallback = jest.fn().mockResolvedValue("unchanged");
  const execute = createRouteDepartureExecutor(native.client as any, fallback);
  await expect(execute(ROUTE_DEPARTURE_RPC, args, "edge")).rejects.toThrow("canonical RPC");
  await expect(execute("record_scan_event_v1", { p_scan: {} }, "rpc")).resolves.toBe("unchanged");
  expect(fallback).toHaveBeenCalledWith("record_scan_event_v1", { p_scan: {} }, "rpc");
  expect(native.server).not.toHaveBeenCalled();
});

test.each(["user", "session", "current"])("transient %s auth-read errors retain the original intent for retry", async boundary => {
  for (const error of [new TypeError("Failed to fetch"), new AuthRetryableFetchError("Failed to fetch", 0),
    { status: 503, message: "Auth unavailable" }]) {
    const store = createMemoryOutboxStore(), outbox = createOutbox(store), native = nativeClient();
    const request = await enqueueRouteDeparture(outbox, context, input, "Request departure");
    const failed = { data: { user: null, session: null }, error } as any;
    if (boundary === "user") native.client.auth.getUser.mockResolvedValue(failed);
    if (boundary === "session") native.client.auth.getSession.mockResolvedValue(failed);
    if (boundary === "current") native.client.auth.getSession
      .mockResolvedValueOnce({ data: { session: { user: { id: actor }, access_token: "private-test-token" } }, error: null })
      .mockResolvedValue(failed);
    const execute = createRouteDepartureExecutor(native.client as any, jest.fn());
    const result = await outbox.sync(execute, { shouldRetry });
    expect(result).toMatchObject({ succeeded: 0, failed: 1, dead: 0 });
    const saved = await store.get(request.id);
    expect(saved?.args).toEqual(args);
    expect(saved?.status).toBe("failed");
    expect(routeDepartureRequestState(saved)).toBe("pending");
    expect(native.server).not.toHaveBeenCalled();
    // The executor also preserves object identity; generic account-change errors must not replace it.
    await expect(execute(ROUTE_DEPARTURE_RPC, args)).rejects.toBe(error);
  }
});

test.each([new AuthApiError("Invalid token", 401, "bad_jwt"), new AuthSessionMissingError()])(
  "permanent auth denial is blocked rather than endlessly retried: %s", async error => {
    const store = createMemoryOutboxStore(), outbox = createOutbox(store), native = nativeClient();
    const request = await enqueueRouteDeparture(outbox, context, input, "Request departure");
    native.client.auth.getUser.mockResolvedValue({ data: { user: null }, error } as any);
    expect(await outbox.sync(createRouteDepartureExecutor(native.client as any, jest.fn()), { shouldRetry }))
      .toMatchObject({ succeeded: 0, failed: 0, dead: 1 });
    const saved = await store.get(request.id);
    expect(saved?.args).toEqual(args);
    expect(routeDepartureRequestState(saved)).toBe("blocked");
    expect(native.server).not.toHaveBeenCalled();
  },
);

test("genuine scope-read fetch failures reuse existing PostgREST retry classification", async () => {
  const store = createMemoryOutboxStore(), outbox = createOutbox(store), native = nativeClient();
  const request = await enqueueRouteDeparture(outbox, context, input, "Request departure");
  native.scopeRead.mockResolvedValue({ data: null, status: 0,
    error: { code: "", hint: "", message: "TypeError: Failed to fetch" } });
  expect(await outbox.sync(createRouteDepartureExecutor(native.client as any, jest.fn()), { shouldRetry }))
    .toMatchObject({ succeeded: 0, failed: 1, dead: 0 });
  expect((await store.get(request.id))?.args).toEqual(args);
  expect(native.server).not.toHaveBeenCalled();
});

test.each(["user", "session", "scope", "current"])("bounded %s read timeout remains retryable and cannot dispatch departure", async boundary => {
  jest.useFakeTimers();
  try {
    const store = createMemoryOutboxStore(), outbox = createOutbox(store), native = nativeClient();
    const request = await enqueueRouteDeparture(outbox, context, input, "Request departure");
    const held = new Promise<never>(() => {});
    if (boundary === "user") native.client.auth.getUser.mockReturnValue(held);
    if (boundary === "session") native.client.auth.getSession.mockReturnValue(held);
    if (boundary === "scope") native.scopeRead.mockReturnValue(held);
    if (boundary === "current") native.client.auth.getSession
      .mockResolvedValueOnce({ data: { session: { user: { id: actor }, access_token: "private-test-token" } }, error: null })
      .mockReturnValue(held);
    const running = outbox.sync(createRouteDepartureExecutor(native.client as any, jest.fn()), { shouldRetry });
    await jest.advanceTimersByTimeAsync(5000);
    expect(await running).toMatchObject({ succeeded: 0, failed: 1, dead: 0 });
    const saved = await store.get(request.id);
    expect(saved?.args).toEqual(args);
    expect(saved?.status).toBe("failed");
    expect(routeDepartureRequestState(saved)).toBe("pending");
    expect(native.server).not.toHaveBeenCalled();
    expect(jest.getTimerCount()).toBe(0);
  } finally { jest.useRealTimers(); }
});

test("existing ordered drainer sends load scans before departure and observes success without replay", async () => {
  jest.useFakeTimers({ now: new Date("2026-10-08T00:00:00Z") });
  try {
  const store = createMemoryOutboxStore(), outbox = createOutbox(store), native = nativeClient();
  const order: string[] = [];
  await outbox.enqueue({ id: "scan", rpc: "record_scan_event_v1", args: { p_scan: {} } });
  jest.setSystemTime(new Date("2026-10-08T00:00:01Z"));
  const request = await enqueueRouteDeparture(outbox, context, input, "Request departure");
  const fallback = jest.fn(async (rpc: string) => { order.push(rpc); return {}; });
  native.server.mockImplementation(async (name: string) => { order.push(name); return { data: {}, error: null, status: 200 }; });
  const observer = jest.fn(async () => { throw new Error("readback unavailable"); });
  const execute = createRouteDepartureExecutor(native.client as any, fallback);
  const result = await outbox.sync(execute, { shouldRetry, onSucceeded: observer });
  expect(order).toEqual(["record_scan_event_v1", ROUTE_DEPARTURE_RPC]);
  expect(result.succeededIds).toContain(request.id);
  expect(await store.get(request.id)).toBeNull();
  expect((await outbox.sync(execute, { shouldRetry })).attempted).toBe(0);
  expect(native.server).toHaveBeenCalledTimes(1);
  // Neither a malformed acknowledgement nor a successful sync manufactures route confirmation.
  expect(routeDepartureRequestState(null)).toBe("none");
  } finally { jest.useRealTimers(); }
});

test.each([
  [{ code: "23514", message: "not ready for departure" }, "dead"],
  [{ code: "42501", message: "route ownership changed" }, "dead"],
  [{ code: "23514", message: "terminal route" }, "dead"],
  [{ code: "", hint: "", message: "TypeError: Failed to fetch" }, "failed"],
])("server denial or connection failure never confirms: %j", async (error, expected) => {
  const store = createMemoryOutboxStore(), outbox = createOutbox(store), native = nativeClient();
  const request = await enqueueRouteDeparture(outbox, context, input, "Request departure");
  native.server.mockResolvedValue({ data: null, error, status: expected === "failed" ? 0 : 400 });
  const result = await outbox.sync(createRouteDepartureExecutor(native.client as any, jest.fn()), { shouldRetry });
  expect(result.succeeded).toBe(0);
  const saved = await store.get(request.id);
  expect(saved?.status).toBe(expected);
  expect(routeDepartureRequestState(saved)).toBe(expected === "dead" ? "blocked" : "pending");
  expect(saved?.args).toEqual(args);
});
