/**
 * @jest-environment jsdom
 */
import * as React from "react";
import { render, screen, fireEvent } from "@testing-library/react";
import { KeyboardShortcutsModal } from "../../packages/ui/src/label-designer/keyboard-shortcuts-modal";

describe("KeyboardShortcutsModal", () => {
  it("renders nothing when closed", () => {
    const { container } = render(
      <KeyboardShortcutsModal open={false} onClose={jest.fn()} />,
    );
    expect(container.querySelector("[data-testid='keyboard-shortcuts-modal']")).toBeNull();
  });

  it("renders modal when open", () => {
    render(<KeyboardShortcutsModal open={true} onClose={jest.fn()} />);
    expect(screen.getByTestId("keyboard-shortcuts-modal")).toBeTruthy();
  });

  it("shows keyboard shortcuts list", () => {
    render(<KeyboardShortcutsModal open={true} onClose={jest.fn()} />);
    expect(screen.getByText("Undo")).toBeTruthy();
    expect(screen.getByText("Redo")).toBeTruthy();
    expect(screen.getByText("Copy")).toBeTruthy();
    expect(screen.getByText("Paste")).toBeTruthy();
    expect(screen.getByText("Delete selected")).toBeTruthy();
    expect(screen.getByText("Nudge 1px")).toBeTruthy();
    expect(screen.getByText("Inline edit")).toBeTruthy();
    expect(screen.getByText("Pan canvas")).toBeTruthy();
  });

  it("calls onClose on Escape", () => {
    const onClose = jest.fn();
    render(<KeyboardShortcutsModal open={true} onClose={onClose} />);
    fireEvent.keyDown(window, { key: "Escape" });
    expect(onClose).toHaveBeenCalled();
  });

  it("calls onClose on backdrop click", () => {
    const onClose = jest.fn();
    render(<KeyboardShortcutsModal open={true} onClose={onClose} />);
    fireEvent.click(screen.getByTestId("keyboard-shortcuts-modal"));
    expect(onClose).toHaveBeenCalled();
  });

  it("does not close on content click", () => {
    const onClose = jest.fn();
    render(<KeyboardShortcutsModal open={true} onClose={onClose} />);
    // Click on the content area (not backdrop)
    const content = screen.getByText("Undo");
    fireEvent.click(content);
    expect(onClose).not.toHaveBeenCalled();
  });

  it("has close button that calls onClose", () => {
    const onClose = jest.fn();
    render(<KeyboardShortcutsModal open={true} onClose={onClose} />);
    const closeBtn = screen.getByLabelText("Close");
    fireEvent.click(closeBtn);
    expect(onClose).toHaveBeenCalled();
  });

  it("uses platform-specific modifier (Ctrl in jsdom)", () => {
    render(<KeyboardShortcutsModal open={true} onClose={jest.fn()} />);
    // In jsdom navigator.userAgent won't match Mac, so modifier should be Ctrl
    const kbd = screen.getAllByText(/Ctrl/);
    expect(kbd.length).toBeGreaterThan(0);
  });

  it("shows at least 15 shortcuts", () => {
    const { container } = render(
      <KeyboardShortcutsModal open={true} onClose={jest.fn()} />,
    );
    // Each shortcut row has a kbd element
    const rows = container.querySelectorAll("kbd");
    expect(rows.length).toBeGreaterThanOrEqual(15);
  });

  it("content click does not close modal (stopPropagation)", () => {
    const onClose = jest.fn();
    render(<KeyboardShortcutsModal open={true} onClose={onClose} />);
    // Click on a description text inside the modal
    const desc = screen.getByText("Deselect");
    fireEvent.click(desc);
    expect(onClose).not.toHaveBeenCalled();
  });
});
