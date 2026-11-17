import * as React from "react";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { axe } from "jest-axe";
import { Combobox } from "../../packages/ui/src/combobox";

const options = [
  { value: "disabled", label: "Unavailable", disabled: true },
  { value: "alpha", label: "Alpha" },
  { value: "beta", label: "Beta" },
];

test("keyboard users can open, navigate enabled options, select and reopen the combobox", async () => {
  function Harness() {
    const [value, setValue] = React.useState<string | string[]>("");
    return <Combobox mode="single" options={options} value={value} onChange={setValue} />;
  }
  render(<Harness />);
  const control = screen.getByRole("combobox");
  expect(control).toHaveAttribute("tabindex", "0");
  control.focus();
  fireEvent.keyDown(control, { key: "ArrowDown" });

  const search = await screen.findByRole("searchbox");
  await waitFor(() => expect(search).toHaveFocus());
  const listbox = screen.getByRole("listbox");
  expect(control).toHaveAttribute("aria-controls", listbox.id);
  expect(search).toHaveAttribute("aria-activedescendant", screen.getByRole("option", { name: "Alpha" }).id);

  fireEvent.keyDown(search, { key: "ArrowUp" });
  expect(search).toHaveAttribute("aria-activedescendant", screen.getByRole("option", { name: "Beta" }).id);
  fireEvent.keyDown(search, { key: "Enter" });
  expect(control).toHaveTextContent("Beta");
  expect(control).toHaveFocus();
  expect(screen.queryByRole("listbox")).not.toBeInTheDocument();
  fireEvent.keyDown(control, { key: " " });
  expect(screen.getByRole("searchbox")).toBeInTheDocument();
});

test("disabled multi-select cannot remove tags through their buttons", () => {
  const onChange = jest.fn();
  render(<Combobox mode="multi" options={options} value={["alpha"]} onChange={onChange} disabled />);
  const remove = screen.getByRole("button", { name: "Remove Alpha" });
  expect(remove).toBeDisabled();
  fireEvent.click(remove);
  fireEvent.keyDown(screen.getByRole("combobox"), { key: "Enter" });
  expect(onChange).not.toHaveBeenCalled();
  expect(screen.queryByRole("listbox")).not.toBeInTheDocument();
});

test("Tab closes the popup and Escape restores focus to the control", () => {
  render(<><Combobox mode="multi" options={options} value={[]} onChange={jest.fn()} /><button>Next</button></>);
  const control = screen.getByRole("combobox");
  fireEvent.click(control);
  fireEvent.keyDown(screen.getByRole("searchbox"), { key: "Escape" });
  expect(control).toHaveFocus();
  expect(screen.queryByRole("listbox")).not.toBeInTheDocument();
  fireEvent.keyDown(control, { key: "Enter" });
  fireEvent.blur(screen.getByRole("searchbox"), { relatedTarget: screen.getByRole("button", { name: "Next" }) });
  expect(screen.queryByRole("listbox")).not.toBeInTheDocument();
});

test("Enter while composing text does not select an option", () => {
  const onChange = jest.fn();
  render(<Combobox mode="single" options={options} value="" onChange={onChange} />);
  fireEvent.click(screen.getByRole("combobox"));
  fireEvent.keyDown(screen.getByRole("searchbox"), { key: "Enter", isComposing: true });
  expect(onChange).not.toHaveBeenCalled();
  expect(screen.getByRole("listbox")).toBeInTheDocument();
});

test("combobox has accessible names and valid option relationships while closed and expanded", async () => {
  const { container } = render(<Combobox mode="multi" options={options} value={["alpha"]} onChange={jest.fn()} ariaLabel="Participants" />);
  expect(await axe(container)).toHaveNoViolations();
  fireEvent.click(screen.getByRole("combobox", { name: "Participants" }));
  expect(await axe(container)).toHaveNoViolations();
});
