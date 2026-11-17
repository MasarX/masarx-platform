import { resolveResourceBulkActions } from "../../packages/ui/src/resource-actions-core";

const identityTranslate = (key: string) => key;

describe("resource actions for shipment label printing", () => {
  test.each(["console", "portal"] as const)(
    "exposes the shared shipments.print_labels action for %s",
    (appKey) => {
      const actions = resolveResourceBulkActions({
        t: identityTranslate,
        resourceKey: "shipments",
        resource: { key: "shipments", label: "Shipments" } as never,
        commands: [
          {
            key: "shipments.print_labels",
            label: "Print labels",
            capability: "shipments.print",
            schema_category: "shipments",
            execution: {
              type: "print",
              rpc: "ui_execute_command_v1",
            },
            selection: {
              min_count: 1,
              max_count: 100,
            },
          } as never,
        ],
        appKey,
        appBasePath: appKey === "portal" ? "/portal" : "/console",
        downloadBasePath:
          appKey === "portal"
            ? "https://portal.example.test/api/resource-download"
            : "https://console.example.test/api/resource-download",
        userCapabilities: ["shipments.print"],
      });

      expect(actions).toHaveLength(1);
      expect(actions[0].key).toBe("shipments.print_labels");
      expect(actions[0].label).toBe("Print labels");
      expect(actions[0].execution?.type).toBe("print");
      expect(actions[0].execution?.rpc).toBe("ui_execute_command_v1");
      expect(actions[0].disabledReason).toBeNull();
      expect(actions[0].selection).toMatchObject({
        min_count: 1,
        max_count: 100,
      });
    }
  );
});
