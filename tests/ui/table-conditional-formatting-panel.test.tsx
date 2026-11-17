import { render, screen, fireEvent } from "@testing-library/react";
import { ConditionalFormattingPanel } from "../../packages/ui/src/table/conditional-formatting-panel";
import type { TranslateFn } from "../../packages/ui/src/table/types";
import type { ResourceColumn } from "../../packages/ui/src/table/columns";
import type { ConditionalFormattingRule } from "../../packages/ui/src/table/view-types";

const t: TranslateFn = (key) => key;

const columns: ResourceColumn[] = [
  { key: "name", label: "Name" },
  { key: "age", label: "Age" },
];

function makeRule(overrides?: Partial<ConditionalFormattingRule>): ConditionalFormattingRule {
  return {
    id: "rule-1",
    field: "name",
    operator: "eq",
    value: "test",
    style: { bgColor: "#fef3c7", textColor: null, bold: null },
    scope: "row",
    ...overrides,
  };
}

const defaultProps = {
  t,
  columns,
  rules: [] as ConditionalFormattingRule[],
  onRulesChange: jest.fn(),
};

beforeEach(() => {
  jest.clearAllMocks();
});

test("renders with no rules", () => {
  render(<ConditionalFormattingPanel {...defaultProps} />);
  expect(screen.getByText("Conditional formatting")).toBeInTheDocument();
  expect(screen.getByText("+ Add rule")).toBeInTheDocument();
});

test("renders existing rules", () => {
  const rules = [
    makeRule({ id: "rule-1", field: "name" }),
    makeRule({ id: "rule-2", field: "age" }),
  ];
  render(<ConditionalFormattingPanel {...defaultProps} rules={rules} />);
  // Each rule renders a field select with the column options; both should be present
  const selects = screen.getAllByRole("combobox");
  // Each rule has 3 selects: field, operator, scope => 6 total for 2 rules
  expect(selects.length).toBe(6);
});

test("calls onRulesChange when adding a rule", () => {
  const onRulesChange = jest.fn();
  render(
    <ConditionalFormattingPanel
      {...defaultProps}
      onRulesChange={onRulesChange}
    />
  );
  fireEvent.click(screen.getByText("+ Add rule"));
  expect(onRulesChange).toHaveBeenCalledTimes(1);
  const newRules = onRulesChange.mock.calls[0][0] as ConditionalFormattingRule[];
  expect(newRules).toHaveLength(1);
  expect(newRules[0].field).toBe("name");
  expect(newRules[0].operator).toBe("eq");
});

test("calls onRulesChange when removing a rule", () => {
  const onRulesChange = jest.fn();
  const rules = [makeRule({ id: "rule-1" }), makeRule({ id: "rule-2", field: "age" })];
  render(
    <ConditionalFormattingPanel
      {...defaultProps}
      rules={rules}
      onRulesChange={onRulesChange}
    />
  );
  // Click the first remove button (the "x" button)
  const removeButtons = screen.getAllByText("×");
  fireEvent.click(removeButtons[0]);
  expect(onRulesChange).toHaveBeenCalledTimes(1);
  const updatedRules = onRulesChange.mock.calls[0][0] as ConditionalFormattingRule[];
  expect(updatedRules).toHaveLength(1);
  expect(updatedRules[0].id).toBe("rule-2");
});

test("renders operator options", () => {
  const rules = [makeRule()];
  render(<ConditionalFormattingPanel {...defaultProps} rules={rules} />);
  // The operator select is the second combobox (field, operator, scope)
  const options = screen.getAllByRole("option");
  const operatorLabels = [
    "equals",
    "not equals",
    "greater than",
    "≥",
    "less than",
    "≤",
    "contains",
    "is empty",
    "is not empty",
  ];
  operatorLabels.forEach((label) => {
    expect(
      options.some((opt) => opt.textContent === label)
    ).toBe(true);
  });
});
