import { createClient } from "@supabase/supabase-js";
import { createSupabaseExecutor } from "../../packages/auth/src/mobile";
import { isRetriableNetworkError, isRetriableSupabaseError } from "../../packages/api/src/retry";
import { createOutbox } from "../../packages/mobile-core/src/outbox";
import { createMemoryOutboxStore } from "../../apps/fieldops/src/mobile-memory-store";

const shouldRetry = (error: unknown) => isRetriableNetworkError(error) || isRetriableSupabaseError(error);
function clientFor(fetch: typeof globalThis.fetch) {
  return createClient("https://rpc-proof.invalid", "test-only-key", {
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
    global: { fetch },
  });
}

describe("installed PostgREST network failure through mobile outbox", () => {
  afterEach(() => { jest.useRealTimers(); jest.restoreAllMocks(); });

  test("failed fetch remains retryable and the same command succeeds once after backoff", async () => {
    let now = Date.parse("2026-09-08T00:00:00Z");
    jest.useFakeTimers({ doNotFake: ["nextTick", "setImmediate", "setTimeout"] }); jest.setSystemTime(now);
    const fetch = jest.fn()
      .mockRejectedValueOnce(new TypeError("Failed to fetch"))
      .mockResolvedValue(new Response(JSON.stringify({ accepted: true }), {
        status: 200, headers: { "Content-Type": "application/json" },
      }));
    const store = createMemoryOutboxStore();
    const outbox = createOutbox(store);
    await outbox.init();
    const args = { p_action_key: "tasks.complete", p_idempotency_key: "network-retry-proof", p_actor: "4d1fbd36-6b6e-4c35-acc4-5e3ad9043830" };
    const queued = await outbox.enqueue({ rpc: "ui_execute_command_v1", args });
    const execute = createSupabaseExecutor(clientFor(fetch));
    const options = { shouldRetry, backoff: { base: 1, max: 1 } };
    expect(await outbox.sync(execute, options)).toMatchObject({ attempted: 1, failed: 1, dead: 0, succeeded: 0, succeededIds: [] });
    expect(await outbox.get(queued.id)).toMatchObject({ status: "failed", attempt_count: 1 });
    expect(fetch).toHaveBeenCalledTimes(1);
    now += 60_000; jest.setSystemTime(now);
    expect(await outbox.sync(execute, options)).toMatchObject({ attempted: 1, failed: 0, dead: 0, succeeded: 1, succeededIds: [queued.id] });
    expect(await outbox.get(queued.id)).toBeNull();
    expect(await outbox.sync(execute, options)).toMatchObject({ attempted: 0 });
    expect(fetch).toHaveBeenCalledTimes(2);
    const bodies = fetch.mock.calls.map(([, init]) => JSON.parse(String(init.body)));
    expect(bodies).toEqual([args, args]);
    expect(bodies[0]).toEqual(bodies[1]);
  });

  test.each(["Failed to fetch", "fetch failed", "NetworkError when attempting to fetch resource."])("preserves the installed wrapped cause for %s", async (message) => {
    const execute = createSupabaseExecutor(clientFor(jest.fn().mockRejectedValue(new TypeError(message))));
    const error = await execute("ui_execute_command_v1", {}).catch(error => error);
    expect(error).toBeInstanceOf(TypeError);
    expect(error.cause).toMatchObject({ message: `TypeError: ${message}`, code: "", hint: "" });
    expect(shouldRetry(error)).toBe(true);
  });

  test.each([401, 403, 400])("HTTP %i network-looking database text is not normalized", async (status) => {
    const body = { message: "TypeError: Failed to fetch", code: "42501", details: "", hint: "" };
    const execute = createSupabaseExecutor(clientFor(jest.fn().mockResolvedValue(new Response(JSON.stringify(body), {
      status, headers: { "Content-Type": "application/json" },
    }))));
    const error = await execute("ui_execute_command_v1", {}).catch(error => error);
    expect(error).toEqual(body);
    expect(shouldRetry(error)).toBe(false);
  });

  test.each([
    Object.assign(new Error("cancelled"), { name: "AbortError" }),
    Object.assign(new TypeError("fetch failed"), { cause: { name: "HeadersOverflowError", code: "UND_ERR_HEADERS_OVERFLOW" } }),
    new TypeError("invalid client input"),
  ])("does not turn cancellation or deterministic client failures into retryable writes: %s", async (original) => {
    const execute = createSupabaseExecutor(clientFor(jest.fn().mockRejectedValue(original)));
    const error = await execute("ui_execute_command_v1", {}).catch(error => error);
    expect(error).not.toBeInstanceOf(TypeError);
    expect(shouldRetry(error)).toBe(false);
  });
});
