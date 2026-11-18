import { render, screen, fireEvent } from "@testing-library/react";
import { FilterChips, type ChipItem } from "../../packages/ui/src/table/filter-chips";
import type { TranslateFn } from "../../packages/ui/src/table/types";

const t: TranslateFn = (key) => key;

const chip1: ChipItem = { id: "f1", label: "Status = Active", type: "filter" };
const chip2: ChipItem = { id: "s1", label: "Name", detail: "A-Z", type: "sort" };

function renderChips(overrides: {
  chips?: ChipItem[];
  onRemove?: jest.Mock;
  onClearAll?: jest.Mock;
  noClearAll?: boolean;
} = {}) {
  const onRemove = overrides.onRemove ?? jest.fn();
  const onClearAll = overrides.noClearAll ? undefined : (overrides.onClearAll ?? jest.fn());
  const result = render(
    <FilterChips
      t={t}
      chips={overrides.chips ?? [chip1]}
      onRemove={onRemove}
      onClearAll={onClearAll}
    />
  );
  return { ...result, onRemove, onClearAll };
}

test("returns null for empty chips", () => {
  const { container } = render(
    <FilterChips t={t} chips={[]} onRemove={jest.fn()} />
  );
  expect(container.innerHTML).toBe("");
});

test("renders chip label", () => {
  renderChips({ chips: [chip1] });
  expect(screen.getByText("Status = Active")).toBeInTheDocument();
});

test("renders chip detail text", () => {
  renderChips({ chips: [chip2] });
  expect(screen.getByText("Name")).toBeInTheDocument();
  expect(screen.getByText("A-Z")).toBeInTheDocument();
  expect(screen.getByText("A-Z")).not.toHaveClass("opacity-70");
});

test("calls onRemove on X click", () => {
  const { onRemove } = renderChips({ chips: [chip1] });

  const removeBtn = screen.getByRole("button", {
    name: "viewBar.removeChipAria",
  });
  fireEvent.click(removeBtn);

  expect(onRemove).toHaveBeenCalledWith(chip1);
});

test("shows Clear All when >1 chip and onClearAll provided", () => {
  renderChips({ chips: [chip1, chip2] });
  expect(screen.getByText("viewBar.clearAll")).toBeInTheDocument();
});

test("hides Clear All when only 1 chip", () => {
  renderChips({ chips: [chip1] });
  expect(screen.queryByText("viewBar.clearAll")).toBeNull();
});

test("hides Clear All when onClearAll is undefined", () => {
  renderChips({ chips: [chip1, chip2], noClearAll: true });
  expect(screen.queryByText("viewBar.clearAll")).toBeNull();
});

test("calls onClearAll on click", () => {
  const onClearAll = jest.fn();
  renderChips({ chips: [chip1, chip2], onClearAll });

  fireEvent.click(screen.getByText("viewBar.clearAll"));

  expect(onClearAll).toHaveBeenCalledTimes(1);
});
