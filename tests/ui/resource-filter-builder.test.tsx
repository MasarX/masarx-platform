import { fireEvent, screen } from "@testing-library/react";
import { ResourceFilterBuilder } from "../../packages/ui/src/resource-filter-builder";
import { decodeFilterTree, flattenFilterTree } from "../../packages/ui/src/resource-query";
import { renderWithIntl } from "./test-utils";

jest.mock("@masarx/api", () => ({
  ...jest.requireActual("@masarx/api"),
  createUiClient: jest.fn(() => ({
    listResource: jest.fn(),
    filterOperators: jest.fn().mockResolvedValue([]),
  })),
}));

const replaceMock = jest.fn();

jest.mock("next/navigation", () => ({
  useRouter: () => ({ replace: replaceMock }),
  useSearchParams: () => new URLSearchParams(),
}));

beforeEach(() => {
  replaceMock.mockClear();
});

const filters = [
  { key: "status", column: "status", op: "eq" },
  { key: "sender_id", column: "sender_id", op: "eq" },
];

test("resource filter builder applies encoded filters", () => {
  renderWithIntl(
    <ResourceFilterBuilder
      filters={filters}
      searchParams={{ view: "active" }}
      actionHref="/console/resources/shipments"
      limit={25}
    />
  );

  fireEvent.change(screen.getByPlaceholderText("value or comma-separated values"), {
    target: { value: "ready" },
  });
  fireEvent.click(screen.getByRole("button", { name: "Apply filters" }));

  expect(replaceMock).toHaveBeenCalledTimes(1);
  const calledWith = replaceMock.mock.calls[0][0];
  const url = new URL(calledWith, "http://localhost");
  expect(url.pathname).toBe("/console/resources/shipments");
  expect(url.searchParams.get("filters")).toBeTruthy();
  expect(url.searchParams.get("view")).toBe("active");
  expect(url.searchParams.get("page")).toBe("1");
  expect(url.searchParams.get("offset")).toBe("0");
  expect(url.searchParams.get("limit")).toBe("25");
});

test("resource filter builder reports apply and clear callbacks", () => {
  const onApply = jest.fn();
  const onClear = jest.fn();
  renderWithIntl(
    <ResourceFilterBuilder
      filters={filters}
      searchParams={{ view: "active" }}
      actionHref="/console/resources/shipments"
      limit={25}
      onApply={onApply}
      onClear={onClear}
    />
  );

  fireEvent.change(screen.getByPlaceholderText("value or comma-separated values"), {
    target: { value: "ready" },
  });
  fireEvent.click(screen.getByRole("button", { name: "Apply filters" }));
  fireEvent.click(screen.getByRole("button", { name: "Clear filters" }));

  expect(onApply).toHaveBeenCalledTimes(1);
  expect(onApply.mock.calls[0][0]).toEqual(
    expect.objectContaining({ ruleCount: 1 })
  );
  expect(onClear).toHaveBeenCalledTimes(1);
});

test("resource filter builder clears filters", () => {
  renderWithIntl(
    <ResourceFilterBuilder
      filters={filters}
      searchParams={{ filters: "%7B%7D", view: "active" }}
      actionHref="/console/resources/shipments"
      limit={25}
    />
  );

  fireEvent.click(screen.getByRole("button", { name: "Clear filters" }));

  expect(replaceMock).toHaveBeenCalledTimes(1);
  const calledWith = replaceMock.mock.calls[0][0];
  const url = new URL(calledWith, "http://localhost");
  expect(url.searchParams.get("filters")).toBeNull();
  expect(url.searchParams.get("view")).toBe("active");
});

test("resource filter builder honors allowed operators from registry", () => {
  renderWithIntl(
    <ResourceFilterBuilder
      filters={[
        { key: "status", column: "status", op: "eq", ops: ["eq", "ilike"] },
      ]}
      searchParams={{}}
      actionHref="/console/resources/shipments"
      limit={25}
    />
  );

  expect(screen.getByRole("option", { name: "equals" })).toBeInTheDocument();
  expect(screen.getByRole("option", { name: "contains" })).toBeInTheDocument();
  expect(screen.queryByRole("option", { name: ">" })).toBeNull();
});

test.each(["unknown", "intervention_required", "healthy", "degraded", "down"])(
  "provider health filter offers and preserves %s without a closed status list",
  (status) => {
    renderWithIntl(<ResourceFilterBuilder
      resourceKey="providers"
      filters={[{ key: "health_status", column: "health_status", op: "eq" }]}
      searchParams={{}} actionHref="/console/resources/providers" limit={25}
    />);
    expect(screen.getByRole("option", { name: "Health Status" })).toBeInTheDocument();
    fireEvent.change(screen.getByPlaceholderText("value or comma-separated values"), {
      target: { value: status },
    });
    fireEvent.click(screen.getByRole("button", { name: "Apply filters" }));
    const url = new URL(replaceMock.mock.calls[0][0], "http://localhost");
    expect(url.pathname).toBe("/console/resources/providers");
    const tree = decodeFilterTree(url.searchParams.get("filters"));
    expect(tree).not.toBeNull();
    expect(flattenFilterTree(tree!)).toEqual([
      expect.objectContaining({ key: "health_status", op: "eq", value: status }),
    ]);
  }
);
