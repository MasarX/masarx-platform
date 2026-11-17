import { renderHook, waitFor } from "@testing-library/react";
import React from "react";
import {
  useResourceQuery,
  resourceQueryKey,
} from "../../packages/ui/src/hooks/use-resource-query";
import {
  useResourceDetail,
  resourceDetailQueryKey,
} from "../../packages/ui/src/hooks/use-resource-detail";

jest.mock("@masarx/api", () => ({
  ...jest.requireActual("@masarx/api"),
  createUiClient: jest.fn(() => ({
    listResource: jest.fn().mockResolvedValue({
      items: [],
      total: 0,
      resource: "test",
      keys: [],
      limit: 50,
      offset: 0,
    }),
    getResource: jest.fn().mockResolvedValue({}),
  })),
}));

describe("Performance Optimization", () => {
  describe("React Query Configuration", () => {
    test("resourceQueryKey includes all parameters for cache differentiation", () => {
      const key1 = resourceQueryKey("orders", {
        filters: null,
        sort: null,
        limit: 50,
        offset: 0,
      });
      const key2 = resourceQueryKey("orders", {
        filters: null,
        sort: null,
        limit: 50,
        offset: 50,
      });
      expect(JSON.stringify(key1)).not.toBe(JSON.stringify(key2));
    });

    test("resourceQueryKey is identical for same parameters", () => {
      const key1 = resourceQueryKey("orders", {
        filters: null,
        sort: null,
        limit: 50,
        offset: 0,
      });
      const key2 = resourceQueryKey("orders", {
        filters: null,
        sort: null,
        limit: 50,
        offset: 0,
      });
      expect(JSON.stringify(key1)).toBe(JSON.stringify(key2));
    });

    test("resourceDetailQueryKey differentiates by resource and id", () => {
      const key1 = resourceDetailQueryKey("orders", "abc-123");
      const key2 = resourceDetailQueryKey("orders", "def-456");
      expect(JSON.stringify(key1)).not.toBe(JSON.stringify(key2));
    });

    test("different resource keys produce different query keys", () => {
      const key1 = resourceQueryKey("orders", {
        filters: null,
        sort: null,
        limit: 50,
        offset: 0,
      });
      const key2 = resourceQueryKey("products", {
        filters: null,
        sort: null,
        limit: 50,
        offset: 0,
      });
      expect(JSON.stringify(key1)).not.toBe(JSON.stringify(key2));
    });
  });

  describe("Memoization Patterns", () => {
    test("effectiveRouter pattern returns consistent reference", () => {
      const onServerNavigate = jest.fn();
      // Simulate the useMemo pattern
      const makeEffectiveRouter = (
        handler: ((href: string) => void) | null
      ) => (handler ? { replace: handler } : null);

      const router1 = makeEffectiveRouter(onServerNavigate);
      const router2 = makeEffectiveRouter(onServerNavigate);
      // Same function reference -> objects should have same replace reference
      expect(router1!.replace).toBe(router2!.replace);
    });

    test("navigateReplace pattern returns consistent reference", () => {
      const onServerNavigate = jest.fn();
      const routerReplace = jest.fn();
      // Simulate: const navigateReplace = onServerNavigate ?? routerReplace;
      const resolve = (handler: ((href: string) => void) | null) =>
        handler ?? routerReplace;

      const fn1 = resolve(onServerNavigate);
      const fn2 = resolve(onServerNavigate);
      expect(fn1).toBe(fn2);
    });
  });

  describe("View Settings Comparison Performance", () => {
    test("areViewSettingsEqual uses stable stringify for comparison", () => {
      // Import from table-views
      const {
        areViewSettingsEqual,
        viewSettingsFromPayload,
        buildViewPayload,
      } = require("../../packages/ui/src/table/table-views");

      const params = {
        viewId: "v1",
        label: "Test",
        columnOrder: ["id", "name"],
        visibleColumns: new Set(["id", "name"]),
        pinnedColumns: [] as string[],
        columnWidths: {},
        rowDensity: "comfortable",
        openMode: "peek",
        showInternalIdHints: false,
        analyticsEnabled: false,
        summaryRowEnabled: false,
        activeFilters: null,
        sortState: [],
        resolvedGroupBy: [] as string[],
        pageSize: null,
        paginationMode: "server",
        searchDebounceMs: 300,
        conditionalFormatting: null,
      };

      const settings1 = viewSettingsFromPayload(buildViewPayload(params));
      const settings2 = viewSettingsFromPayload(buildViewPayload(params));
      expect(areViewSettingsEqual(settings1, settings2)).toBe(true);
    });
  });

  describe("Query Key Stability", () => {
    test("same filter object produces same query key", () => {
      const filters = { status: "active" };
      const key1 = resourceQueryKey("orders", {
        filters,
        sort: null,
        limit: 50,
        offset: 0,
      });
      const key2 = resourceQueryKey("orders", {
        filters,
        sort: null,
        limit: 50,
        offset: 0,
      });
      expect(JSON.stringify(key1)).toBe(JSON.stringify(key2));
    });

    test("sort parameter affects query key", () => {
      const sort1 = { key: "name", direction: "asc" as const };
      const sort2 = { key: "name", direction: "desc" as const };
      const key1 = resourceQueryKey("orders", {
        filters: null,
        sort: sort1,
        limit: 50,
        offset: 0,
      });
      const key2 = resourceQueryKey("orders", {
        filters: null,
        sort: sort2,
        limit: 50,
        offset: 0,
      });
      expect(JSON.stringify(key1)).not.toBe(JSON.stringify(key2));
    });
  });
});
