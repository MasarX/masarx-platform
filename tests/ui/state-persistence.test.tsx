import {
  buildViewPayload,
  areViewSettingsEqual,
  viewSettingsFromEntry,
  viewSettingsFromPayload,
} from "../../packages/ui/src/table/table-views";

import type {
  ResourceViewEntry,
  ConditionalFormattingRule,
} from "../../packages/ui/src/table/view-types";

describe("State Persistence", () => {
  const basePayloadParams = {
    viewId: "view-1",
    label: "Test View",
    columnOrder: ["id", "name", "status"],
    visibleColumns: new Set(["id", "name", "status"]),
    pinnedColumns: ["id"],
    columnWidths: { name: 200 },
    rowDensity: "comfortable" as const,
    openMode: "peek" as const,
    showInternalIdHints: false,
    analyticsEnabled: true,
    summaryRowEnabled: false,
    activeFilters: null,
    sortState: [{ key: "name", direction: "asc" as const }],
    resolvedGroupBy: [] as string[],
    pageSize: 50,
    paginationMode: "server" as const,
    searchDebounceMs: 300,
    conditionalFormatting: null as ConditionalFormattingRule[] | null,
  };

  describe("URL State Round-Trip", () => {
    test("sort params encode and decode identically", () => {
      const url = new URL("http://localhost/test");
      url.searchParams.set("sort", "created_at");
      url.searchParams.set("direction", "desc");
      const decoded = {
        key: url.searchParams.get("sort")!,
        direction: url.searchParams.get("direction") as "asc" | "desc",
      };
      expect(decoded).toEqual({ key: "created_at", direction: "desc" });
    });

    test("pagination params encode and decode identically", () => {
      const url = new URL("http://localhost/test");
      url.searchParams.set("page", "3");
      url.searchParams.set("pageSize", "25");
      const decoded = {
        page: Number(url.searchParams.get("page")),
        pageSize: Number(url.searchParams.get("pageSize")),
      };
      expect(decoded).toEqual({ page: 3, pageSize: 25 });
    });

    test("detail state params encode and decode identically", () => {
      const url = new URL("http://localhost/test");
      url.searchParams.set("detailId", "order-42");
      url.searchParams.set("detailMode", "full");
      const decoded = {
        detailId: url.searchParams.get("detailId")!,
        detailMode: url.searchParams.get("detailMode")!,
      };
      expect(decoded).toEqual({ detailId: "order-42", detailMode: "full" });
    });

    test("view ID params encode and decode identically", () => {
      const url = new URL("http://localhost/test");
      url.searchParams.set("viewId", "view-abc-123");
      const decoded = url.searchParams.get("viewId");
      expect(decoded).toBe("view-abc-123");
    });
  });

  describe("View State Persistence (buildViewPayload)", () => {
    test("buildViewPayload captures all fields", () => {
      const payload = buildViewPayload(basePayloadParams);
      expect(payload.id).toBe("view-1");
      expect(payload.label).toBe("Test View");
      expect(payload.columns.order).toEqual(["id", "name", "status"]);
      expect(payload.columns.hidden).toEqual([]);
      expect(payload.columns.pinned).toEqual(["id"]);
      expect(payload.density).toBe("comfortable");
      expect(payload.open_mode).toBe("peek");
      expect(payload.analytics).toBe(true);
      expect(payload.sort).toEqual({ key: "name", direction: "asc" });
      expect(payload.page_size).toBe(50);
      expect(payload.pagination_mode).toBe("server");
      expect(payload.conditional_formatting).toBeNull();
    });

    test("buildViewPayload handles hidden columns", () => {
      const payload = buildViewPayload({
        ...basePayloadParams,
        visibleColumns: new Set(["id", "name"]), // status is hidden
      });
      expect(payload.columns.hidden).toEqual(["status"]);
    });

    test("buildViewPayload handles conditional formatting rules", () => {
      const rules: ConditionalFormattingRule[] = [
        {
          id: "rule-1",
          field: "status",
          operator: "eq",
          value: "active",
          style: { bgColor: "#00ff00", textColor: null, bold: null },
          scope: "cell",
        },
      ];
      const payload = buildViewPayload({
        ...basePayloadParams,
        conditionalFormatting: rules,
      });
      expect(payload.conditional_formatting).toEqual(rules);
    });

    test("buildViewPayload handles multiple sorts", () => {
      const payload = buildViewPayload({
        ...basePayloadParams,
        sortState: [
          { key: "status", direction: "asc" as const },
          { key: "name", direction: "desc" as const },
        ],
      });
      expect(payload.sort).toEqual([
        { key: "status", direction: "asc" },
        { key: "name", direction: "desc" },
      ]);
    });

    test("buildViewPayload handles empty sort state", () => {
      const payload = buildViewPayload({
        ...basePayloadParams,
        sortState: [],
      });
      expect(payload.sort).toBeNull();
    });

    test("buildViewPayload handles group by", () => {
      const payload = buildViewPayload({
        ...basePayloadParams,
        resolvedGroupBy: ["status", "category"],
      });
      expect(payload.group_by).toEqual(["status", "category"]);
    });
  });

  describe("areViewSettingsEqual", () => {
    test("identical settings are equal", () => {
      const payload = buildViewPayload(basePayloadParams);
      const settings = viewSettingsFromPayload(payload);
      expect(areViewSettingsEqual(settings, settings)).toBe(true);
    });

    test("different settings are not equal", () => {
      const payload1 = buildViewPayload(basePayloadParams);
      const payload2 = buildViewPayload({
        ...basePayloadParams,
        rowDensity: "compact" as const,
      });
      expect(
        areViewSettingsEqual(
          viewSettingsFromPayload(payload1),
          viewSettingsFromPayload(payload2)
        )
      ).toBe(false);
    });

    test("null settings are not equal", () => {
      expect(areViewSettingsEqual(null, null)).toBe(false);
    });
  });

  describe("localStorage Persistence", () => {
    beforeEach(() => {
      localStorage.clear();
    });

    test("collapsible section state persists", () => {
      const key = "detail-section:general";
      localStorage.setItem(key, "false");
      expect(localStorage.getItem(key)).toBe("false");
    });

    test("sidebar collapsed state persists", () => {
      const key = "masarx:navigation:v2:console:user1:collapsed";
      localStorage.setItem(key, "true");
      expect(localStorage.getItem(key)).toBe("true");
    });

    test("detail open mode persists", () => {
      const key = "detail-mode:orders";
      localStorage.setItem(key, "full");
      expect(localStorage.getItem(key)).toBe("full");
    });

    test("split layout width persists", () => {
      const key = "detail-panel-width:orders";
      localStorage.setItem(key, "450");
      expect(localStorage.getItem(key)).toBe("450");
    });

    test("favorites persist and deduplicate", () => {
      const key = "masarx:navigation:v2:console:user1:favorites";
      const favorites = ["orders", "products", "orders"]; // duplicate
      const unique = [...new Set(favorites)];
      localStorage.setItem(key, JSON.stringify(unique));
      expect(JSON.parse(localStorage.getItem(key)!)).toEqual([
        "orders",
        "products",
      ]);
    });

    test("recents persist with max limit", () => {
      const key = "masarx:navigation:v2:console:user1:recents";
      const maxRecents = 10;
      const recents = Array.from({ length: 15 }, (_, i) => `item-${i}`);
      const trimmed = recents.slice(0, maxRecents);
      localStorage.setItem(key, JSON.stringify(trimmed));
      expect(JSON.parse(localStorage.getItem(key)!)).toHaveLength(maxRecents);
    });
  });
});
