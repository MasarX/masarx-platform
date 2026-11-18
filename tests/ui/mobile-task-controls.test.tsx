/** @jest-environment jsdom */
import * as React from "react";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { MobileTaskControls, type MobileTaskControlsProps } from "../../apps/fieldops/src/mobile-task-controls";
import { getFieldOpsThemeTokens } from "../../apps/fieldops/src/mobile-theme";

jest.mock("react-native", () => {
  const React = require("react");
  return {
    View: ({ children, testID, accessibilityState }: any) => React.createElement("div", { "data-testid": testID, "aria-busy": accessibilityState?.busy }, children),
    Text: ({ children, accessibilityRole }: any) => React.createElement("span", { role: accessibilityRole }, children),
    Pressable: ({ children, onPress, disabled, accessibilityLabel, accessibilityState }: any) =>
      React.createElement("button", { disabled, onClick: onPress, "aria-label": accessibilityLabel,
        "aria-selected": accessibilityState?.selected, "aria-busy": accessibilityState?.busy, "aria-disabled": accessibilityState?.disabled }, children),
    TextInput: ({ value, editable, onChangeText, onSubmitEditing, accessibilityLabel }: any) =>
      React.createElement("input", { value, readOnly: !editable, "aria-label": accessibilityLabel,
        onChange: (event: any) => onChangeText(event.target.value),
        onKeyDown: (event: any) => { if (event.key === "Enter") onSubmitEditing(); } }),
  };
}, { virtual: true });

function props(): MobileTaskControlsProps {
  return {
    theme: getFieldOpsThemeTokens("light", "web"),
    labels: { query: "Find tasks", search: "Search", clear: "Clear", view: "View", group: "Group", sort: "Sort",
      filter: "Filter field", filterValue: "Filter value", previous: "Previous", next: "Next", loading: "Loading summary", summaryError: "Summary unavailable",
      totalUnavailable: "Total unavailable", estimatedWarning: "Estimated total", now: "Now", today: "Today", later: "Later", total: "Total",
      totalCount: count => "Matching tasks: " + count, formatCount: count => String(count) },
    query: "", onQueryChange: jest.fn(), onSearch: jest.fn(), onClear: jest.fn(),
    view: "list", viewOptions: [{ value: "list", label: "List" }, { value: "board", label: "Board" }, { value: "map", label: "Map" }], onViewChange: jest.fn(),
    filterOptions: [{ value: "status-key", label: "Status" }, { value: "team-key", label: "Team" }],
    filterKey: "status-key", onFilterKeyChange: jest.fn(), filterValue: "", onFilterValueChange: jest.fn(),
    group: "none", groupOptions: [{ value: "none", label: "No grouping" }, { value: "registry-group", label: "Assigned team" }], onGroupChange: jest.fn(),
    sort: "registry-sort", sortOptions: [{ value: "registry-sort", label: "Priority" }, { value: "other-sort", label: "Created" }], onSortChange: jest.fn(),
    page: { label: "Page 1", canPrevious: false, canNext: true, onPrevious: jest.fn(), onNext: jest.fn(), total: 1234, estimated: false },
    summary: { status: "ready", counts: { now: 100, today: 200, later: 300, total: 1234 } },
    busy: false, interactionLocked: false,
  };
}
afterEach(cleanup);

test("draft edits do not submit until Search or Enter; Clear calls the owner", () => {
  const p = props(); render(<MobileTaskControls {...p} />);
  fireEvent.change(screen.getByLabelText("Find tasks"), { target: { value: "dispatch" } });
  expect(p.onQueryChange).toHaveBeenCalledWith("dispatch");
  expect(p.onSearch).not.toHaveBeenCalled();
  fireEvent.change(screen.getByLabelText("Filter value"), { target: { value: "open" } });
  fireEvent.click(screen.getByRole("button", { name: "Team" }));
  expect(p.onFilterValueChange).toHaveBeenCalledWith("open");
  expect(p.onFilterKeyChange).toHaveBeenCalledWith("team-key");
  expect(p.onSearch).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole("button", { name: "Search" }));
  fireEvent.keyDown(screen.getByLabelText("Find tasks"), { key: "Enter" });
  expect(p.onSearch).toHaveBeenCalledTimes(2);
  fireEvent.click(screen.getByRole("button", { name: "Clear" }));
  expect(p.onClear).toHaveBeenCalledTimes(1);
});

test("registry options preserve values and selected states without deriving semantics", () => {
  const p = props(); render(<MobileTaskControls {...p} />);
  expect(screen.getByRole("button", { name: "List" }).getAttribute("aria-selected")).toBe("true");
  fireEvent.click(screen.getByRole("button", { name: "Board" }));
  fireEvent.click(screen.getByRole("button", { name: "Assigned team" }));
  fireEvent.click(screen.getByRole("button", { name: "Created" }));
  expect(p.onViewChange).toHaveBeenCalledWith("board");
  expect(p.onGroupChange).toHaveBeenCalledWith("registry-group");
  expect(p.onSortChange).toHaveBeenCalledWith("other-sort");
});

test("server full-scope KPI values and exact total are rendered unchanged", () => {
  render(<MobileTaskControls {...props()} />);
  for (const label of ["Now: 100", "Today: 200", "Later: 300", "Total: 1234", "Matching tasks: 1234"]) expect(screen.getByText(label)).toBeTruthy();
  expect(screen.queryByText("Estimated total")).toBeNull();
});

test("paging respects boundaries and surfaces estimated or unavailable totals", () => {
  const p = props(); p.page.estimated = true;
  const view = render(<MobileTaskControls {...p} />);
  fireEvent.click(screen.getByRole("button", { name: "Previous" }));
  fireEvent.click(screen.getByRole("button", { name: "Next" }));
  expect(p.page.onPrevious).not.toHaveBeenCalled();
  expect(p.page.onNext).toHaveBeenCalledTimes(1);
  expect(screen.getByText("Estimated total")).toBeTruthy();
  view.rerender(<MobileTaskControls {...p} page={{ ...p.page, total: null, canNext: false }} />);
  expect(screen.getByText("Total unavailable")).toBeTruthy();
  expect(screen.queryByText("Matching tasks: 1234")).toBeNull();
});

test.each(["loading", "error"] as const)("summary %s never fabricates zero or page-based KPIs", status => {
  render(<MobileTaskControls {...props()} summary={{ status }} />);
  expect(screen.queryByText("Now: 100")).toBeNull();
  expect(screen.queryByText("Now: 0")).toBeNull();
  expect(screen.getByTestId("mobile-task-summary").getAttribute("aria-busy")).toBe(String(status === "loading"));
  expect(screen.getByText(status === "loading" ? "Loading summary" : "Summary unavailable")).toBeTruthy();
});

test("busy blocks remote selection/search/paging but permits draft clear", () => {
  const p = props(); render(<MobileTaskControls {...p} busy />);
  for (const label of ["Search", "Board", "Assigned team", "Created", "Next"]) {
    const button = screen.getByRole("button", { name: label });
    expect(button.getAttribute("aria-disabled")).toBe("true");
    expect(button.getAttribute("aria-busy")).toBe("true");
    fireEvent.click(button);
  }
  fireEvent.keyDown(screen.getByLabelText("Find tasks"), { key: "Enter" });
  expect(p.onSearch).not.toHaveBeenCalled();
  expect(p.onViewChange).not.toHaveBeenCalled();
  expect(p.page.onNext).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole("button", { name: "Clear" }));
  expect(p.onClear).toHaveBeenCalledTimes(1);
});

test("driving lock blocks every interaction including edits and Clear", () => {
  const p = props(); render(<MobileTaskControls {...p} interactionLocked />);
  fireEvent.change(screen.getByLabelText("Find tasks"), { target: { value: "blocked" } });
  fireEvent.keyDown(screen.getByLabelText("Find tasks"), { key: "Enter" });
  fireEvent.change(screen.getByLabelText("Filter value"), { target: { value: "blocked" } });
  for (const button of screen.getAllByRole("button")) fireEvent.click(button);
  expect(p.onQueryChange).not.toHaveBeenCalled();
  for (const callback of [p.onFilterKeyChange, p.onFilterValueChange, p.onSearch, p.onClear, p.onViewChange, p.onGroupChange, p.onSortChange, p.page.onPrevious, p.page.onNext]) expect(callback).not.toHaveBeenCalled();
});
