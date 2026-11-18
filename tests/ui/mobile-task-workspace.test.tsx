/** @jest-environment jsdom */
import * as React from "react";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { UiSort } from "@masarx/api";
import { MobileTaskWorkspace, combineTaskFilters } from "../../apps/fieldops/src/mobile-task-workspace";
import { getFieldOpsStrings } from "../../apps/fieldops/src/i18n";
import { getFieldOpsThemeTokens } from "../../apps/fieldops/src/mobile-theme";

jest.mock("react-native", () => {
  const React = require("react");
  return {
    View: ({ children, testID }: any) => React.createElement("div", { "data-testid": testID }, children),
    ScrollView: ({ children }: any) => React.createElement("div", {}, children),
    Text: ({ children, accessibilityRole }: any) => React.createElement("span", { role: accessibilityRole }, children),
    Pressable: ({ children, onPress, disabled, accessibilityLabel }: any) => React.createElement("button", { disabled, onClick: onPress, "aria-label": accessibilityLabel }, children),
    TextInput: ({ value, editable, onChangeText, accessibilityLabel }: any) => React.createElement("input", { value, readOnly: !editable,
      "aria-label": accessibilityLabel, onChange: (event: any) => onChangeText(event.target.value) }),
  };
}, { virtual: true });

const config = { query_filter: "query", urgency_filter: "urgency", group_columns: ["task_type_key"],
  sort_options: [{ key: "smart_order", label_key: "smart", direction: "asc" }, { key: "sort_eta", label_key: "eta", direction: "asc" }],
  metric_columns: { now: "urgency_now", today: "urgency_today", later: "urgency_later" } };
function fixture() {
  const client = {
    readRegistry: jest.fn().mockResolvedValue({ resources: [{ key: "tasks", task_controls: config,
      filters: [{ key: "status", op: "eq", label: "Status" }] }] }),
    listResource: jest.fn().mockImplementation(async (_resource, _filters, limit, offset) => ({ resource: "tasks", items: [{ id: "task-" + offset, title: "Visible task " + offset }], total: 1000, limit, offset })),
    resourceMetrics: jest.fn().mockResolvedValue({ resource: "tasks", total: 1000,
      columns: { urgency_now: { sum: 100 }, urgency_today: { sum: 200 }, urgency_later: { sum: 700 } } }),
  };
  const props = { client: client as any, actorId: "actor-a", scope: { scope_id: "scope-a" },
    baseFilters: { assigned_to: "$current_user" }, baseSort: null as UiSort | null,
    theme: getFieldOpsThemeTokens("light", "web"), strings: getFieldOpsStrings("en"), interactionLocked: false,
    cache: { get: jest.fn(), set: jest.fn().mockResolvedValue(undefined) } as any,
    renderPage: ({ list }: any) => <div>{list.items.map((item: any) => <span key={item.id}>{item.title}</span>)}</div> };
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
  return { client, props, queryClient, mount: () => render(<QueryClientProvider client={queryClient}><MobileTaskWorkspace {...props} /></QueryClientProvider>) };
}
afterEach(cleanup);

test("saved filter operators and dynamic tokens survive added AND refinements", () => {
  expect(combineTaskFilters({ assigned_to: "$current_user", sla_due_at: "$now" }, [{ key: "query", value: "%_\\" }])).toEqual({ op: "and", rules: [
    { key: "assigned_to", value: "$current_user" }, { key: "sla_due_at", value: "$now" }, { key: "query", value: "%_\\" } ] });
  const tree = { op: "or", rules: [{ key: "status", value: "active" }] };
  expect(combineTaskFilters(tree, []).rules).toEqual([tree]);
});

test("saved trees with implicit AND remain nested predicates, not a rules field filter", () => {
  const saved = { rules: [{ key: "assigned_to", value: "$current_user" }, { key: "status", value: "active" }] };
  expect(combineTaskFilters(saved, [{ key: "query", value: "shipment" }])).toEqual({
    op: "and", rules: [saved, { key: "query", value: "shipment" }],
  });
});

test("full server KPIs are not derived from the visible page", async () => {
  const f = fixture(); f.mount();
  await screen.findByText("Visible task 0");
  expect(screen.getByText("Now: 100")).toBeTruthy();
  expect(screen.getByText("Total: 1,000")).toBeTruthy();
  expect(f.client.resourceMetrics.mock.calls[0][1]).toEqual(f.client.listResource.mock.calls[0][1]);
});

test("search is literal, preserves saved scope and reaches both list and metrics", async () => {
  const f = fixture(); f.mount(); await screen.findByText("Visible task 0");
  fireEvent.change(screen.getByLabelText("Find tasks"), { target: { value: "A%_B" } });
  fireEvent.click(screen.getByRole("button", { name: "Search" }));
  await waitFor(() => expect(f.client.listResource).toHaveBeenCalledTimes(2));
  const filters = f.client.listResource.mock.calls[1][1];
  expect(filters.rules).toContainEqual({ key: "assigned_to", value: "$current_user" });
  expect(filters.rules).toContainEqual({ key: "query", value: "A%_B" });
  expect(f.client.resourceMetrics.mock.calls.at(-1)?.[1]).toEqual(filters);
});

test("board queries all three complete urgency scopes, independently of the first list page", async () => {
  const f = fixture(); f.mount(); await screen.findByText("Visible task 0");
  fireEvent.click(screen.getByRole("button", { name: "Board" }));
  await waitFor(() => expect(f.client.listResource).toHaveBeenCalledTimes(4));
  for (const lane of ["now", "today", "later"]) {
    expect(f.client.listResource.mock.calls.some(call => call[1].rules.some((rule: any) => rule.key === "urgency" && rule.value === lane))).toBe(true);
  }
  await waitFor(() => expect((screen.getByRole("button", { name: "Now: Next" }) as HTMLButtonElement).disabled).toBe(false));
  fireEvent.click(screen.getByRole("button", { name: "Now: Next" }));
  await waitFor(() => expect(f.client.listResource).toHaveBeenCalledTimes(5));
  const last = f.client.listResource.mock.calls.at(-1)!;
  expect(last[3]).toBe(50);
  expect(last[1].rules).toContainEqual({ key: "urgency", value: "now" });
});

test("list pagination and grouping are server-side and Clear preserves saved filters", async () => {
  const f = fixture(); f.mount(); await screen.findByText("Visible task 0");
  fireEvent.click(screen.getByRole("button", { name: "Next" }));
  await screen.findByText("Visible task 50");
  fireEvent.click(screen.getByRole("button", { name: "Task type" }));
  await waitFor(() => expect(f.client.listResource.mock.calls.at(-1)?.[4]).toEqual({ key: "smart_order", direction: "asc", group_key: "task_type_key" }));
  expect(f.client.listResource.mock.calls.at(-1)?.[3]).toBe(0);
  fireEvent.click(screen.getByRole("button", { name: "Clear refinements" }));
  await waitFor(() => expect(f.client.listResource.mock.calls.at(-1)?.[4]).toEqual({ key: "smart_order", direction: "asc" }));
  expect(f.client.listResource.mock.calls.at(-1)?.[1]).toEqual({ op: "and", rules: [{ key: "assigned_to", value: "$current_user" }] });
});

test("actor and scope changes cannot reuse another actor's page cache", async () => {
  const f = fixture(); const view = f.mount(); await screen.findByText("Visible task 0");
  const keyA = f.props.cache.set.mock.calls[0][0];
  view.rerender(<QueryClientProvider client={f.queryClient}><MobileTaskWorkspace {...f.props} key="actor-b" actorId="actor-b" /></QueryClientProvider>);
  await waitFor(() => expect(f.props.cache.set).toHaveBeenCalledTimes(2));
  expect(f.props.cache.set.mock.calls[1][0]).not.toBe(keyA);
});

test("saved-view sort survives initial load, grouping and Clear after an override", async () => {
  const f = fixture(); f.props.baseSort = { key: "created_at", direction: "desc" }; f.mount();
  await screen.findByText("Visible task 0");
  expect(f.client.listResource.mock.calls[0][4]).toEqual(f.props.baseSort);
  fireEvent.click(screen.getByRole("button", { name: "Task type" }));
  await waitFor(() => expect(f.client.listResource.mock.calls.at(-1)?.[4]).toEqual({ ...f.props.baseSort, group_key: "task_type_key" }));
  await waitFor(() => expect((screen.getByRole("button", { name: "ETA" }) as HTMLButtonElement).disabled).toBe(false));
  fireEvent.click(screen.getByRole("button", { name: "ETA" }));
  await waitFor(() => expect(f.client.listResource.mock.calls.at(-1)?.[4]).toEqual({ key: "sort_eta", direction: "asc", group_key: "task_type_key" }));
  fireEvent.click(screen.getByRole("button", { name: "Clear refinements" }));
  await waitFor(() => expect(f.client.listResource.mock.calls.at(-1)?.[4]).toEqual(f.props.baseSort));
});

test("registry refetch failure hides stale authorized controls and pages", async () => {
  const f = fixture(); f.mount(); await screen.findByText("Visible task 0");
  f.client.readRegistry.mockRejectedValue(new Error("permission revoked"));
  await f.queryClient.invalidateQueries({ queryKey: ["ui", "task-controls-registry"] });
  await screen.findByRole("alert");
  expect(screen.queryByRole("button", { name: "Search" })).toBeNull();
  expect(screen.queryByText("Visible task 0")).toBeNull();
  expect(f.client.listResource).toHaveBeenCalledTimes(1);
});

test("missing registry does not silently fall back to an unfiltered task query", async () => {
  const f = fixture(); f.client.readRegistry.mockResolvedValue({ resources: [] }); f.mount();
  await screen.findByRole("alert");
  expect(f.client.listResource).not.toHaveBeenCalled(); expect(f.client.resourceMetrics).not.toHaveBeenCalled();
});

test.each([
  { query_filter: 123 }, { urgency_filter: {} }, { query_filter: " " },
  { metric_columns: { now: "", today: "urgency_today", later: "urgency_later" } },
  { group_columns: [null] }, { sort_options: [{ key: "", label_key: "smart", direction: "asc" }] },
])("malformed registry controls fail closed: %j", async invalid => {
  const f = fixture();
  f.client.readRegistry.mockResolvedValue({ resources: [{ key: "tasks", task_controls: { ...config, ...invalid }, filters: [] }] });
  f.mount(); await screen.findByRole("alert");
  expect(f.client.listResource).not.toHaveBeenCalled(); expect(f.client.resourceMetrics).not.toHaveBeenCalled();
});

test("summary errors do not produce zero counters and driving lock blocks changes", async () => {
  const f = fixture(); f.client.resourceMetrics.mockRejectedValue(new Error("unavailable")); f.props.interactionLocked = true; f.mount();
  await screen.findByText("Visible task 0");
  expect(screen.getByText("Task summary unavailable")).toBeTruthy();
  expect(screen.queryByText("Now: 0")).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "Next" }));
  fireEvent.click(screen.getByRole("button", { name: "Board" }));
  expect(f.client.listResource).toHaveBeenCalledTimes(1);
});
