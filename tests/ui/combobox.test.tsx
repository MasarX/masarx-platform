import * as React from "react";
import { fireEvent, render, screen } from "@testing-library/react";
import { Combobox } from "../../packages/ui/src/combobox";

describe("Combobox", () => {
  test("closes an already-open popup after becoming disabled without changing selection", () => {
    const changed = jest.fn();
    const props = { mode: "multi" as const, options: [{ value: "a", label: "Shipment A" }, { value: "b", label: "Shipment B" }], value: ["a"], onChange: changed };
    const view = render(<Combobox {...props} />);
    fireEvent.click(screen.getByRole("combobox"));
    view.rerender(<Combobox {...props} disabled />);
    const control = screen.getByRole("combobox");
    expect(control).toHaveAttribute("aria-disabled", "true");
    expect(screen.queryByRole("searchbox")).not.toBeInTheDocument();
    expect(screen.queryByRole("listbox")).not.toBeInTheDocument();
    fireEvent.keyDown(control, { key: "Backspace" });
    fireEvent.keyDown(control, { key: "ArrowDown" });
    fireEvent.keyDown(control, { key: "Enter" });
    expect(changed).not.toHaveBeenCalled();
  });
  test("uses the associated visible label when both naming APIs are supplied", () => {
    render(<><span id="driver-label">Pickup driver</span><Combobox mode="single"
      ariaLabel="Legacy label" aria-label="Explicit label" aria-labelledby="driver-label"
      options={[]} value="" onChange={jest.fn()} /></>);
    expect(screen.getByRole("combobox", { name: "Pickup driver" })).toHaveAttribute("aria-labelledby", "driver-label");
  });
  test("does not remove selected multi values while disabled", () => {
    const changed = jest.fn();
    render(<Combobox mode="multi" options={[{ value: "a", label: "Shipment A" }]} value={["a"]} onChange={changed} disabled />);
    const remove = screen.getByRole("button", { name: "Remove Shipment A" });
    expect(remove).toBeDisabled();
    fireEvent.click(remove);
    expect(changed).not.toHaveBeenCalled();
  });
  test("opens a named enabled control using the keyboard and leaves disabled controls noninteractive", () => {
    const changed = jest.fn();
    const view = render(<Combobox mode="single" aria-label="Pickup driver" options={[{ value: "a", label: "Driver A" }]}
      value="" onChange={changed} />);
    const control = screen.getByRole("combobox", { name: "Pickup driver" });
    expect(control).toHaveAttribute("tabindex", "0");
    fireEvent.keyDown(control, { key: "Enter" });
    const search = screen.getByRole("searchbox");
    fireEvent.keyDown(search, { key: "ArrowDown" });
    fireEvent.keyDown(search, { key: "Enter" });
    expect(changed).toHaveBeenCalledWith("a");
    view.rerender(<Combobox mode="single" aria-label="Pickup driver" options={[]} value="" onChange={changed} disabled />);
    expect(screen.getByRole("combobox")).toHaveAttribute("tabindex", "-1");
  });
  test("commits a single-select option on pointer interaction", () => {
    function Harness() {
      const [value, setValue] = React.useState("");
      return (
        <Combobox
          mode="single"
          options={[
            { value: "alpha", label: "Alpha option" },
            { value: "beta", label: "Beta option" },
          ]}
          value={value}
          onChange={(nextValue) => setValue(String(nextValue ?? ""))}
          placeholder="Pick one"
        />
      );
    }

    render(<Harness />);

    fireEvent.click(screen.getByRole("combobox"));
    fireEvent.pointerDown(screen.getByRole("option", { name: "Alpha option" }));

    expect(screen.getByRole("combobox")).toHaveTextContent("Alpha option");
    expect(screen.queryByRole("searchbox", { name: "Search options" })).not.toBeInTheDocument();
  });
  test("supports hidden search text while keeping the selected label user-facing", () => {
    function Harness() {
      const [value, setValue] = React.useState("");
      return (
        <Combobox
          mode="single"
          options={[
            {
              value: "client-1",
              label: "Example Client | EXAMPLE",
              searchText: "Example Client | EXAMPLE | client-1",
            },
          ]}
          value={value}
          onChange={(nextValue) => setValue(String(nextValue ?? ""))}
          placeholder="Pick one"
        />
      );
    }

    render(<Harness />);

    fireEvent.click(screen.getByRole("combobox"));
    fireEvent.change(screen.getByRole("searchbox", { name: "Search options" }), {
      target: { value: "client-1" },
    });
    fireEvent.pointerDown(screen.getByRole("option", { name: "Example Client | EXAMPLE" }));

    expect(screen.getByRole("combobox")).toHaveTextContent("Example Client | EXAMPLE");
    expect(screen.getByRole("combobox")).not.toHaveTextContent("client-1");
  });
});
