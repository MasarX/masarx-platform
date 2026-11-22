import { fetchResourceMetrics, type MetricsClient } from "../../packages/ui/src/metrics-fetch";

describe("fetchResourceMetrics", () => {
  test("bounds fallback concurrency and ignores unsolicited metric rows", async () => {
    const keys = Array.from({ length: 13 }, (_, index) => `resource-${index}`);
    let active = 0;
    let peak = 0;
    const counts = await fetchResourceMetrics({
      dashboardMetrics: async () => ({ metrics: [{ resource: "unrequested", total: 99 }] }),
      listResource: async () => {
        active += 1;
        peak = Math.max(peak, active);
        await Promise.resolve();
        active -= 1;
        return { items: [{}] };
      },
    }, keys);

    expect(peak).toBe(6);
    expect(counts.has("unrequested")).toBe(false);
    expect([...counts]).toEqual(keys.map((key) => [key, null]));
  });

  function flushAsyncWork() {
    return new Promise<void>((resolve) => setTimeout(resolve, 0));
  }

  test("chunks dashboard metrics requests before falling back", async () => {
    const dashboardMetrics = jest
      .fn<ReturnType<MetricsClient["dashboardMetrics"]>, Parameters<MetricsClient["dashboardMetrics"]>>()
      .mockImplementation(async (resourceKeys) => ({
        metrics: resourceKeys.map((resource) => ({ resource, total: resource.length })),
      }));
    const listResource = jest.fn<
      ReturnType<MetricsClient["listResource"]>,
      Parameters<MetricsClient["listResource"]>
    >();

    const counts = await fetchResourceMetrics(
      { dashboardMetrics, listResource },
      ["shipments", "routes", "workflow_runs", "manual_review_tasks", "requests"],
      { bulkChunkSize: 2 },
    );

    expect(dashboardMetrics.mock.calls).toEqual([
      [["shipments", "routes"]],
      [["workflow_runs", "manual_review_tasks"]],
      [["requests"]],
    ]);
    expect(listResource).not.toHaveBeenCalled();
    expect(Array.from(counts.entries())).toEqual([
      ["shipments", "shipments".length],
      ["routes", "routes".length],
      ["workflow_runs", "workflow_runs".length],
      ["manual_review_tasks", "manual_review_tasks".length],
      ["requests", "requests".length],
    ]);
  });

  test("uses a safer default bulk chunk size for larger resource sets", async () => {
    const dashboardMetrics = jest
      .fn<ReturnType<MetricsClient["dashboardMetrics"]>, Parameters<MetricsClient["dashboardMetrics"]>>()
      .mockImplementation(async (resourceKeys) => ({
        metrics: resourceKeys.map((resource) => ({ resource, total: resource.length })),
      }));
    const listResource = jest.fn<
      ReturnType<MetricsClient["listResource"]>,
      Parameters<MetricsClient["listResource"]>
    >();

    const counts = await fetchResourceMetrics(
      { dashboardMetrics, listResource },
      [
        "warehouse_transfers",
        "shipments",
        "scan_events",
        "handling_units",
        "route_plans",
        "routes",
        "return_to_branch_shipments",
        "dispatch_exception_review",
        "dispatch_exception_review_mine",
        "unassigned_exceptions",
        "sla_deadline_alerts",
        "mis_sort_exceptions",
      ],
    );

    expect(dashboardMetrics.mock.calls).toEqual([
      [[
        "warehouse_transfers",
        "shipments",
        "scan_events",
        "handling_units",
        "route_plans",
        "routes",
      ]],
      [[
        "return_to_branch_shipments",
        "dispatch_exception_review",
        "dispatch_exception_review_mine",
        "unassigned_exceptions",
        "sla_deadline_alerts",
        "mis_sort_exceptions",
      ]],
    ]);
    expect(listResource).not.toHaveBeenCalled();
    expect(counts.get("warehouse_transfers")).toBe("warehouse_transfers".length);
    expect(counts.get("mis_sort_exceptions")).toBe("mis_sort_exceptions".length);
  });

  test("falls back only for unresolved resources when a dashboard chunk fails", async () => {
    const dashboardMetrics = jest
      .fn<ReturnType<MetricsClient["dashboardMetrics"]>, Parameters<MetricsClient["dashboardMetrics"]>>()
      .mockImplementation(async (resourceKeys) => {
        if (resourceKeys.includes("workflow_runs")) {
          throw new Error("statement timeout");
        }
        return {
          metrics: resourceKeys.map((resource) => ({ resource, total: resource.length })),
        };
      });
    const listResource = jest
      .fn<ReturnType<MetricsClient["listResource"]>, Parameters<MetricsClient["listResource"]>>()
      .mockImplementation(async (resourceKey) => ({
        items: [],
        total: resourceKey === "workflow_runs" ? 11 : 7,
      }));

    const counts = await fetchResourceMetrics(
      { dashboardMetrics, listResource },
      ["shipments", "routes", "workflow_runs", "manual_review_tasks"],
      { bulkChunkSize: 2 },
    );

    expect(dashboardMetrics.mock.calls).toEqual([
      [["shipments", "routes"]],
      [["workflow_runs", "manual_review_tasks"]],
    ]);
    expect(listResource.mock.calls).toEqual([
      ["workflow_runs", {}, 1, 0, null],
      ["manual_review_tasks", {}, 1, 0, null],
    ]);
    expect(Array.from(counts.entries())).toEqual([
      ["shipments", "shipments".length],
      ["routes", "routes".length],
      ["workflow_runs", 11],
      ["manual_review_tasks", 7],
    ]);
  });

  test("executes bulk dashboard chunks sequentially to avoid overlapping heavy probes", async () => {
    const deferreds: Array<{
      resolve: (value: { metrics: Array<{ resource: string; total: number }> }) => void;
    }> = [];
    const dashboardMetrics = jest
      .fn<ReturnType<MetricsClient["dashboardMetrics"]>, Parameters<MetricsClient["dashboardMetrics"]>>()
      .mockImplementation(
        () =>
          new Promise<{ metrics: Array<{ resource: string; total: number }> }>((resolve) => {
            deferreds.push({ resolve });
          }),
      );
    const listResource = jest.fn<
      ReturnType<MetricsClient["listResource"]>,
      Parameters<MetricsClient["listResource"]>
    >();

    const pending = fetchResourceMetrics(
      { dashboardMetrics, listResource },
      ["shipments", "routes", "workflow_runs"],
      { bulkChunkSize: 1 },
    );

    await flushAsyncWork();
    expect(dashboardMetrics).toHaveBeenCalledTimes(1);

    deferreds[0]?.resolve({ metrics: [{ resource: "shipments", total: 3 }] });
    await flushAsyncWork();
    expect(dashboardMetrics).toHaveBeenCalledTimes(2);

    deferreds[1]?.resolve({ metrics: [{ resource: "routes", total: 5 }] });
    await flushAsyncWork();
    expect(dashboardMetrics).toHaveBeenCalledTimes(3);

    deferreds[2]?.resolve({ metrics: [{ resource: "workflow_runs", total: 7 }] });
    await expect(pending).resolves.toEqual(
      new Map<string, number | null>([
        ["shipments", 3],
        ["routes", 5],
        ["workflow_runs", 7],
      ]),
    );
    expect(listResource).not.toHaveBeenCalled();
  });

  test("prefers resourceMetrics for direct metric probes when available", async () => {
    const dashboardMetrics = jest.fn<
      ReturnType<MetricsClient["dashboardMetrics"]>,
      Parameters<MetricsClient["dashboardMetrics"]>
    >();
    const listResource = jest.fn<
      ReturnType<MetricsClient["listResource"]>,
      Parameters<MetricsClient["listResource"]>
    >();
    const resourceMetrics = jest
      .fn<
        ReturnType<NonNullable<MetricsClient["resourceMetrics"]>>,
        Parameters<NonNullable<MetricsClient["resourceMetrics"]>>
      >()
      .mockResolvedValue({ total: 9 });

    const counts = await fetchResourceMetrics(
      { dashboardMetrics, listResource, resourceMetrics },
      ["routes"],
      { disableBulk: true },
    );

    expect(dashboardMetrics).not.toHaveBeenCalled();
    expect(resourceMetrics).toHaveBeenCalledWith("routes", {}, null);
    expect(listResource).not.toHaveBeenCalled();
    expect(Array.from(counts.entries())).toEqual([["routes", 9]]);
  });

  test("can skip the bulk rpc entirely when a caller opts into direct list fallback", async () => {
    const dashboardMetrics = jest.fn<
      ReturnType<MetricsClient["dashboardMetrics"]>,
      Parameters<MetricsClient["dashboardMetrics"]>
    >();
    const listResource = jest
      .fn<ReturnType<MetricsClient["listResource"]>, Parameters<MetricsClient["listResource"]>>()
      .mockImplementation(async (resourceKey) => ({
        items: [],
        total: resourceKey === "shipments" ? 3 : 5,
      }));

    const counts = await fetchResourceMetrics(
      { dashboardMetrics, listResource },
      ["shipments", "routes"],
      { disableBulk: true },
    );

    expect(dashboardMetrics).not.toHaveBeenCalled();
    expect(listResource.mock.calls).toEqual([
      ["shipments", {}, 1, 0, null],
      ["routes", {}, 1, 0, null],
    ]);
    expect(Array.from(counts.entries())).toEqual([
      ["shipments", 3],
      ["routes", 5],
    ]);
  });

  test("resolves synthetic shipment status metrics through resourceMetrics instead of unknown resources", async () => {
    const dashboardMetrics = jest.fn<
      ReturnType<MetricsClient["dashboardMetrics"]>,
      Parameters<MetricsClient["dashboardMetrics"]>
    >();
    const listResource = jest.fn<
      ReturnType<MetricsClient["listResource"]>,
      Parameters<MetricsClient["listResource"]>
    >().mockResolvedValue({
      items: [],
      total: 0,
    });
    const resourceMetrics = jest
      .fn<
        ReturnType<NonNullable<MetricsClient["resourceMetrics"]>>,
        Parameters<NonNullable<MetricsClient["resourceMetrics"]>>
      >()
      .mockImplementation(async (resourceKey, filters) => ({
        total:
          resourceKey === "shipments" && filters?.status === "in_transit"
            ? 4
            : resourceKey === "shipments" && filters?.status === "pending"
              ? 2
              : 0,
      }));

    const counts = await fetchResourceMetrics(
      { dashboardMetrics, listResource, resourceMetrics },
      ["shipments", "in_transit", "pending"],
      {
        disableBulk: true,
        syntheticMetrics: {
          in_transit: { resource: "shipments", filters: { status: "in_transit" } },
          pending: { resource: "shipments", filters: { status: "pending" } },
        },
      },
    );

    expect(dashboardMetrics).not.toHaveBeenCalled();
    expect(resourceMetrics.mock.calls).toEqual([
      ["shipments", {}, null],
      ["shipments", { status: "in_transit" }, null],
      ["shipments", { status: "pending" }, null],
    ]);
    expect(listResource).not.toHaveBeenCalled();
    expect(Array.from(counts.entries())).toEqual([
      ["shipments", 0],
      ["in_transit", 4],
      ["pending", 2],
    ]);
  });
});
