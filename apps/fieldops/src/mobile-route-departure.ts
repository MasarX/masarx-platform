import { createSupabaseExecutor, type createMobileClient } from "@masarx/auth/mobile";
import type { createOutbox, OutboxEntry, RpcExecutor } from "@masarx/mobile-core";
import { boundedCompletionRead, completionScopeFromMe } from "./mobile-completion-readback-storage";

export const ROUTE_DEPARTURE_RPC = "ui_confirm_route_run_departure_v1";
type ActorScope = { actor: string; scope: string };
export type RouteDepartureInput = {
  routeRunId: string;
  routeStopId?: string | null;
  taskId?: string | null;
  opsSessionId?: string | null;
};
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid departure request.");
  return value as Record<string, unknown>;
}
function exactKeys(value: Record<string, unknown>, keys: string[]) {
  if (Object.keys(value).length !== keys.length || keys.some(key => !Object.hasOwn(value, key)))
    throw new Error("Invalid departure request fields.");
}
function actorScope(value: unknown): ActorScope {
  const context = record(value);
  exactKeys(context, ["actor", "scope"]);
  if (typeof context.actor !== "string" || !uuid.test(context.actor) || typeof context.scope !== "string")
    throw new Error("Departure requires an authenticated scope.");
  let parts: unknown;
  try { parts = JSON.parse(context.scope); } catch { throw new Error("Invalid departure scope."); }
  if (!Array.isArray(parts) || parts.length !== 3 || typeof parts[0] !== "string" || !uuid.test(parts[0]) ||
      typeof parts[1] !== "string" || !parts[1].trim() ||
      !(parts[2] === null || typeof parts[2] === "string" && uuid.test(parts[2])))
    throw new Error("Invalid departure scope.");
  return { actor: context.actor, scope: context.scope };
}
export function routeDepartureQueueId(context: ActorScope, routeRunId: string) {
  actorScope(context);
  if (!uuid.test(routeRunId)) throw new Error("Invalid departure route.");
  return "fieldops:departure:v1:" + JSON.stringify([context.actor, context.scope, routeRunId]);
}
function departureArgs(value: unknown) {
  const args = record(value);
  exactKeys(args, ["p_input", "fieldops_departure_context"]);
  const context = actorScope(args.fieldops_departure_context);
  const input = record(args.p_input);
  exactKeys(input, ["route_run_id", "route_stop_id", "task_id", "ops_session_id"]);
  if (typeof input.route_run_id !== "string" || !uuid.test(input.route_run_id) ||
      ["route_stop_id", "task_id", "ops_session_id"].some(key =>
        !(input[key] === null || typeof input[key] === "string" && uuid.test(input[key] as string))))
    throw new Error("Invalid departure lineage.");
  return { context, input };
}
export async function enqueueRouteDeparture(
  outbox: Pick<ReturnType<typeof createOutbox>, "enqueue">,
  context: ActorScope, input: RouteDepartureInput, actionLabel: string,
) {
  const args = {
    p_input: { route_run_id: input.routeRunId, route_stop_id: input.routeStopId ?? null,
      task_id: input.taskId ?? null, ops_session_id: input.opsSessionId ?? null },
    fieldops_departure_context: context,
  };
  departureArgs(args);
  const id = routeDepartureQueueId(context, input.routeRunId);
  // Both stores insert-if-absent: double taps and restarted callers retain the same intent.
  const entry = await outbox.enqueue({ id, rpc: ROUTE_DEPARTURE_RPC, transport: "rpc", args,
    display: { actionLabel, targetLabel: input.routeRunId } });
  const saved = departureArgs(entry.args);
  if (entry.rpc !== ROUTE_DEPARTURE_RPC || (entry.transport ?? "rpc") !== "rpc" ||
      entry.id !== id || saved.context.actor !== context.actor || saved.context.scope !== context.scope ||
      Object.keys(args.p_input).some(key => saved.input[key] !== args.p_input[key as keyof typeof args.p_input]))
    throw new Error("A different departure request is already retained. Review Outbox before retrying.");
  return entry;
}
export function routeDepartureRequestState(entry: OutboxEntry | null | undefined) {
  return !entry ? "none" : entry.status === "dead" ? "blocked" : "pending";
}
export function createRouteDepartureExecutor(
  client: ReturnType<typeof createMobileClient>, execute: RpcExecutor,
): RpcExecutor {
  return async (rpc, args, transport = "rpc") => {
    if (rpc !== ROUTE_DEPARTURE_RPC) return execute(rpc, args, transport);
    if (transport !== "rpc") throw new Error("Departure requires canonical RPC transport.");
    const { context, input } = departureArgs(args);
    const user = await boundedCompletionRead(() => client.auth.getUser());
    if (user.error) throw user.error;
    if (user.data.user?.id !== context.actor) throw new Error("Departure account changed.");
    const sessionResult = await boundedCompletionRead(() => client.auth.getSession());
    if (sessionResult.error) throw sessionResult.error;
    const session = sessionResult.data.session;
    if (session?.user.id !== context.actor || !session.access_token)
      throw new Error("Departure session is unavailable.");
    const token = session.access_token;
    // Both reads and mutation reuse genuine transport-error classification under the verified token.
    const bound = (signal?: AbortSignal) => createSupabaseExecutor({ rpc: (name: string, payload: Record<string, unknown>) => {
      const request = client.schema("api").rpc(name, payload).setHeader("Authorization", `Bearer ${token}`);
      return signal ? request.abortSignal(signal) : request;
    } } as unknown as ReturnType<typeof createMobileClient>);
    const me = await boundedCompletionRead(signal => bound(signal)("ui_me_v1", {}, "rpc"));
    const verified = completionScopeFromMe(me, context.actor);
    if (!verified || verified.scope !== context.scope) throw new Error("Departure scope changed.");
    const current = await boundedCompletionRead(() => client.auth.getSession());
    if (current.error) throw current.error;
    if (current.data.session?.user.id !== context.actor || current.data.session.access_token !== token)
      throw new Error("Departure session changed before dispatch.");
    return bound()(rpc, { p_input: input }, "rpc");
  };
}
