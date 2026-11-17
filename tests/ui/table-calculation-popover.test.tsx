import { screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { CalculationPopover } from "../../packages/ui/src/table/calculation-popover";
import type { AggregationType } from "../../packages/ui/src/table/metrics";
import type { TranslateFn } from "../../packages/ui/src/table/types";
import { renderWithIntl } from "./test-utils";

const t: TranslateFn = (key) => key;

const AGGREGATION_OPTIONS: AggregationType[] = [
  "count",
  "sum",
  "avg",
  "min",
  "max",
  "median",
  "none",
];

function renderPopover(overrides: Partial<{
  columnKey: string;
  selected: AggregationType;
  onSelect: jest.Mock;
}> = {}) {
  const onSelect = overrides.onSelect ?? jest.fn();
  const result = renderWithIntl(
    <CalculationPopover
      t={t}
      columnKey={overrides.columnKey ?? "col1"}
      selected={overrides.selected ?? "none"}
      onSelect={onSelect}
    >
      <button>Calc</button>
    </CalculationPopover>
  );
  return { ...result, onSelect };
}

test("renders all 7 aggregation options", async () => {
  const user = userEvent.setup();
  renderPopover();

  await user.click(screen.getByRole("button", { name: "Calc" }));

  for (const option of AGGREGATION_OPTIONS) {
    expect(
      await screen.findByRole("menuitem", { name: `calculation.${option}` })
    ).toBeInTheDocument();
  }
});

test("highlights selected aggregation with font-medium class", async () => {
  const user = userEvent.setup();
  renderPopover({ selected: "avg" });

  await user.click(screen.getByRole("button", { name: "Calc" }));

  const avgItem = await screen.findByRole("menuitem", {
    name: "calculation.avg",
  });
  expect(avgItem.className).toContain("font-medium");

  const countItem = screen.getByRole("menuitem", {
    name: "calculation.count",
  });
  expect(countItem.className).not.toContain("font-medium");
});

test("calls onSelect(columnKey, type) when clicking an option", async () => {
  const user = userEvent.setup();
  const { onSelect } = renderPopover({ columnKey: "col1" });

  await user.click(screen.getByRole("button", { name: "Calc" }));
  const sumItem = await screen.findByRole("menuitem", {
    name: "calculation.sum",
  });
  await user.click(sumItem);

  expect(onSelect).toHaveBeenCalledWith("col1", "sum");
});

test('calls onSelect for "none"', async () => {
  const user = userEvent.setup();
  const { onSelect } = renderPopover({ columnKey: "col1", selected: "avg" });

  await user.click(screen.getByRole("button", { name: "Calc" }));
  const noneItem = await screen.findByRole("menuitem", {
    name: "calculation.none",
  });
  await user.click(noneItem);

  expect(onSelect).toHaveBeenCalledWith("col1", "none");
});

test("renders children as trigger", () => {
  renderPopover();
  expect(screen.getByRole("button", { name: "Calc" })).toBeInTheDocument();
});
