import { screen } from "@testing-library/react";
import { DatePicker, DateRangePicker } from "../../packages/ui/src/date-picker";
import { renderWithIntl } from "./test-utils";

test("date picker renders trigger button", () => {
  renderWithIntl(<DatePicker />);
  expect(screen.getByRole("button", { name: "Select date" })).toBeInTheDocument();
});

test("date picker renders hidden input with ISO value", () => {
  const value = new Date(2026, 0, 10);
  renderWithIntl(<DatePicker value={value} name="shipDate" />);
  const input = document.querySelector(
    'input[type="hidden"][name="shipDate"]'
  ) as HTMLInputElement | null;
  expect(input).not.toBeNull();
  expect(input?.value).toBe("2026-01-10");
});

test("date range picker renders two triggers and hidden inputs", () => {
  renderWithIntl(<DateRangePicker startName="start" endName="end" />);
  expect(
    screen.getByRole("button", { name: "Select start date" })
  ).toBeInTheDocument();
  expect(
    screen.getByRole("button", { name: "Select end date" })
  ).toBeInTheDocument();
  const startInput = document.querySelector(
    'input[type="hidden"][name="start"]'
  ) as HTMLInputElement | null;
  const endInput = document.querySelector(
    'input[type="hidden"][name="end"]'
  ) as HTMLInputElement | null;
  expect(startInput).not.toBeNull();
  expect(endInput).not.toBeNull();
});
