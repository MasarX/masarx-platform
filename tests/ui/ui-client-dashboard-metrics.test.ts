import { createUiClientFromSupabase } from "../../packages/api/src/ui-client";

describe("createUiClientFromSupabase dashboardMetrics", () => {
  test("uses the dashboard metrics rpc and normalizes browser resource keys", async () => {
    const payload = {
      metrics: [{ resource: "routes", total: 4 }],
    };
    const client = {
      rpc: jest.fn().mockResolvedValue({
        data: payload,
        error: null,
      }),
    };

    const ui = createUiClientFromSupabase(client as never);

    await expect(
      ui.dashboardMetrics([" routes ", "routes", "", "shipments", "shipments"]),
    ).resolves.toEqual(payload);

    expect(client.rpc).toHaveBeenCalledTimes(1);
    expect(client.rpc).toHaveBeenCalledWith("ui_dashboard_metrics_v1", {
      p_resources: ["routes", "shipments"],
    });
  });

  test("loads lookup values through the canonical lookup RPC", async () => {
    const rows = [
      {
        value: "approved",
        label: "Approved",
        description: null,
        sort_order: 10,
        is_default: false,
        metadata: {},
      },
    ];
    const client = {
      rpc: jest.fn().mockResolvedValue({
        data: rows,
        error: null,
      }),
    };

    const ui = createUiClientFromSupabase(client as never);

    await expect(ui.rpc("list_lookup_values_v1", { p_category: "approval_status" })).resolves.toEqual(rows);

    expect(client.rpc).toHaveBeenCalledTimes(1);
    expect(client.rpc).toHaveBeenCalledWith("list_lookup_values_v1", {
      p_category: "approval_status",
    });
  });
});
