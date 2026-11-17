import { extractScanContext } from "./mobile-shell-surface-helpers";

export type RouteLocationContext = {
  resource: string;
  resourceId: string;
  actorId: string;
  routeRunId: string;
  routeStopId: string | null;
};
type Executor = (rpc: string, args: Record<string, unknown>, transport?: "rpc" | "edge") => Promise<unknown>;
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}
function invalid() { return new Error("Route location context is unavailable or changed."); }
export function parseRouteLocationContext(value: unknown): RouteLocationContext {
  const v = record(value);
  if (typeof v.resource !== "string" || !v.resource.trim() ||
    typeof v.resourceId !== "string" || !uuid.test(v.resourceId) ||
    typeof v.actorId !== "string" || !uuid.test(v.actorId) ||
    typeof v.routeRunId !== "string" || !uuid.test(v.routeRunId) ||
    !(v.routeStopId === null || typeof v.routeStopId === "string" && uuid.test(v.routeStopId))) throw invalid();
  return { resource: v.resource, resourceId: v.resourceId, actorId: v.actorId,
    routeRunId: v.routeRunId, routeStopId: v.routeStopId as string | null };
}
export async function verifyRouteLocationContext(
  value: unknown,
  readResource: (resource: string, id: string) => Promise<unknown>,
  actorId: string | null,
): Promise<RouteLocationContext> {
  const expected = parseRouteLocationContext(value);
  if (expected.actorId !== actorId) throw invalid();
  // Do not use React Query's cached detail or a caller-supplied route lookup.
  const detail = await readResource(expected.resource, expected.resourceId);
  if (record(detail).id !== expected.resourceId) throw invalid();
  const current = extractScanContext(detail, expected.resourceId);
  if (!current || current.routeRunId !== expected.routeRunId ||
    current.routeStopId !== expected.routeStopId) throw invalid();
  return expected;
}
export function assertLocationPingReceipt(value: unknown) {
  const rows = Array.isArray(value) ? value : [value];
  const row = record(rows[0]);
  if (rows.length !== 1 || typeof row.location_ping_id !== "string" ||
    !uuid.test(row.location_ping_id) || typeof row.created !== "boolean") {
    throw new Error("Location ping server receipt is missing or invalid.");
  }
  return { locationPingId: row.location_ping_id, created: row.created };
}
export function createFieldOpsLocationExecutor(
  execute: Executor,
  readResource: (resource: string, id: string) => Promise<unknown>,
  readActorId: () => Promise<string | null>,
  bindActor: (expectedActorId: string) => Promise<Executor>,
): Executor {
  return async (rpc, args, transport = "rpc") => {
    if (rpc !== "record_location_ping_v1" || transport !== "rpc") return execute(rpc, args, transport);
    const ping = record(args.p_ping);
    const metadata = record(ping.metadata);
    let dispatch = execute;
    if (ping.route_run_id != null || ping.route_stop_id != null || metadata.route_location_context != null) {
      const ctx = await verifyRouteLocationContext(metadata.route_location_context, readResource, await readActorId());
      if (ping.route_run_id !== ctx.routeRunId || (ping.route_stop_id ?? null) !== ctx.routeStopId) throw invalid();
      // Bind after the awaited visibility read; never dispatch through mutable auth.
      dispatch = await bindActor(ctx.actorId);
    }
    const result = await dispatch(rpc, args, transport);
    assertLocationPingReceipt(result);
    return result;
  };
}
