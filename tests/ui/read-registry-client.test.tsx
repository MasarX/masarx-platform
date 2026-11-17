import { act, renderHook, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import * as React from "react";
import { createUiClient } from "@masarx/api";
import { useReadRegistry } from "../../packages/ui/src/read-registry-client";
jest.mock("@masarx/api", () => ({ ...jest.requireActual("@masarx/api"), createUiClient: jest.fn() }));

test.each([
  { userId: "b", scopeType: "tenant", scopeId: null, organizationId: "org-a" },
  { userId: "a", scopeType: "tenant", scopeId: null, organizationId: "org-b" },
  { userId: "a", scopeType: "platform", scopeId: null, organizationId: "org-a" },
])("identity changes do not reuse or accept late prior registry data: %p", async (next) => {
  let resolveOld!: (value: unknown) => void;
  const old = new Promise((resolve) => { resolveOld = resolve; });
  const readRegistry = jest.fn().mockReturnValueOnce(old).mockResolvedValueOnce({ resources: [{ key: "new" }] });
  (createUiClient as jest.Mock).mockReturnValue({ readRegistry });
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: 60_000 } } });
  const wrapper = ({ children }: { children: React.ReactNode }) => <QueryClientProvider client={client}>{children}</QueryClientProvider>;
  const { result, rerender } = renderHook((props) => useReadRegistry(props), {
    wrapper, initialProps: { userId: "a", scopeType: "tenant", scopeId: null, organizationId: "org-a" },
  });
  await waitFor(() => expect(readRegistry).toHaveBeenCalledTimes(1));
  rerender(next);
  await waitFor(() => expect(result.current.data?.resources?.[0]?.key).toBe("new"));
  await act(async () => { resolveOld({ resources: [{ key: "old" }] }); await old; });
  expect(result.current.data?.resources?.[0]?.key).toBe("new");
  expect(readRegistry).toHaveBeenCalledTimes(2);
  client.clear();
});

test("missing actor never invokes the registry", () => {
  const readRegistry = jest.fn();
  (createUiClient as jest.Mock).mockReturnValue({ readRegistry });
  const client = new QueryClient();
  const wrapper = ({ children }: { children: React.ReactNode }) => <QueryClientProvider client={client}>{children}</QueryClientProvider>;
  renderHook(() => useReadRegistry({ scopeType: "platform" }), { wrapper });
  expect(readRegistry).not.toHaveBeenCalled();
  client.clear();
});

test("tenant with missing organization never invokes the registry", () => {
  const readRegistry = jest.fn();
  (createUiClient as jest.Mock).mockReturnValue({ readRegistry });
  const client = new QueryClient();
  const wrapper = ({ children }: { children: React.ReactNode }) => <QueryClientProvider client={client}>{children}</QueryClientProvider>;
  renderHook(() => useReadRegistry({ userId: "a", scopeType: "tenant", scopeId: null }), { wrapper });
  expect(readRegistry).not.toHaveBeenCalled();
  client.clear();
});
