// Mobile V2 sheet-submit -> RPC -> offline-outbox integration coverage.
//
// Closes the open audit follow-up: the existing mobile-v2-rpc-outbox suite
// covers `isRetryableRpcError` + `drainMobileV2Outbox` in isolation, but
// nothing exercises the wrapper that actually performs the enqueue.
//
// All 20 `useFieldopsSubmit<X>Mutation` hooks funnel their write through
//   callRpcOrEnqueue(ctx, "<rpc>", { ...input, p_idempotency_key })
// so this suite drives `callRpcOrEnqueue` — the shared offline-outbox
// wrapper every sheet-submit hook composes — directly, plus the
// `drainMobileV2Outbox` replay path, proving the full chain end to end:
//
//   sheet submit -> RPC fails offline -> outbox.enqueue({ rpc, args })
//                -> device reconnects -> drain replays the exact RPC
//                -> idempotency key preserved so the DB dedupes a re-apply.
//
// Rendering the React Native hooks in root Jest is not possible (the Expo
// app pins React 19 while the root test env runs React 18); the wrapper is
// the integration seam and is fully behaviour-equivalent to test here.
//
// DB-side coverage is complementary, not duplicated: pgTAP
// `0zr_fieldops_mobile_v2_write_rpcs_pack.sql` +
// `fieldops_mobile_v2_auth_kyc_sheet_writes_pack_v2.sql` assert the write RPC
// signatures and 42501 RLS guards (incl. fieldops_v2_kyc_docs).

import type { SupabaseClient } from "@supabase/supabase-js";

import {
  callRpcOrEnqueue,
  drainMobileV2Outbox,
  isMissingRpcError,
  newIdempotencyKey,
  type MobileV2OutboxDrainBundle,
  type MobileV2OutboxHandle,
  type MobileV2RpcContext,
} from "../../../apps/fieldops/src/mobile-v2-rpc-hooks";

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

interface RpcCall {
  readonly schema: "public" | "api";
  readonly name: string;
  readonly params: Record<string, unknown>;
}

type RpcResult = { data: unknown; error: { message: string } | null };

/** Minimal fake SupabaseClient — `.schema("api").rpc()` is the production
 *  path and root `.rpc()` remains available for public-schema tests.
 *  Records every call so drain/replay assertions can read the exact
 *  params (idempotency key included). */
function makeRpcSupabase(
  impl: (name: string, params: Record<string, unknown>) => RpcResult,
): SupabaseClient & { readonly __calls: RpcCall[] } {
  const calls: RpcCall[] = [];
  const rpc = async (schema: "public" | "api", name: string, params: Record<string, unknown>) => {
    calls.push({ schema, name, params });
    return impl(name, params);
  };
  const client = {
    __calls: calls,
    rpc: async (name: string, params: Record<string, unknown>) => {
      return rpc("public", name, params);
    },
    schema: (schema: "api") => ({
      rpc: async (name: string, params: Record<string, unknown>) => {
        return rpc(schema, name, params);
      },
    }),
  };
  return client as unknown as SupabaseClient & { readonly __calls: RpcCall[] };
}

function offlineSupabase() {
  return makeRpcSupabase(() => ({
    data: null,
    error: { message: "Network request failed" },
  }));
}

function okSupabase(state = "done") {
  return makeRpcSupabase(() => ({
    data: { decision_log_id: `dl-${Math.random().toString(16).slice(2)}`, state },
    error: null,
  }));
}

interface OutboxSpy extends MobileV2OutboxHandle {
  readonly calls: Array<{ rpc: string; args: Record<string, unknown> }>;
}

function createOutboxSpy(): OutboxSpy {
  const calls: Array<{ rpc: string; args: Record<string, unknown> }> = [];
  return {
    calls,
    async enqueue(input) {
      calls.push({ rpc: input.rpc, args: input.args });
      return undefined;
    },
  };
}

interface DrainBundleSpy extends MobileV2OutboxDrainBundle {
  readonly entries: Array<{ rpc: string; args: Record<string, unknown> }>;
}

/** In-memory outbox with the full drain bundle (enqueue + sync + count). */
function createDrainBundle(): DrainBundleSpy {
  const entries: Array<{ rpc: string; args: Record<string, unknown> }> = [];
  return {
    entries,
    async enqueue(input) {
      entries.push({ rpc: input.rpc, args: input.args });
      return undefined;
    },
    async sync(executor, options) {
      const limit = options?.limit ?? 25;
      const slice = entries.splice(0, limit);
      let attempted = 0;
      let succeeded = 0;
      let failed = 0;
      for (const entry of slice) {
        attempted += 1;
        try {
          await executor(entry.rpc, entry.args);
          succeeded += 1;
        } catch {
          failed += 1;
          entries.push(entry); // requeue on replay failure — no silent loss
        }
      }
      return { attempted, succeeded, failed, dead: 0 };
    },
    async countPending() {
      return entries.length;
    },
  };
}

function ctxWith(
  supabase: SupabaseClient | null,
  outbox?: MobileV2OutboxHandle,
): MobileV2RpcContext {
  return { supabase, activeRole: "driver", outbox };
}

/** `callRpcOrEnqueue` awaits `outbox.enqueue` before re-throwing, so the
 *  queued write is durably persisted by the time the rejection settles.
 *  `flushTasks` is a belt-and-braces drain of any trailing microtask (e.g.
 *  the trace-event emit) before assertions read the spy. */
function flushTasks(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

// Representative param payloads for the 20 write RPCs every sheet submits.
// callRpcOrEnqueue forwards `params` verbatim to the outbox, so this also
// asserts no parameter is dropped/renamed in the offline path.
const WRITE_RPCS: ReadonlyArray<{ rpc: string; args: Record<string, unknown> }> =
  Object.freeze([
    { rpc: "submit_fieldops_proof_v1", args: { p_stop_id: "stop:1", p_outcome: "delivered", p_evidence: { photo: "f1" } } },
    { rpc: "advance_fieldops_trip_stage_v1", args: { p_trip_id: "TRIP-1", p_next_stage: "loading", p_seal_no: null } },
    { rpc: "induct_fieldops_parcel_v1", args: { p_bay: "B", p_tracking_number: "DLX-784583" } },
    { rpc: "sign_fieldops_cash_drop_v1", args: { p_expected_sar: 500, p_actual_sar: 500, p_supervisor_name: "Reem", p_photo_id: null } },
    { rpc: "request_fieldops_wallet_withdraw_v1", args: { p_amount_sar: 200 } },
    { rpc: "submit_fieldops_hold_decision_v1", args: { p_hold_id: "HLD-1", p_action: "reinduct", p_note: null } },
    { rpc: "release_fieldops_hub_pickup_v1", args: { p_queue_id: "Q-1", p_otp: "123456" } },
    { rpc: "mark_fieldops_return_received_v1", args: { p_stop_id: "stop:2" } },
    { rpc: "submit_fieldops_auth_otp_v1", args: { p_employee_id: "DRV-2041", p_otp: "654321" } },
    { rpc: "submit_fieldops_role_set_v1", args: { p_role_id: "driver" } },
    { rpc: "submit_fieldops_kyc_doc_v1", args: { p_doc_key: "national_id", p_storage_path: "kyc/nid.jpg" } },
    { rpc: "submit_fieldops_kyc_vehicle_v1", args: { p_plate: "RYD-4421", p_vin: "VIN-1", p_year: "2022", p_model: "Hiace", p_istimara_path: "kyc/i.jpg" } },
    { rpc: "submit_fieldops_vehicle_photos_v1", args: { p_angle_paths: { front: "vehicle/front.jpg", rear: "vehicle/rear.jpg", left: "vehicle/left.jpg", right: "vehicle/right.jpg" } } },
    { rpc: "record_fieldops_cleaning_check_v1", args: { p_checked_ids: ["cabin", "cargo"], p_photo_path: "clean/p.jpg" } },
    { rpc: "pass_fieldops_pre_shift_gate_v1", args: { p_shift_id: "SHIFT-1", p_health_ok: true } },
    { rpc: "submit_fieldops_incident_v1", args: { p_type_id: "collision", p_stop_id: null, p_severity: "high", p_statement: "x", p_photo_path: null } },
    { rpc: "submit_fieldops_reassign_v1", args: { p_stop_id: "stop:3", p_target_driver_id: "DRV-2102", p_reason: "out of zone" } },
    { rpc: "submit_fieldops_reschedule_v1", args: { p_stop_id: "stop:4", p_window_start: "2026-05-17T09:00:00Z", p_window_end: "2026-05-17T12:00:00Z", p_note: null } },
    { rpc: "submit_fieldops_damage_hold_v1", args: { p_parcel_id: "PCL-44", p_severity_id: "crushed", p_note: "Crushed corner", p_photo_path: "dmg/p.jpg" } },
    { rpc: "submit_fieldops_eod_recon_v1", args: { p_parcels_count: 40, p_mismatch_count: 0, p_cash_declared: 1200, p_cash_counted: 1200, p_wallet_status: "synced", p_route_run_id: "046b311e-33d2-4d07-802f-694d8698a1eb" } },
  ]);

// ---------------------------------------------------------------------------
// 1) Offline submit -> outbox enqueue, across every write RPC.
// ---------------------------------------------------------------------------

describe("callRpcOrEnqueue — offline submit enqueues the write", () => {
  test.each(WRITE_RPCS)(
    "$rpc — retryable failure enqueues { rpc, args } verbatim and rethrows",
    async ({ rpc, args }) => {
      const outbox = createOutboxSpy();
      const params = { ...args, p_idempotency_key: newIdempotencyKey() };
      const ctx = ctxWith(offlineSupabase(), outbox);

      await expect(callRpcOrEnqueue(ctx, rpc, params)).rejects.toThrow(rpc);
      await flushTasks();

      expect(outbox.calls).toHaveLength(1);
      const enqueued = outbox.calls[0];
      expect(enqueued?.rpc).toBe(rpc);
      // every parameter survives into the queued entry — no drop/rename.
      expect(enqueued?.args).toEqual(params);
      expect(String(enqueued?.args.p_idempotency_key)).toMatch(UUID_RE);
    },
  );

  test("HTTP 5xx is treated as retryable and enqueued", async () => {
    const outbox = createOutboxSpy();
    const ctx = ctxWith(
      makeRpcSupabase(() => ({ data: null, error: { message: "HTTP 503 Service Unavailable" } })),
      outbox,
    );
    await expect(
      callRpcOrEnqueue(ctx, "submit_fieldops_proof_v1", { p_stop_id: "s", p_idempotency_key: newIdempotencyKey() }),
    ).rejects.toThrow();
    await flushTasks();
    expect(outbox.calls).toHaveLength(1);
  });

  test("route departure confirmation queues the canonical UI wrapper input with shift lineage", async () => {
    const outbox = createOutboxSpy();
    const ctx = ctxWith(offlineSupabase(), outbox);
    const pInput = {
      route_run_id: "046b311e-33d2-4d07-802f-694d8698a1eb",
      route_stop_id: null,
      task_id: null,
      ops_session_id: "3777c339-7366-4a7e-9d90-6638aa40bea8",
    };

    await expect(
      callRpcOrEnqueue(ctx, "ui_confirm_route_run_departure_v1", { p_input: pInput }),
    ).rejects.toThrow("ui_confirm_route_run_departure_v1");
    await flushTasks();

    expect(outbox.calls).toEqual([
      { rpc: "ui_confirm_route_run_departure_v1", args: { p_input: pInput } },
    ]);
  });
});

// ---------------------------------------------------------------------------
// 2) Deterministic failures must NOT be silently queued — they would never
//    succeed on replay and the driver must see + act on them. Critical for
//    KYC: an RLS 42501 on fieldops_v2_kyc_docs has to surface, not loop.
// ---------------------------------------------------------------------------

describe("callRpcOrEnqueue — deterministic failures surface without enqueue", () => {
  const NON_RETRYABLE: ReadonlyArray<[string, string]> = [
    ["RLS denial 42501 (fieldops_v2_kyc_docs)", '42501: new row violates row-level security policy for table "fieldops_v2_kyc_docs"'],
    ["data exception 22001", "22001: value too long for type character varying(32)"],
    ["integrity violation 23505", "23505: duplicate key value violates unique constraint"],
    ["canonical route-stop task missing", "submit_fieldops_proof_v1: route_stop_execute task required for canonical closeout of stop 441c930e-8236-4c21-a660-4336201e722e"],
    ["invalid auth 28000", "28000: invalid authorization specification"],
    ["business rule raise P0001", "P0001: doc_key is not an allowed KYC document"],
    ["HTTP 403 Forbidden", "HTTP 403 Forbidden"],
    ["HTTP 404 Not Found", "HTTP 404 Not Found"],
  ];

  test.each(NON_RETRYABLE)(
    "%s — throws and does not enqueue",
    async (_label, message) => {
      const outbox = createOutboxSpy();
      const ctx = ctxWith(makeRpcSupabase(() => ({ data: null, error: { message } })), outbox);
      await expect(
        callRpcOrEnqueue(ctx, "submit_fieldops_kyc_doc_v1", {
          p_doc_key: "national_id",
          p_storage_path: "kyc/nid.jpg",
          p_idempotency_key: newIdempotencyKey(),
        }),
      ).rejects.toThrow();
      await flushTasks();
      expect(outbox.calls).toHaveLength(0);
    },
  );
});

// ---------------------------------------------------------------------------
// 3) Success path + resilience.
// ---------------------------------------------------------------------------

describe("callRpcOrEnqueue — success + resilience", () => {
  test("success returns the server payload and enqueues nothing", async () => {
    const outbox = createOutboxSpy();
    const supabase = okSupabase();
    const ctx = ctxWith(supabase, outbox);
    const result = (await callRpcOrEnqueue(ctx, "submit_fieldops_proof_v1", {
      p_stop_id: "stop:ok",
      p_idempotency_key: newIdempotencyKey(),
    })) as { decision_log_id?: unknown };
    expect(String(result.decision_log_id)).toMatch(/^dl-/);
    expect(supabase.__calls[0]?.schema).toBe("api");
    await flushTasks();
    expect(outbox.calls).toHaveLength(0);
  });

  test("retryable failure with no outbox configured still surfaces the error (no crash)", async () => {
    const ctx = ctxWith(offlineSupabase()); // preview gallery omits the outbox
    await expect(
      callRpcOrEnqueue(ctx, "submit_fieldops_proof_v1", { p_stop_id: "s", p_idempotency_key: newIdempotencyKey() }),
    ).rejects.toThrow("submit_fieldops_proof_v1");
  });

  test("missing api schema client support fails closed without enqueueing a root rpc replay", async () => {
    const outbox = createOutboxSpy();
    const rootCalls: Array<{ name: string; params: Record<string, unknown> }> = [];
    const rootOnlySupabase = {
      rpc: async (name: string, params: Record<string, unknown>) => {
        rootCalls.push({ name, params });
        return { data: { ok: true }, error: null };
      },
    } as unknown as SupabaseClient;
    await expect(
      callRpcOrEnqueue(ctxWith(rootOnlySupabase, outbox), "submit_fieldops_proof_v1", {
        p_stop_id: "s",
        p_idempotency_key: newIdempotencyKey(),
      }),
    ).rejects.toThrow("schema('api')");
    await flushTasks();
    expect(rootCalls).toHaveLength(0);
    expect(outbox.calls).toHaveLength(0);
  });

  test("a null supabase client surfaces a connection error and queues for replay", async () => {
    const outbox = createOutboxSpy();
    const ctx = ctxWith(null, outbox);
    // The mutation hooks short-circuit on a null client via isPreviewMode
    // before ever reaching callRpcOrEnqueue, so this is a defensive path: a
    // missing client mid-write is treated as a transient (retryable) fault
    // and queued for replay once the client connects.
    await expect(
      callRpcOrEnqueue(ctx, "submit_fieldops_proof_v1", {
        p_stop_id: "s",
        p_idempotency_key: newIdempotencyKey(),
      }),
    ).rejects.toThrow(/requires a connected supabase client/);
    await flushTasks();
    expect(outbox.calls).toHaveLength(1);
    expect(outbox.calls[0]?.rpc).toBe("submit_fieldops_proof_v1");
  });
});

// ---------------------------------------------------------------------------
// 4) Full offline -> reconnect chain: the queued write replays through a
//    healthy client and the idempotency key is preserved end to end.
// ---------------------------------------------------------------------------

describe("offline -> reconnect drain chain", () => {
  test("queued write replays the exact RPC + idempotency key on reconnect", async () => {
    const outbox = createDrainBundle();
    const idempotencyKey = newIdempotencyKey();
    const params = {
      p_stop_id: "stop:9",
      p_outcome: "delivered",
      p_evidence: { signature: "sig-blob" },
      p_idempotency_key: idempotencyKey,
    };

    // Offline submit — the write is queued, the failure surfaces.
    await expect(
      callRpcOrEnqueue(ctxWith(offlineSupabase(), outbox), "submit_fieldops_proof_v1", params),
    ).rejects.toThrow();
    await flushTasks();
    expect(await outbox.countPending()).toBe(1);

    // Device reconnects — the drainer replays through a healthy client.
    const online = okSupabase();
    const drain = await drainMobileV2Outbox({ supabase: online, outbox });
    expect(drain).toEqual({ attempted: 1, succeeded: 1, failed: 0, dead: 0 });
    expect(await outbox.countPending()).toBe(0);

    expect(online.__calls).toHaveLength(1);
    expect(online.__calls[0]?.schema).toBe("api");
    expect(online.__calls[0]?.name).toBe("submit_fieldops_proof_v1");
    expect(online.__calls[0]?.params).toEqual(params);
    // Same idempotency key replayed -> DB dedupes the double-apply.
    expect(online.__calls[0]?.params.p_idempotency_key).toBe(idempotencyKey);
  });

  test("a still-failing replay requeues the entry (no silent loss)", async () => {
    const outbox = createDrainBundle();
    await callRpcOrEnqueue(ctxWith(offlineSupabase(), outbox), "submit_fieldops_eod_recon_v1", {
      p_parcels_count: 40,
      p_route_run_id: "046b311e-33d2-4d07-802f-694d8698a1eb",
      p_idempotency_key: newIdempotencyKey(),
    }).catch(() => undefined);
    await flushTasks();
    expect(await outbox.countPending()).toBe(1);

    const drain = await drainMobileV2Outbox({ supabase: offlineSupabase(), outbox });
    expect(drain.failed).toBe(1);
    expect(drain.succeeded).toBe(0);
    expect(await outbox.countPending()).toBe(1);
  });

  test("manual force drain forwards forced replay for route load scan outbox entries", async () => {
    const outbox = createDrainBundle();
    const routeLoadScan = {
      p_scan: {
        route_run_id: "3f3f05ad-7c1c-4b5c-ab41-533e89e4b400",
        route_stop_id: "c021d810-4b0b-4ce0-afa0-8fd40fe9f2c8",
        shipment_id: "bc54c170-072d-4ede-b27d-b19f9f35f2aa",
        barcode: "MXFTCTXCOD00006298",
        scan_type: "load",
        captured_at: "2026-06-09T00:00:00.000Z",
      },
    };
    await outbox.enqueue({ rpc: "record_scan_event_v1", args: routeLoadScan });

    const online = okSupabase();
    const drain = await drainMobileV2Outbox({ supabase: online, outbox, force: true });

    expect(drain).toEqual({ attempted: 1, succeeded: 1, failed: 0, dead: 0 });
    expect(online.__calls[0]?.schema).toBe("api");
    expect(online.__calls[0]?.name).toBe("record_scan_event_v1");
    expect(online.__calls[0]?.params).toEqual(routeLoadScan);
  });

  test("drain is a no-op while the client is still booting (supabase null)", async () => {
    const outbox = createDrainBundle();
    await outbox.enqueue({ rpc: "submit_fieldops_proof_v1", args: { p_stop_id: "s" } });
    const drain = await drainMobileV2Outbox({ supabase: null, outbox });
    expect(drain).toEqual({ attempted: 0, succeeded: 0, failed: 0, dead: 0 });
    expect(await outbox.countPending()).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// E1 — isMissingRpcError classifier. The loader / rider / supervisor /
// profile role-home hooks use this to degrade to a typed fixture ONLY
// for a genuinely-absent resolver (not-yet-migrated DB), while every
// other failure still surfaces as an error card.
// ---------------------------------------------------------------------------

describe("isMissingRpcError — classifies a genuinely-absent resolver", () => {
  test("PostgREST PGRST202 (unknown RPC) is a missing-RPC error", () => {
    expect(
      isMissingRpcError(
        new Error(
          "mobile_v2_rpc:resolve_fieldops_loader_today_v1 failed — PGRST202: Could not find the function",
        ),
      ),
    ).toBe(true);
  });

  test("Postgres 42883 (undefined function) is a missing-RPC error", () => {
    expect(
      isMissingRpcError(new Error("failed — 42883: function ... does not exist")),
    ).toBe(true);
  });

  test("a 'could not find the function' schema-cache miss is a missing-RPC error", () => {
    expect(
      isMissingRpcError(
        new Error("Could not find the function public.resolve_fieldops_profile_v1 in the schema cache"),
      ),
    ).toBe(true);
  });

  test("an RLS denial (42501) is NOT a missing-RPC error — it must surface", () => {
    expect(
      isMissingRpcError(new Error("mobile_v2_rpc:x failed — 42501: row level security")),
    ).toBe(false);
  });

  test("a network fault is NOT a missing-RPC error — it must surface", () => {
    expect(isMissingRpcError(new Error("Network request failed"))).toBe(false);
    expect(isMissingRpcError(new Error("fetch failed: ETIMEDOUT"))).toBe(false);
  });

  test("null / undefined / empty inputs are not missing-RPC errors", () => {
    expect(isMissingRpcError(null)).toBe(false);
    expect(isMissingRpcError(undefined)).toBe(false);
    expect(isMissingRpcError(new Error(""))).toBe(false);
  });
});
