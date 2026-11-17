import * as React from "react";
import { renderHook, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createUiClient } from "@masarx/api";
import { useResourceQuery } from "../../packages/ui/src/hooks/use-resource-query";

jest.mock("@masarx/api", () => ({ createUiClient: jest.fn() }));

const initialData = {
  items: [{ id: "server-page" }],
  total: 100,
  resource: "orders",
  keys: ["id"],
  limit: 25,
  offset: 0,
};

const initialParams = {
  resourceKey: "orders",
  filters: null as Record<string, unknown> | null,
  sort: null as { key: string; direction: "asc" | "desc" } | null,
  limit: 25,
  offset: 0,
  initialData,
};

describe("server resource query hydration", () => {
  let queryClient: QueryClient;
  const listResource = jest.fn();

  beforeEach(() => {
    queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    listResource.mockReset().mockResolvedValue({
      ...initialData,
      items: [{ id: "fetched-page" }],
    });
    (createUiClient as jest.Mock).mockReturnValue({ listResource });
  });

  afterEach(() => queryClient.clear());

  function wrapper({ children }: { children: React.ReactNode }) {
    return <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>;
  }

  it("uses the server page without refetching the same parameters", () => {
    const { result } = renderHook((params) => useResourceQuery(params), {
      initialProps: initialParams,
      wrapper,
    });
    expect(result.current.data?.items).toEqual([{ id: "server-page" }]);
    expect(listResource).not.toHaveBeenCalled();
  });

  it.each([
    ["page", { offset: 25 }],
    ["page size", { limit: 50 }],
    ["filter", { filters: { status: "delivered" } }],
    ["sort", { sort: { key: "created_at", direction: "desc" as const } }],
    ["resource", { resourceKey: "shipments" }],
  ])("fetches when the %s changes instead of caching the server page", async (_name, changes) => {
    const { result, rerender } = renderHook((params) => useResourceQuery(params), {
      initialProps: initialParams,
      wrapper,
    });

    const nextParams = { ...initialParams, ...changes };
    rerender(nextParams);

    await waitFor(() => {
      expect(result.current.data?.items).toEqual([{ id: "fetched-page" }]);
    });
    expect(listResource).toHaveBeenCalledWith(
      nextParams.resourceKey,
      nextParams.filters ?? {},
      nextParams.limit,
      nextParams.offset,
      nextParams.sort
    );

    rerender(initialParams);
    await waitFor(() => {
      expect(result.current.data?.items).toEqual([{ id: "server-page" }]);
    });
    expect(listResource).toHaveBeenCalledTimes(1);
  });
});
