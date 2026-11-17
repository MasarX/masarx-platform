import { screen, fireEvent, waitFor, act } from "@testing-library/react";
import { ResourceTableClient } from "../../packages/ui/src/resource-table-client";
import { ResourceTable } from "../../packages/ui/src/resource-table";
import { useResourceQuery } from "../../packages/ui/src/hooks/use-resource-query";
import { renderWithIntl } from "./test-utils";

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

jest.mock("next/navigation", () => ({
  useRouter: () => ({ replace: jest.fn(), push: jest.fn(), refresh: jest.fn() }),
  useSearchParams: () => new URLSearchParams(),
  usePathname: () => "/test",
}));

jest.mock("@masarx/api", () => ({
  ...jest.requireActual("@masarx/api"),
  createUiClient: () => ({}),
}));

/**
 * Mock ResourceTable so we can inspect the props it receives without
 * rendering the full (complex) table internals.
 */
jest.mock("../../packages/ui/src/resource-table", () => ({
  ResourceTable: jest.fn((props: any) => {
    return (
      <div
        data-testid="mock-table"
        data-items={JSON.stringify(props.items?.length)}
        data-has-server-navigate={String(typeof props.onServerNavigate === "function")}
      />
    );
  }),
}));

jest.mock("../../packages/ui/src/resource-bulk-actions", () => ({
  ResourceBulkActions: () => null,
}));

jest.mock("../../packages/ui/src/hooks/use-resource-query", () => ({
  useResourceQuery: jest.fn(() => ({ data: null, isFetching: false })),
  resourceQueryKey: jest.fn(() => ["resource", "test"]),
  useResourceListInvalidate: jest.fn(() => jest.fn()),
}));

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const ResourceTableMock = ResourceTable as unknown as jest.Mock;
const useResourceQueryMock = useResourceQuery as jest.Mock;

const defaultColumns = [
  { key: "id", label: "ID" },
  { key: "name", label: "Name" },
];

const defaultItems = [
  { id: "1", name: "Alpha" },
  { id: "2", name: "Beta" },
];

function makeServerFetch(overrides?: Partial<Record<string, unknown>>) {
  return {
    resourceKey: "orders",
    baseHref: "/console/resources/orders",
    initialList: { items: defaultItems, total: 2, total_is_estimate: false },
    initialLimit: 25,
    initialOffset: 0,
    initialSort: null,
    initialFilters: null,
    initialTotalIsEstimate: false,
    searchParams: {},
    ...overrides,
  };
}

beforeEach(() => {
  ResourceTableMock.mockClear();
  useResourceQueryMock.mockClear();
  useResourceQueryMock.mockReturnValue({ data: null, isFetching: false });
  jest.spyOn(window.history, "replaceState").mockImplementation(() => {});
});

afterEach(() => {
  jest.restoreAllMocks();
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

test("renders table with items", () => {
  renderWithIntl(
    <ResourceTableClient columns={defaultColumns} items={defaultItems} />
  );

  const table = screen.getByTestId("mock-table");
  expect(table).toBeInTheDocument();
  expect(table.getAttribute("data-items")).toBe("2");
});

test("handleServerNavigate updates query state from href", () => {
  renderWithIntl(
    <ResourceTableClient
      columns={defaultColumns}
      items={defaultItems}
      serverFetch={makeServerFetch()}
    />
  );

  // The mock ResourceTable receives onServerNavigate as a prop.
  const lastCall = ResourceTableMock.mock.calls[ResourceTableMock.mock.calls.length - 1][0];
  expect(lastCall.onServerNavigate).toBeDefined();

  // Simulate a navigation to page 2 with sort.
  act(() => {
    lastCall.onServerNavigate(
      "/console/resources/orders?offset=25&limit=25&sort=name&direction=desc"
    );
  });

  // useResourceQuery should have been re-called with updated params after the
  // state change triggered a re-render.
  const latestQueryCall = useResourceQueryMock.mock.calls[useResourceQueryMock.mock.calls.length - 1][0];
  expect(latestQueryCall.offset).toBe(25);
  expect(latestQueryCall.limit).toBe(25);
  expect(latestQueryCall.sort).toEqual({ key: "name", direction: "desc" });
});

test("handleServerNavigate calls replaceState", () => {
  renderWithIntl(
    <ResourceTableClient
      columns={defaultColumns}
      items={defaultItems}
      serverFetch={makeServerFetch()}
    />
  );

  const lastCall = ResourceTableMock.mock.calls[ResourceTableMock.mock.calls.length - 1][0];

  act(() => {
    lastCall.onServerNavigate(
      "/console/resources/orders?offset=50&limit=25&sort=id&direction=asc"
    );
  });

  expect(window.history.replaceState).toHaveBeenCalled();
  const replaceCall = (window.history.replaceState as jest.Mock).mock.calls[0];
  // The third argument is the URL string: pathname + search
  expect(replaceCall[2]).toContain("?offset=50&limit=25&sort=id&direction=asc");
});

test("pagination updates offset state", async () => {
  // Provide enough items + total so the pagination bar renders.
  const serverFetch = makeServerFetch({
    initialList: {
      items: defaultItems,
      total: 100,
      total_is_estimate: false,
    },
    initialLimit: 25,
    initialOffset: 0,
  });

  useResourceQueryMock.mockReturnValue({
    data: { items: defaultItems, total: 100, total_is_estimate: false },
    isFetching: false,
  });

  renderWithIntl(
    <ResourceTableClient
      columns={defaultColumns}
      items={defaultItems}
      serverFetch={serverFetch}
    />
  );

  // The ClientPaginationBar renders "Next" buttons when there are multiple pages.
  const nextButton = await screen.findByRole("button", { name: /next/i });
  expect(nextButton).toBeInTheDocument();

  act(() => {
    fireEvent.click(nextButton);
  });

  // After clicking next, replaceState should have been called with offset=25.
  await waitFor(() => {
    expect(window.history.replaceState).toHaveBeenCalled();
    const calls = (window.history.replaceState as jest.Mock).mock.calls;
    const lastUrl = calls[calls.length - 1][2] as string;
    expect(lastUrl).toContain("offset=25");
  });
});

test("sorts trigger handleServerNavigate", () => {
  renderWithIntl(
    <ResourceTableClient
      columns={defaultColumns}
      items={defaultItems}
      serverFetch={makeServerFetch()}
    />
  );

  // Grab onServerNavigate from the mocked ResourceTable props.
  const lastCall = ResourceTableMock.mock.calls[ResourceTableMock.mock.calls.length - 1][0];
  expect(typeof lastCall.onServerNavigate).toBe("function");

  // Simulate a sort change via the navigate handler.
  act(() => {
    lastCall.onServerNavigate(
      "/console/resources/orders?sort=name&direction=asc&limit=25&offset=0"
    );
  });

  // Verify the query hook received updated sort params.
  const latestQueryCall = useResourceQueryMock.mock.calls[useResourceQueryMock.mock.calls.length - 1][0];
  expect(latestQueryCall.sort).toEqual({ key: "name", direction: "asc" });
  expect(latestQueryCall.offset).toBe(0);
});

test("initial state from serverFetch config", () => {
  const serverFetch = makeServerFetch({
    initialLimit: 10,
    initialOffset: 30,
    initialSort: { key: "created_at", direction: "desc" },
    initialFilters: { status: "active" },
  });

  renderWithIntl(
    <ResourceTableClient
      columns={defaultColumns}
      items={defaultItems}
      serverFetch={serverFetch}
    />
  );

  // Verify useResourceQuery was called with the initial values from serverFetch.
  const firstQueryCall = useResourceQueryMock.mock.calls[0][0];
  expect(firstQueryCall.resourceKey).toBe("orders");
  expect(firstQueryCall.limit).toBe(10);
  expect(firstQueryCall.offset).toBe(30);
  expect(firstQueryCall.sort).toEqual({ key: "created_at", direction: "desc" });
  expect(firstQueryCall.filters).toEqual({ status: "active" });
  expect(firstQueryCall.enabled).toBe(true);
});

test("without serverFetch, onServerNavigate is not passed to ResourceTable", () => {
  renderWithIntl(
    <ResourceTableClient columns={defaultColumns} items={defaultItems} />
  );

  const lastCall = ResourceTableMock.mock.calls[ResourceTableMock.mock.calls.length - 1][0];
  expect(lastCall.onServerNavigate).toBeUndefined();
  expect(screen.getByTestId("mock-table").getAttribute("data-has-server-navigate")).toBe("false");
});
