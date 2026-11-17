import { act, renderHook, waitFor } from "@testing-library/react";
import React from "react";
import { QueryClient, QueryClientProvider, QueryObserver } from "@tanstack/react-query";
import { useOptimisticMutation } from "../../packages/ui/src/optimistic";
import {
  useResourceQuery,
  useResourceListInvalidate,
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

  describe("Mutation cache refresh behavior", () => {
    test.each(["list", "optimistic-success", "optimistic-error"] as const)(
      "%s refetches active matching lists, invalidates inactive matches, and leaves other resources alone",
      async (operation) => {
        const client = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity, gcTime: Infinity } } });
        const entries = [
          { key: resourceQueryKey("shipments", { limit: 50, offset: 0 }), active: true },
          { key: resourceQueryKey("shipments", { limit: 50, offset: 50, filters: { status: "ready" } }), active: true },
          { key: resourceQueryKey("shipments", { limit: 50, offset: 100 }), active: false },
          { key: resourceQueryKey("orders", { limit: 50, offset: 0 }), active: true },
        ].map((entry) => ({ ...entry, fetch: jest.fn(async () => ["fresh"]) }));
        const unsubscribes: Array<() => void> = [];
        entries.forEach((entry) => {
          client.setQueryDefaults(entry.key, { queryFn: entry.fetch });
          client.setQueryData(entry.key, ["before"]);
          if (entry.active) {
            const observer = new QueryObserver(client, { queryKey: entry.key, queryFn: entry.fetch });
            unsubscribes.push(observer.subscribe(() => {}));
          }
        });
        const onError = jest.fn();
        const mutationFn = jest.fn(async () => {
          if (operation === "optimistic-error") throw new Error("mutation failed");
          return "saved";
        });
        const wrapper = ({ children }: { children: React.ReactNode }) => (
          <QueryClientProvider client={client}>{children}</QueryClientProvider>
        );
        const hook = renderHook(() => ({
          invalidate: useResourceListInvalidate("shipments"),
          mutation: useOptimisticMutation({
            queryKey: ["resource", "shipments"],
            mutationFn,
            optimisticUpdate: () => ["optimistic"],
            onError,
          }),
        }), { wrapper });
        try {
          entries.forEach((entry) => expect(entry.fetch).not.toHaveBeenCalled());
          await act(async () => {
            if (operation === "list") await hook.result.current.invalidate();
            else if (operation === "optimistic-error") {
              await expect(hook.result.current.mutation.mutateAsync()).rejects.toThrow("mutation failed");
            } else await hook.result.current.mutation.mutateAsync();
          });
          await waitFor(() => {
            entries.slice(0, 2).forEach((entry) => {
              expect(entry.fetch).toHaveBeenCalledTimes(1);
              expect(client.getQueryData(entry.key)).toEqual(["fresh"]);
              expect(client.getQueryState(entry.key)?.isInvalidated).toBe(false);
            });
          });
          const inactive = entries[2]!;
          expect(inactive.fetch).not.toHaveBeenCalled();
          expect(client.getQueryData(inactive.key)).toEqual(["before"]);
          expect(client.getQueryState(inactive.key)?.isInvalidated).toBe(true);
          const unrelated = entries[3]!;
          expect(unrelated.fetch).not.toHaveBeenCalled();
          expect(client.getQueryData(unrelated.key)).toEqual(["before"]);
          expect(client.getQueryState(unrelated.key)?.isInvalidated).toBe(false);
          expect(onError).toHaveBeenCalledTimes(operation === "optimistic-error" ? 1 : 0);
          expect(mutationFn).toHaveBeenCalledTimes(operation === "list" ? 0 : 1);
        } finally {
          hook.unmount();
          unsubscribes.forEach((unsubscribe) => unsubscribe());
          client.clear();
        }
      },
    );
  });

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
