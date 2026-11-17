import { act, fireEvent, screen } from "@testing-library/react";
import { axe } from "jest-axe";
import { DatePicker, DateTimePicker } from "../../packages/ui/src/date-picker";
import { renderWithIntl } from "./test-utils";

test("clearing a date-time picker's time clears the value without emitting Invalid Date", () => {
  const onChange = jest.fn();
  renderWithIntl(<DateTimePicker value={new Date(2026, 0, 10, 12, 30)} onChange={onChange} />);
  fireEvent.change(screen.getByLabelText("Select time"), { target: { value: "" } });
  expect(onChange).toHaveBeenCalledWith(undefined);
});

test("a named date-time picker submits both the date and time", () => {
  const value = new Date(2026, 0, 10, 12, 30);
  const { container } = renderWithIntl(<form><DateTimePicker name="scheduledAt" value={value} /></form>);
  const form = container.querySelector("form")!;
  expect(new FormData(form).getAll("scheduledAt")).toEqual([value.toISOString()]);
});

test("disabled date-time fields do not participate in form submission", () => {
  const { container } = renderWithIntl(<form><DateTimePicker name="scheduledAt" value={new Date(2026, 0, 10, 12, 30)} disabled /></form>);
  expect(new FormData(container.querySelector("form")!).has("scheduledAt")).toBe(false);
});

test("the open date picker has accessible calendar semantics", async () => {
  renderWithIntl(<DatePicker value={new Date(2026, 0, 10)} />);
  const trigger = screen.getByRole("button", { name: "Select date" });
  expect(trigger).toHaveAttribute("aria-haspopup", "dialog");
  await act(async () => fireEvent.keyDown(trigger, { key: "Enter" }));
  const dialog = screen.getByRole("dialog", { name: "Select date" });
  expect(screen.getByRole("grid", { name: "January 2026" })).toBeInTheDocument();
  expect(dialog.querySelector("[aria-selected='true'] button")).toHaveFocus();
  expect(await axe(dialog)).toHaveNoViolations();
});
