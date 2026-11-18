import {
  mobileV2FindTerminalRouteStopStatus,
  mobileV2RouteHasStopStatus,
  refreshMobileV2PodReadback,
  mobileV2ShouldReturnToStopAfterTerminalReadback,
  mobileV2StopDetailHasCodCollectionReadback,
  mobileV2StopDetailHasPartialParcelSubset,
  mobileV2StopDetailHasPodReadback,
  mobileV2TasksHaveRouteStopStatus,
} from "../../../apps/fieldops/src/mobile-v2-pod-readback";

describe("refreshMobileV2PodReadback", () => {
  test("returns ok only after every same-context readback refetch succeeds", async () => {
    const calls: string[] = [];
    const result = await refreshMobileV2PodReadback([
      { label: "stop-detail", refetch: async () => { calls.push("stop-detail"); return { isError: false }; } },
      { label: "route", refetch: async () => { calls.push("route"); return { isError: false }; } },
      { label: "tasks", refetch: async () => { calls.push("tasks"); return { isError: false }; } },
    ]);

    expect(result).toEqual({ ok: true, failedLabels: [] });
    expect(calls).toEqual(["stop-detail", "route", "tasks"]);
  });

  test("reports any query readback that resolves in an error state", async () => {
    await expect(
      refreshMobileV2PodReadback([
        { label: "stop-detail", refetch: async () => ({ isError: false }) },
        { label: "route", refetch: async () => ({ isError: true }) },
      ], { attempts: 1 }),
    ).resolves.toEqual({ ok: false, failedLabels: ["route"] });
  });

  test("reports thrown readback failures without throwing to the UI path", async () => {
    await expect(
      refreshMobileV2PodReadback([
        { label: "stop-detail", refetch: async () => { throw new Error("offline"); } },
      ], { attempts: 1 }),
    ).resolves.toEqual({ ok: false, failedLabels: ["stop-detail"] });
  });

  test("fails a successful refetch when the backend readback state is not present", async () => {
    await expect(
      refreshMobileV2PodReadback([
        {
          label: "route",
          refetch: async () => ({ isError: false, data: { rows: [{ id: "stop:1", status: "pending" }] } }),
          expect: (data) => mobileV2RouteHasStopStatus(data, "stop:1", "done"),
        },
      ], { attempts: 1 }),
    ).resolves.toEqual({ ok: false, failedLabels: ["route"] });
  });

  test("retries until the backend-backed projection catches up", async () => {
    let calls = 0;

    await expect(
      refreshMobileV2PodReadback([
        {
          label: "route",
          refetch: async () => {
            calls += 1;
            return {
              isError: false,
              data: { rows: [{ id: "stop:1", status: calls >= 3 ? "done" : "pending" }] },
            };
          },
          expect: (data) => mobileV2RouteHasStopStatus(data, "stop:1", "done"),
        },
      ], { attempts: 4, delayMs: 0 }),
    ).resolves.toEqual({ ok: true, failedLabels: [] });
    expect(calls).toBe(3);
  });
});

describe("Mobile V2 POD readback validators", () => {
  test("requires delivered stop detail proof checklist to be backend-marked done", () => {
    expect(
      mobileV2StopDetailHasPodReadback(
        { proofChecklist: [{ status: "done" }, { status: "done" }] },
        "delivered",
      ),
    ).toBe(true);
    expect(
      mobileV2StopDetailHasPodReadback(
        { proofChecklist: [{ status: "done" }, { status: "pending" }] },
        "delivered",
      ),
    ).toBe(false);
  });

  test("can scope delivered stop-detail readback to the policy-backed POD methods", () => {
    expect(
      mobileV2StopDetailHasPodReadback(
        {
          proofChecklist: [
            { key: "scan", status: "done" },
            { key: "photo", status: "done" },
            { key: "sig", status: "done" },
            { key: "cod", status: "pending" },
          ],
        },
        "delivered",
        ["scan", "photo", "sig"],
      ),
    ).toBe(true);
    expect(
      mobileV2StopDetailHasPodReadback(
        {
          proofChecklist: [
            { key: "scan", status: "done" },
            { key: "photo", status: "pending" },
            { key: "sig", status: "done" },
          ],
        },
        "delivered",
        ["scan", "photo", "sig"],
      ),
    ).toBe(false);
  });

  test("accepts partial POD stop-detail readback with backend-marked proof checklist", () => {
    expect(
      mobileV2StopDetailHasPodReadback(
        {
          parcels: [
            { code: "BOX:1", status: "scanned" },
            { code: "BOX:2", status: "pending" },
            { code: "BOX:3", status: "pending" },
          ],
          proofChecklist: [
            { key: "scan", status: "done" },
            { key: "photo", status: "done" },
            { key: "sig", status: "done" },
          ],
        },
        "partial",
        ["scan", "photo", "sig"],
        ["BOX:1"],
      ),
    ).toBe(true);
    expect(
      mobileV2StopDetailHasPodReadback(
        {
          parcels: [
            { code: "BOX:1", status: "scanned" },
            { code: "BOX:2", status: "pending" },
          ],
          proofChecklist: [
            { key: "scan", status: "done" },
            { key: "photo", status: "pending" },
            { key: "sig", status: "done" },
          ],
        },
        "partial",
        ["scan", "photo", "sig"],
        ["BOX:1"],
      ),
    ).toBe(false);
  });

  test("requires partial POD stop-detail readback to show a strict parcel subset", () => {
    expect(
      mobileV2StopDetailHasPartialParcelSubset(
        {
          parcels: [
            { code: "BOX:1", status: "scanned" },
            { code: "BOX:2", status: "pending" },
            { code: "BOX:3", status: "pending" },
          ],
        },
        ["BOX:1"],
      ),
    ).toBe(true);
    expect(
      mobileV2StopDetailHasPartialParcelSubset(
        {
          parcels: [
            { code: "BOX:1", status: "scanned" },
            { code: "BOX:2", status: "scanned" },
          ],
        },
        ["BOX:1", "BOX:2"],
      ),
    ).toBe(false);
    expect(
      mobileV2StopDetailHasPartialParcelSubset(
        {
          parcels: [
            { code: "BOX:1", status: "scanned" },
            { code: "BOX:2", status: "pending" },
          ],
        },
        ["BOX:2"],
      ),
    ).toBe(false);
  });


  test("requires failed stop detail to include the backend failure timeline", () => {
    expect(
      mobileV2StopDetailHasPodReadback(
        { timeline: [{ tone: "danger", icon: "alert" }] },
        "failed",
      ),
    ).toBe(true);
    expect(
      mobileV2StopDetailHasPodReadback(
        { timeline: [{ tone: "neutral", icon: "check" }] },
        "failed",
      ),
    ).toBe(false);
  });

  test("requires COD collection readback to match collected backend amounts", () => {
    expect(
      mobileV2StopDetailHasCodCollectionReadback(
        {
          paymentCollection: {
            outcome: "collected",
            expectedAmount: 42.5,
            collectedAmount: 42.5,
          },
        },
        42.5,
      ),
    ).toBe(true);
    expect(
      mobileV2StopDetailHasCodCollectionReadback(
        {
          paymentCollection: {
            outcome: "collected",
            expectedAmount: 42.5,
            collectedAmount: 40,
          },
        },
        42.5,
      ),
    ).toBe(false);
    expect(
      mobileV2StopDetailHasCodCollectionReadback(
        {
          paymentCollection: {
            outcome: "pending",
            expectedAmount: 42.5,
            collectedAmount: 42.5,
          },
        },
        42.5,
      ),
    ).toBe(false);
  });

  test("matches route and task projections by the canonical stop task id", () => {
    expect(
      mobileV2RouteHasStopStatus(
        { rows: [{ id: "stop:abc", status: "done" }, { id: "stop:def", status: "pending" }] },
        "stop:abc",
        "done",
      ),
    ).toBe(true);
    expect(
      mobileV2TasksHaveRouteStopStatus(
        [{ task_id: "stop:abc", meta: { route_stop_status: "done" } }],
        "stop:abc",
        "done",
      ),
    ).toBe(true);
    expect(
      mobileV2RouteHasStopStatus(
        { rows: [{ id: "stop:partial", status: "partial" }] },
        "stop:partial",
        "partial",
      ),
    ).toBe(true);
    expect(
      mobileV2TasksHaveRouteStopStatus(
        [{ task_id: "stop:partial", meta: { route_stop_status: "partial" } }],
        "stop:partial",
        "partial",
      ),
    ).toBe(true);
  });

  test("finds only terminal route stop statuses for duplicate-submit guards", () => {
    expect(
      mobileV2FindTerminalRouteStopStatus(
        [{ id: "stop:done", status: "done" }, { id: "stop:pending", status: "pending" }],
        "stop:done",
      ),
    ).toBe("done");
    expect(
      mobileV2FindTerminalRouteStopStatus(
        [{ id: "stop:failed", status: "failed" }],
        "stop:failed",
      ),
    ).toBe("failed");
    expect(
      mobileV2FindTerminalRouteStopStatus(
        [{ id: "stop:partial", status: "partial" }],
        "stop:partial",
      ),
    ).toBe("partial");
    expect(
      mobileV2FindTerminalRouteStopStatus(
        [{ id: "stop:pending", status: "pending" }],
        "stop:pending",
      ),
    ).toBeNull();
  });

  test("returns from the POD wizard when backend readback marks the stop terminal", () => {
    expect(mobileV2ShouldReturnToStopAfterTerminalReadback("mobile-pod", "done")).toBe(true);
    expect(mobileV2ShouldReturnToStopAfterTerminalReadback("mobile-pod", "failed")).toBe(true);
    expect(mobileV2ShouldReturnToStopAfterTerminalReadback("mobile-pod", "partial")).toBe(true);
    expect(mobileV2ShouldReturnToStopAfterTerminalReadback("mobile-pod", null)).toBe(false);
    expect(mobileV2ShouldReturnToStopAfterTerminalReadback("mobile-stop", "done")).toBe(false);
  });
});
