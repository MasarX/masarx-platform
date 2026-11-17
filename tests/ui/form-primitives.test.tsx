import { fireEvent, render, screen } from "@testing-library/react";
import { Checkbox } from "../../packages/ui/src/checkbox";
import { Input } from "../../packages/ui/src/input";
import { RadioGroup, RadioGroupItem } from "../../packages/ui/src/radio-group";
import { Select } from "../../packages/ui/src/select";
import { Switch } from "../../packages/ui/src/switch";
import { Textarea } from "../../packages/ui/src/textarea";

test("input renders with placeholder", () => {
  render(<Input placeholder="Email" />);
  expect(screen.getByPlaceholderText("Email")).toBeInTheDocument();
});

test("select supports option changes", () => {
  render(
    <Select defaultValue="b">
      <option value="a">Alpha</option>
      <option value="b">Beta</option>
    </Select>
  );
  const select = screen.getByRole("combobox");
  expect(select).toHaveValue("b");
  fireEvent.change(select, { target: { value: "a" } });
  expect(select).toHaveValue("a");
});

test("textarea renders provided value", () => {
  render(<Textarea defaultValue="Notes" />);
  expect(screen.getByDisplayValue("Notes")).toBeInTheDocument();
});

test("checkbox toggles checked state", () => {
  render(<Checkbox aria-label="Agree" />);
  const checkbox = screen.getByRole("checkbox", { name: "Agree" });
  expect(checkbox).not.toBeChecked();
  fireEvent.click(checkbox);
  expect(checkbox).toBeChecked();
});

test("radio group items toggle correctly", () => {
  render(
    <RadioGroup aria-label="Priority">
      <label className="flex items-center gap-2">
        <RadioGroupItem name="priority" value="low" />
        Low
      </label>
      <label className="flex items-center gap-2">
        <RadioGroupItem name="priority" value="high" />
        High
      </label>
    </RadioGroup>
  );
  const radios = screen.getAllByRole("radio");
  expect(radios).toHaveLength(2);
  fireEvent.click(radios[1]);
  expect(radios[1]).toBeChecked();
});

test("switch toggles checked state", () => {
  render(<Switch aria-label="Alerts" />);
  const toggle = screen.getByRole("switch", { name: "Alerts" });
  expect(toggle).not.toBeChecked();
  fireEvent.click(toggle);
  expect(toggle).toBeChecked();
});
