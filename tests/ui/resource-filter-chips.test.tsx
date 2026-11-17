import { render, screen } from "@testing-library/react";
import { ResourceFilterChips } from "../../packages/ui/src/resource-filter-chips";

const filters = [
  { key: "status", column: "status", op: "eq" },
  { key: "sender_id", column: "sender_id", op: "eq" },
];

test("resource filter chips render query filters with remove links", () => {
  render(
    <ResourceFilterChips
      filters={filters}
      appliedFilters={[{ key: "status", value: "ready", source: "query" }]}
      searchParams={{ status: "ready", view: "custom", page: "3", offset: "50" }}
      actionHref="/console/resources/shipments"
    />
  );

  const clearLink = screen.getByRole("link", { name: "Clear query filters" });
  const clearUrl = new URL(clearLink.getAttribute("href") ?? "", "https://example.com");
  expect(clearUrl.searchParams.get("status")).toBeNull();
  expect(clearUrl.searchParams.get("view")).toBe("custom");
  expect(clearUrl.searchParams.get("page")).toBe("1");
  expect(clearUrl.searchParams.get("offset")).toBe("0");

  const removeLink = screen.getByRole("link", { name: "Remove filter Status" });
  const removeUrl = new URL(removeLink.getAttribute("href") ?? "", "https://example.com");
  expect(removeUrl.searchParams.get("status")).toBeNull();
});

test("resource filter chips mark view filters without remove links", () => {
  render(
    <ResourceFilterChips
      filters={filters}
      appliedFilters={[{ key: "sender_id", value: "sender-1", source: "view" }]}
      searchParams={{ view: "saved-view" }}
      actionHref="/console/resources/shipments"
    />
  );

  expect(screen.getByText("View")).toBeInTheDocument();
  expect(screen.queryByRole("link", { name: /Remove filter/i })).toBeNull();
});

test("resource filter chips use registry labels when available", () => {
  render(
    <ResourceFilterChips
      filters={[{ key: "sender_id", column: "sender_id", op: "eq", label: "Sender" }]}
      appliedFilters={[{ key: "sender_id", value: "sender-1", source: "query" }]}
      searchParams={{ sender_id: "sender-1" }}
      actionHref="/console/resources/shipments"
    />
  );

  expect(screen.getByText("Sender")).toBeInTheDocument();
  expect(screen.getByRole("link", { name: "Remove filter Sender" })).toBeInTheDocument();
});

test("resource filter chips prefer allowed ops when op is missing", () => {
  render(
    <ResourceFilterChips
      filters={[{ key: "tracking_number", column: "tracking_number", ops: ["ilike"] }]}
      appliedFilters={[{ key: "tracking_number", value: "ABC", source: "query" }]}
      searchParams={{ tracking_number: "ABC" }}
      actionHref="/console/resources/shipments"
    />
  );

  expect(screen.getByText("contains")).toBeInTheDocument();
});

test("Arabic filter labels use registry presentation without changing keys", () => {
  render(<ResourceFilterChips filters={[{ key: "resource_id", column: "resource_id", op: "eq", label: "Resource ID", label_ar: "معرّف المورد" }]} appliedFilters={[{ key: "resource_id", value: "abc", source: "query" }]} searchParams={{ resource_id: "abc" }} actionHref="/console/resources/shipments" opLabels={{ eq: "يساوي" }} locale="ar" />);
  expect(screen.getByText("معرّف المورد")).toBeInTheDocument();
  expect(screen.getByText("يساوي")).toBeInTheDocument();
});
