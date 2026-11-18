jest.mock("../../packages/ui/src/i18n", () => ({
  resolveRowDisplayText: (english: string, arabic: unknown, locale?: string) =>
    locale?.startsWith("ar") && typeof arabic === "string" && arabic.trim() ? arabic.trim() : english,
}));

import { resolveResourceBulkActions } from "../../packages/ui/src/resource-actions-core";

const identityTranslate = (key: string) => key;

describe("resource actions for shipment label printing", () => {
  const printLabelsCommand = {
    key: "shipments.print_labels",
    label: "Print labels",
    capability: "labels.download",
    schema_category: "shipments",
    execution: {
      type: "print",
      rpc: "ui_execute_command_v1",
    },
    selection: {
      min_count: 1,
      max_count: 100,
    },
  } as never;

  test.each(["console", "portal"] as const)(
    "exposes the shared shipments.print_labels action for %s with label download permission",
    (appKey) => {
      const actions = resolveResourceBulkActions({
        t: identityTranslate,
        resourceKey: "shipments",
        resource: { key: "shipments", label: "Shipments" } as never,
        commands: [printLabelsCommand],
        appKey,
        appBasePath: appKey === "portal" ? "/portal" : "/console",
        downloadBasePath:
          appKey === "portal"
            ? "https://portal.example.test/api/resource-download"
            : "https://console.example.test/api/resource-download",
        userCapabilities: ["labels.download"],
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

  test("keeps label print blocked without labels.download permission", () => {
    const actions = resolveResourceBulkActions({
      t: identityTranslate,
      resourceKey: "shipments",
      resource: { key: "shipments", label: "Shipments" } as never,
      commands: [printLabelsCommand],
      appKey: "console",
      appBasePath: "/console",
      downloadBasePath: "https://console.example.test/api/resource-download",
      userCapabilities: ["shipments.print"],
    });

    expect(actions).toHaveLength(1);
    expect(actions[0].key).toBe("shipments.print_labels");
    expect(actions[0].disabledReason).toBe(
      "disabled.requiresCapability"
    );
  });
});

test("Arabic bulk action label preserves command authority", () => {
  const command = { key: "dispatch_exception_review.complete", label: "Resolve exception", label_ar: "حل الاستثناء", capability: "tasks.complete", schema_category: "resource:dispatch_exception_review", execution: { type: "rpc", rpc: "ui_execute_dispatch_exception_resolution_v1" } } as never;
  const input = { t: identityTranslate, resourceKey: "dispatch_exception_review", resource: { key: "dispatch_exception_review" } as never, commands: [command], appKey: "console" as const, appBasePath: "/console", downloadBasePath: "https://console.example.test/api/resource-download", userCapabilities: ["tasks.complete"] };
  expect(resolveResourceBulkActions({ ...input, locale: "ar" })[0]).toMatchObject({ key: "dispatch_exception_review.complete", label: "حل الاستثناء", disabledReason: null, execution: { type: "rpc", rpc: "ui_execute_dispatch_exception_resolution_v1" } });
  expect(resolveResourceBulkActions({ ...input, locale: "en" })[0].label).toBe("Resolve exception");
  expect(resolveResourceBulkActions({ ...input, locale: "ar", userCapabilities: [] })[0].disabledReason).toBeTruthy();
});
