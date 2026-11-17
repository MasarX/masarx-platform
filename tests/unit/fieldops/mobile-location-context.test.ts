import * as fs from "node:fs";
import * as path from "node:path";
import * as ts from "typescript";
import { createOutbox } from "../../../packages/mobile-core/src";
import { createMemoryOutboxStore } from "../mobile-core/memory-outbox-fixture";
import { assertLocationPingReceipt, createFieldOpsLocationExecutor, verifyRouteLocationContext } from "../../../apps/fieldops/src/mobile-location-context";
const run = "4d1fbd36-6b6e-4c35-acc4-5e3ad9043830";
const stop = "22222222-2222-4222-8222-222222222222";
const actor = "33333333-3333-4333-8333-333333333333";
const resourceId = "44444444-4444-4444-8444-444444444444";
const pingId = "55555555-5555-4555-8555-555555555555";
function wrap(execute: any, read: any, identity: any) {
  return createFieldOpsLocationExecutor(execute, read, identity, async expected => {
    if (await identity() !== expected) throw new Error("actor changed");
    return execute;
  });
}
const context = { resource: "tasks", resourceId, actorId: actor, routeRunId: run, routeStopId: stop };
const detail = { id: resourceId, route_run_id: run, route_stop_id: stop };
const scopedArgs = { p_ping: { idempotency_key: "same-key", route_run_id: run, route_stop_id: stop,
  metadata: { route_location_context: context, attestation: { untouched: true } } } };
describe("explicit route location context", () => {
  test("revalidates exact API resource and actor", async () => {
    const read = jest.fn(async () => detail);
    await expect(verifyRouteLocationContext(context, read, actor)).resolves.toEqual(context);
    expect(read).toHaveBeenCalledWith("tasks", resourceId);
  });
  test.each([null, run])("rejects missing/foreign actor %s before resource read", async id => {
    const read = jest.fn();
    await expect(verifyRouteLocationContext(context, read, id)).rejects.toThrow();
    expect(read).not.toHaveBeenCalled();
  });
  test.each([null, {}, { ...detail, id: run }, { ...detail, route_run_id: stop }, { ...detail, route_stop_id: run }])(
    "rejects unavailable or changed current resource %j", async value => {
      await expect(verifyRouteLocationContext(context, async () => value, actor)).rejects.toThrow();
    });
  test("permission errors propagate without cached fallback", async () => {
    const denied = new Error("scope denied");
    await expect(verifyRouteLocationContext(context, async () => { throw denied; }, actor)).rejects.toBe(denied);
  });
});
describe("FieldOps ping receipt boundary", () => {
  test.each([true, false])("accepts exact created/replay receipt %s", created => {
    expect(assertLocationPingReceipt([{ location_ping_id: pingId, created }])).toEqual({ locationPingId: pingId, created });
  });
  test.each([null, [], [{}], [{ location_ping_id: pingId }], [{ location_ping_id: "fake", created: true }],
    [{ location_ping_id: pingId, created: "true" }], [{ location_ping_id: pingId, created: true }, {}]])(
    "rejects missing or malformed receipt %j", value => expect(() => assertLocationPingReceipt(value)).toThrow());
  test("unrelated legacy calls pass through unchanged", async () => {
    const execute = jest.fn(async () => ({ arbitrary: "legacy" }));
    const read = jest.fn(); const identity = jest.fn();
    const wrapped = wrap(execute, read, identity);
    await expect(wrapped("other_rpc", { a: 1 })).resolves.toEqual({ arbitrary: "legacy" });
    expect(execute).toHaveBeenCalledWith("other_rpc", { a: 1 }, "rpc");
    expect(read).not.toHaveBeenCalled(); expect(identity).not.toHaveBeenCalled();
  });
  test("scoped execution revalidates and keeps arguments/idempotency/attestation", async () => {
    const execute = jest.fn(async (_rpc: string, _args: Record<string, unknown>) => [{ location_ping_id: pingId, created: false }]);
    const wrapped = wrap(execute, async () => detail, async () => actor);
    await wrapped("record_location_ping_v1", scopedArgs);
    expect(execute.mock.calls[0][1]).toBe(scopedArgs);
  });
  test("arbitrary route without capture authority cannot execute", async () => {
    const execute = jest.fn();
    const wrapped = wrap(execute, async () => detail, async () => actor);
    await expect(wrapped("record_location_ping_v1", { p_ping: { route_run_id: run } })).rejects.toThrow();
    expect(execute).not.toHaveBeenCalled();
  });
  test("unscoped background ping needs receipt but no route lookup", async () => {
    const read = jest.fn(); const identity = jest.fn();
    const wrapped = wrap(async () => [{ location_ping_id: pingId, created: true }], read, identity);
    await wrapped("record_location_ping_v1", { p_ping: { metadata: { source: "mobile_background" } } });
    expect(read).not.toHaveBeenCalled(); expect(identity).not.toHaveBeenCalled();
  });
  test("invalid receipt stays in actual outbox, valid replay removes same identity", async () => {
    const store = createMemoryOutboxStore(); const outbox = createOutbox(store); await outbox.init();
    await outbox.enqueue({ id: "queue-key", rpc: "record_location_ping_v1", args: scopedArgs });
    const wrapped = wrap(async () => null, async () => detail, async () => actor);
    const failed = await outbox.sync(wrapped, { shouldRetry: () => false });
    expect(failed.succeeded).toBe(0); expect(await store.get("queue-key")).not.toBeNull();
    await store.update("queue-key", { status: "queued", next_attempt_at: null });
    const execute = jest.fn(async (_rpc: string, _args: Record<string, unknown>) => [{ location_ping_id: pingId, created: false }]);
    const done = await outbox.sync(wrap(execute, async () => detail, async () => actor));
    expect(done.succeededIds).toEqual(["queue-key"]); expect(await store.get("queue-key")).toBeNull();
    expect(execute.mock.calls[0][1]).toEqual(scopedArgs);
  });
  test("network failure preserves executor error and idempotency arguments", async () => {
    const error = new TypeError("Failed to fetch");
    const execute = jest.fn(async (_rpc: string, _args: Record<string, unknown>) => { throw error; });
    await expect(wrap(execute, async () => detail, async () => actor)(
      "record_location_ping_v1", scopedArgs)).rejects.toBe(error);
    expect(execute.mock.calls[0][1]).toBe(scopedArgs);
  });
});
test("actual App uses explicit scoped foreground flow and rechecks after attestation", () => {
  const source = fs.readFileSync(path.resolve("apps/fieldops/App.tsx"), "utf8").replace(/\r/g, "");
  expect(source).toContain('testID="mobile-route-location"');
  expect(source).toContain('createFieldOpsLocationExecutor(');
  expect(source).toContain('routeLocationContext={routeLocationContext}');
  expect(source).toContain('routeLocationCurrent.current.context !== captured');
  const start = source.indexOf("function LocationScreen(");
  const end = source.indexOf("\nfunction ", start + 1);
  const screen = source.slice(start, end < 0 ? undefined : end);
  expect(screen).toContain('const scoped = routeLocationContext ? await verifyLocationScope?.() : null');
  expect(screen).toContain('const current = await verifyLocationScope?.()');
  expect(screen).toContain('...(scoped ? { route_run_id: scoped.routeRunId, route_stop_id: scoped.routeStopId } : {})');
  expect(screen).toContain('...(attestation ? { attestation } : {})');
});

const appText = fs.readFileSync(path.resolve("apps/fieldops/App.tsx"), "utf8");
const ast = ts.createSourceFile("App.tsx", appText, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
function findNode(root: ts.Node, predicate: (node: ts.Node) => boolean): ts.Node {
  let result: ts.Node | undefined;
  function visit(node: ts.Node) { if (result) return; if (predicate(node)) { result = node; return; } ts.forEachChild(node, visit); }
  visit(root); if (!result) throw new Error("Actual App node not found"); return result;
}
function evaluate(node: ts.Node, values: Record<string, unknown>) {
  const source = ts.transpileModule("return (" + node.getText(ast) + ");", {
    compilerOptions: { target: ts.ScriptTarget.ES2020, module: ts.ModuleKind.CommonJS },
  }).outputText;
  return Function(...Object.keys(values), source)(...Object.values(values));
}
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(r => { resolve = r; }); return { promise, resolve }; }
const wrapperCall = findNode(ast, node => ts.isCallExpression(node) && node.expression.getText(ast) === "createFieldOpsLocationExecutor") as ts.CallExpression;
describe("actual App scoped dispatch binding", () => {
  test("actor switching during resource lookup blocks before RPC", async () => {
    const read = deferred<unknown>();
    let session = { user: { id: actor }, access_token: "test-token-original" };
    const rpc = jest.fn();
    const bind = evaluate(wrapperCall.arguments[3], { client: { auth: { getSession: async () => ({ data: { session }, error: null }) }, rpc } });
    const execute = jest.fn();
    const wrapped = createFieldOpsLocationExecutor(execute, () => read.promise, async () => actor, bind);
    const pending = wrapped("record_location_ping_v1", scopedArgs);
    session = { user: { id: run }, access_token: "test-token-other" };
    read.resolve(detail);
    await expect(pending).rejects.toThrow("actor changed");
    expect(rpc).not.toHaveBeenCalled(); expect(execute).not.toHaveBeenCalled();
  });
  test("actual dispatch uses captured actor token despite later session switch", async () => {
    let session = { user: { id: actor }, access_token: "test-token-original" };
    const setHeader = jest.fn(async () => ({ data: [{ location_ping_id: pingId, created: true }], error: null }));
    const rpc = jest.fn(() => ({ setHeader }));
    const bind = evaluate(wrapperCall.arguments[3], { client: { auth: { getSession: async () => ({ data: { session }, error: null }) }, rpc } });
    const pinned = await bind(actor);
    session = { user: { id: run }, access_token: "test-token-other" };
    await pinned("record_location_ping_v1", scopedArgs, "rpc");
    expect(setHeader).toHaveBeenCalledWith("Authorization", "Bearer test-token-original");
    expect(rpc).toHaveBeenCalledWith("record_location_ping_v1", scopedArgs);
  });
});
describe("actual App navigation and deferred handlers (not mounted React proof)", () => {
  const scopeVar = findNode(ast, node => ts.isVariableDeclaration(node) && node.name.getText(ast) === "verifyLocationScope") as ts.VariableDeclaration;
  const location = findNode(ast, node => ts.isFunctionDeclaration(node) && node.name?.text === "LocationScreen");
  const queueVar = findNode(location, node => ts.isVariableDeclaration(node) && node.name.getText(ast) === "queuePing") as ts.VariableDeclaration;
  const scopeEffect = findNode(ast, node => ts.isArrowFunction(node) && node.body.getText(ast).includes('activeScreen !== "location"') && node.body.getText(ast).includes("setRouteLocationContext(null)"));
  test.each(["clear", "navigation", "actor"] as const)("rejects %s while fresh detail is pending", async event => {
    const read = deferred<unknown>();
    const current: { current: { context: typeof context | null; actor: string } } = { current: { context, actor } };
    const verify = evaluate(scopeVar.initializer!, {
      routeLocationCurrent: current, verifyRouteLocationContext,
      uiClient: { getResource: () => read.promise }, strings: { scan: { routeLocationChanged: "changed" } },
    });
    const pending = verify();
    if (event === "actor") current.current.actor = run; else current.current.context = null;
    read.resolve(detail);
    await expect(pending).rejects.toThrow("changed");
  });
  test("effect retains explicit context on location but clears on navigation and actor change", () => {
    const setContext = jest.fn();
    const executeEffect = (activeScreen: string, actorId: string) => evaluate(scopeEffect, {
      activeScreen, routeLocationContext: context, me: { user: { id: actorId } }, setRouteLocationContext: setContext,
    })();
    executeEffect("location", actor); expect(setContext).not.toHaveBeenCalled();
    executeEffect("tasks", actor); expect(setContext).toHaveBeenLastCalledWith(null);
    setContext.mockClear();
    executeEffect("location", run); expect(setContext).toHaveBeenLastCalledWith(null);
  });
  test.each(["clear", "navigation", "actor"] as const)("actual queue rejects %s during attestation", async event => {
    const attestation = deferred<null>(); const started = deferred<void>();
    let current: typeof context | null = context;
    const enqueue = jest.fn(); const alert = jest.fn(); const loading = jest.fn();
    const queue = evaluate(queueVar.initializer!, {
      isQueueingPingRef: { current: false }, setIsQueueingPing: loading,
      deviceId: resourceId, trackingPolicyQuery: { isLoading: false }, trackingPolicyUnavailable: false,
      trackingEnabled: true, position: { coords: { latitude: 1, longitude: 2, accuracy: 1 } },
      locationPolicy: { maxAccuracyM: 10 }, routeLocationContext: context,
      verifyLocationScope: async () => current,
      buildAttestationEnvelope: async () => { started.resolve(); return attestation.promise; },
      readContextId: () => null, policyContext: {}, createOutboxId: () => "stable-queue-key",
      outbox: { enqueue }, queryClient: { invalidateQueries: jest.fn() }, online: true, syncing: false,
      onSync: jest.fn(), Alert: { alert }, formatUnknownError: (error: Error) => error.message,
      strings: { scan: { routeLocationChanged: "changed", routeLocationBlocked: "blocked" } },
    });
    const pending = queue(); await started.promise;
    current = event === "actor" ? { ...context, actorId: run } : null;
    attestation.resolve(null); await pending;
    expect(enqueue).not.toHaveBeenCalled(); expect(alert).toHaveBeenCalledWith("blocked", "changed");
    expect(loading).toHaveBeenLastCalledWith(false);
  });
});
