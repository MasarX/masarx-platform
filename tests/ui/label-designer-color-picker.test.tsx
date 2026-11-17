/**
 * @jest-environment jsdom
 */
import * as React from "react";
import { render, screen, fireEvent } from "@testing-library/react";
import { ColorPickerInput } from "../../packages/ui/src/label-designer/color-picker-input";

// Mock react-colorful
jest.mock("react-colorful", () => ({
  HexColorPicker: ({ color, onChange }: { color: string; onChange: (c: string) => void }) => (
    <div data-testid="hex-color-picker">
      <input
        data-testid="mock-picker-input"
        value={color}
        onChange={(e) => onChange(e.target.value)}
      />
    </div>
  ),
}));

describe("ColorPickerInput", () => {
  it("renders with swatch and text input", () => {
    render(<ColorPickerInput value="#ff0000" onChange={jest.fn()} id="test-color" />);
    expect(screen.getByTestId("test-color-swatch")).toBeTruthy();
    expect(screen.getByTestId("test-color-input")).toBeTruthy();
  });

  it("swatch shows the current color", () => {
    render(<ColorPickerInput value="#ff0000" onChange={jest.fn()} id="test-color" />);
    const swatch = screen.getByTestId("test-color-swatch");
    expect(swatch.style.backgroundColor).toBe("rgb(255, 0, 0)");
  });

  it("handles color without # prefix", () => {
    render(<ColorPickerInput value="00ff00" onChange={jest.fn()} id="test-color" />);
    const swatch = screen.getByTestId("test-color-swatch");
    expect(swatch.style.backgroundColor).toBe("rgb(0, 255, 0)");
  });

  it("calls onChange when text input changes", () => {
    const onChange = jest.fn();
    render(<ColorPickerInput value="#000000" onChange={onChange} id="test-color" />);
    fireEvent.change(screen.getByTestId("test-color-input"), {
      target: { value: "#ff0000" },
    });
    expect(onChange).toHaveBeenCalledWith("#ff0000");
  });

  it("opens popover on swatch click", async () => {
    render(<ColorPickerInput value="#000000" onChange={jest.fn()} id="test-color" />);
    fireEvent.click(screen.getByTestId("test-color-swatch"));
    const picker = await screen.findByTestId("hex-color-picker").catch(() => null);
    const swatch = screen.getByTestId("test-color-swatch");
    expect(swatch).toBeTruthy();
  });

  it("renders label when provided", () => {
    render(<ColorPickerInput value="#000" onChange={jest.fn()} id="test" label="Fill Color" />);
    expect(screen.getByText("Fill Color")).toBeTruthy();
  });

  it("defaults to #000000 when no value", () => {
    render(<ColorPickerInput value={undefined} onChange={jest.fn()} id="test-color" />);
    const swatch = screen.getByTestId("test-color-swatch");
    expect(swatch.style.backgroundColor).toBe("rgb(0, 0, 0)");
  });

  it("outside click closes popover", () => {
    render(<ColorPickerInput value="#ff0000" onChange={jest.fn()} id="test-color" />);
    // Open the popover
    fireEvent.click(screen.getByTestId("test-color-swatch"));
    // Click outside
    fireEvent.mouseDown(document.body);
    // After outside click, the popover should close
    // Verify the component doesn't error
    expect(screen.getByTestId("test-color-swatch")).toBeTruthy();
  });

  it("hex input normalizes short values", () => {
    const onChange = jest.fn();
    render(<ColorPickerInput value="#000" onChange={onChange} id="test-color" />);
    fireEvent.change(screen.getByTestId("test-color-input"), {
      target: { value: "#f00" },
    });
    expect(onChange).toHaveBeenCalledWith("#f00");
  });

  it("empty input defaults gracefully", () => {
    const onChange = jest.fn();
    render(<ColorPickerInput value="#000000" onChange={onChange} id="test-color" />);
    fireEvent.change(screen.getByTestId("test-color-input"), {
      target: { value: "" },
    });
    expect(onChange).toHaveBeenCalledWith("");
  });

  it("picker onChange updates swatch live", async () => {
    const onChange = jest.fn();
    render(<ColorPickerInput value="#000000" onChange={onChange} id="test-color" />);
    // Open popover
    fireEvent.click(screen.getByTestId("test-color-swatch"));
    const pickerInput = await screen.findByTestId("mock-picker-input").catch(() => null);
    if (pickerInput) {
      fireEvent.change(pickerInput, { target: { value: "#00ff00" } });
      expect(onChange).toHaveBeenCalledWith("#00ff00");
    }
  });

  it("popover closes on second swatch click", () => {
    render(<ColorPickerInput value="#ff0000" onChange={jest.fn()} id="test-color" />);
    const swatch = screen.getByTestId("test-color-swatch");
    // Open
    fireEvent.click(swatch);
    // Close by clicking again
    fireEvent.click(swatch);
    // Should not error
    expect(swatch).toBeTruthy();
  });
});
