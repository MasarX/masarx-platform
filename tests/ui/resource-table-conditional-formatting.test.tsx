import { fireEvent, screen, within } from "@testing-library/react";
import { ResourceTable } from "../../packages/ui/src/resource-table";
import { setUiReporter } from "../../packages/ui/src/reporting";
import type { ConditionalFormattingRule } from "../../packages/ui/src/table/view-types";
import { renderWithIntl } from "./test-utils";

jest.mock("next/navigation", () => ({
  useRouter: () => ({ replace: jest.fn(), push: jest.fn() }),
  useSearchParams: () => new URLSearchParams(),
}));

beforeEach(() => setUiReporter(jest.fn()));
afterEach(() => setUiReporter(null));

const rowRule: ConditionalFormattingRule = {
  id: "ready-row",
  field: "status",
  operator: "eq",
  value: "Ready",
  style: { bgColor: "#fef3c7", textColor: "#92400e", bold: true },
  scope: "row",
};
const cellRule: ConditionalFormattingRule = {
  id: "large-amount",
  field: "amount",
  operator: "gte",
  value: 100,
  style: { bgColor: "#dcfce7", textColor: "#166534", bold: false },
  scope: "cell",
};

function table(rules: ConditionalFormattingRule[], activeViewId = "formatted", baseHref?: string) {
  return (
    <ResourceTable
      columns={[
        { key: "name", label: "Name" },
        { key: "status", label: "Status" },
        { key: "amount", label: "Amount" },
      ]}
      items={[
        { id: "1", name: "Alpha", status: "Ready", amount: 150 },
        { id: "2", name: "Beta", status: "Pending", amount: 50 },
      ]}
      idKey="id"
      enableSelection
      resourceKey="shipments"
      baseHref={baseHref}
      viewState={{
        resourceKey: "shipments",
        activeViewId,
        views: [{
          id: "formatted",
          label: "Formatted",
          columns: { pinned: ["name"], widths: { name: 180 } },
          conditional_formatting: rules,
        }, {
          id: "pending",
          label: "Pending",
          conditional_formatting: [{ ...rowRule, value: "Pending" }],
        }, { id: "plain", label: "Plain" }],
      }}
    />
  );
}

function renderTable(rules: ConditionalFormattingRule[]) {
  return renderWithIntl(table(rules));
}

function dataRow(name: string) {
  return screen.getByText(name).closest("tr")!;
}

test("saved rules format matching rows and cells while preserving pinned column layout", () => {
  renderTable([rowRule, cellRule]);

  const alpha = dataRow("Alpha");
  expect(alpha).toHaveStyle({ backgroundColor: "#fef3c7", color: "#92400e", fontWeight: "bold" });
  const name = alpha.querySelector('[data-column-key="name"]');
  expect(name).toHaveAttribute("data-pinned", "true");
  expect(name).toHaveStyle({ backgroundColor: "#fef3c7", left: "0px", width: "180px" });
  expect(alpha.querySelector('[data-column-key="amount"]')).toHaveStyle({
    backgroundColor: "#dcfce7", color: "#166534", fontWeight: "normal",
  });
  const beta = dataRow("Beta");
  expect(beta.style.backgroundColor).toBe("");
  expect(beta.querySelector('[data-column-key="amount"]')?.getAttribute("style") ?? "").not.toContain("background-color");
});

test("editing and removing formatting rules immediately updates rendered cells", async () => {
  renderTable([rowRule]);
  fireEvent.click(screen.getByRole("button", { name: "Formatting" }));
  const value = await screen.findByPlaceholderText("Value");
  fireEvent.change(value, { target: { value: "Pending" } });

  expect(dataRow("Alpha").style.backgroundColor).toBe("");
  expect(dataRow("Beta")).toHaveStyle({ backgroundColor: "#fef3c7" });

  fireEvent.click(screen.getByRole("button", { name: "×" }));
  expect(dataRow("Beta").style.backgroundColor).toBe("");

  fireEvent.click(screen.getByRole("button", { name: "Reset view" }));
  expect(dataRow("Alpha")).toHaveStyle({ backgroundColor: "#fef3c7" });
  expect(dataRow("Beta").style.backgroundColor).toBe("");
  expect(screen.getByPlaceholderText("Value")).toHaveValue("Ready");
});

test("selected rows keep their selection highlight and formatting foreground", () => {
  renderTable([rowRule, cellRule]);
  const alpha = dataRow("Alpha");
  fireEvent.click(within(alpha).getByRole("checkbox"));

  expect(alpha).toHaveAttribute("aria-selected", "true");
  expect(alpha).toHaveClass("bg-ui-accent/5", "border-s-ui-accent");
  expect(alpha.style.backgroundColor).toBe("");
  expect(alpha.querySelector('[data-column-key="amount"]')).toHaveStyle({ color: "#166534", fontWeight: "normal" });
  expect(alpha.querySelector('[data-column-key="amount"]')?.getAttribute("style") ?? "").not.toContain("background-color");

  fireEvent.click(within(alpha).getByRole("checkbox"));
  expect(alpha).toHaveStyle({ backgroundColor: "#fef3c7" });
});

test("conditional foreground reaches linked labels and ordinary text values", () => {
  const styles = document.createElement("style");
  styles.textContent = ".text-ui-ink { color: rgb(10, 20, 30); } .text-ui-muted { color: rgb(40, 50, 60); }";
  document.head.append(styles);
  try {
    renderWithIntl(table([rowRule, {
      ...cellRule, field: "status", operator: "eq", value: "Ready",
    }], "formatted", "/resources/shipments"));
    expect(getComputedStyle(screen.getByRole("link", { name: "Alpha" })).color)
      .toBe("rgb(146, 64, 14)");
    expect(getComputedStyle(screen.getByText("Ready")).color)
      .toBe("rgb(22, 101, 52)");
    expect(getComputedStyle(within(dataRow("Beta")).getByText("Pending").parentElement!).color)
      .toBe("rgb(40, 50, 60)");
  } finally {
    styles.remove();
  }
});

test("switching saved views applies their own rules and clears absent formatting", () => {
  const { rerender } = renderTable([rowRule]);
  expect(dataRow("Alpha")).toHaveStyle({ backgroundColor: "#fef3c7" });

  rerender(table([rowRule], "pending"));
  expect(dataRow("Alpha").style.backgroundColor).toBe("");
  expect(dataRow("Beta")).toHaveStyle({ backgroundColor: "#fef3c7" });

  rerender(table([rowRule], "plain"));
  expect(dataRow("Alpha").style.backgroundColor).toBe("");
  expect(dataRow("Beta").style.backgroundColor).toBe("");
});

test("refreshing the same saved view preserves unsaved formatting edits", async () => {
  const { rerender } = renderTable([rowRule]);
  fireEvent.click(screen.getByRole("button", { name: "Formatting" }));
  const value = await screen.findByPlaceholderText("Value");
  fireEvent.change(value, { target: { value: "Pending" } });

  rerender(table([{ ...rowRule }]));
  expect(screen.getByPlaceholderText("Value")).toHaveValue("Pending");
  expect(dataRow("Alpha").style.backgroundColor).toBe("");
  expect(dataRow("Beta")).toHaveStyle({ backgroundColor: "#fef3c7" });
});
