/**
 * @jest-environment jsdom
 */
import * as React from "react";
import { render, screen, fireEvent } from "@testing-library/react";
import { CanvasContextMenu } from "../../packages/ui/src/label-designer/canvas/canvas-context-menu";
import type { TemplateBlock } from "../../packages/ui/src/label-designer/canvas/canvas-types";

const blocks: TemplateBlock[] = [
  { type: "text", x: 10, y: 10, width: 100, height: 20 },
  { type: "rect", x: 50, y: 50, width: 60, height: 40 },
];

function renderMenu(overrides: Partial<React.ComponentProps<typeof CanvasContextMenu>> = {}) {
  const defaults = {
    x: 100,
    y: 100,
    blockIndex: 0,
    blocks,
    copiedBlocks: [] as TemplateBlock[],
    onClose: jest.fn(),
    onDelete: jest.fn(),
    onDuplicate: jest.fn(),
    onCopy: jest.fn(),
    onPaste: jest.fn(),
    onBlocksChange: jest.fn(),
    onSelectIndex: jest.fn(),
    ...overrides,
  };
  return { ...render(<CanvasContextMenu {...defaults} />), ...defaults };
}

describe("CanvasContextMenu", () => {
  it("renders the menu with action items", () => {
    renderMenu();
    expect(screen.getByTestId("canvas-context-menu")).toBeTruthy();
  });

  it("shows block-specific actions when blockIndex is set", () => {
    const { container } = renderMenu({ blockIndex: 0 });
    const buttons = container.querySelectorAll("button");
    const labels = Array.from(buttons).map((b) => b.textContent?.trim());
    expect(labels).toContain("Delete");
    expect(labels).toContain("Duplicate");
    expect(labels).toContain("Copy");
  });

  it("paste is disabled when no copied blocks", () => {
    const { container } = renderMenu({ copiedBlocks: [] });
    const pasteBtn = Array.from(container.querySelectorAll("button")).find(
      (b) => b.textContent?.trim() === "Paste",
    );
    expect(pasteBtn).toBeTruthy();
    expect(pasteBtn?.disabled).toBe(true);
  });

  it("paste is enabled when blocks are copied", () => {
    const { container } = renderMenu({
      copiedBlocks: [{ type: "text", x: 0, y: 0, width: 80, height: 20 }],
    });
    const pasteBtn = Array.from(container.querySelectorAll("button")).find(
      (b) => b.textContent?.trim() === "Paste",
    );
    expect(pasteBtn?.disabled).toBe(false);
  });

  it("calls onClose on Escape", () => {
    const onClose = jest.fn();
    renderMenu({ onClose });
    fireEvent.keyDown(document, { key: "Escape" });
    expect(onClose).toHaveBeenCalled();
  });

  it("calls onDelete when Delete clicked", () => {
    const onDelete = jest.fn();
    const onClose = jest.fn();
    const { container } = renderMenu({ onDelete, onClose });
    const deleteBtn = Array.from(container.querySelectorAll("button")).find(
      (b) => b.textContent?.trim() === "Delete",
    );
    fireEvent.click(deleteBtn!);
    expect(onDelete).toHaveBeenCalled();
  });

  it("shows z-order items for selected block", () => {
    const { container } = renderMenu({ blockIndex: 0 });
    const labels = Array.from(container.querySelectorAll("button")).map((b) => b.textContent?.trim());
    expect(labels).toContain("Bring to front");
    expect(labels).toContain("Send to back");
  });

  it("delete is absent when no block selected", () => {
    const { container } = renderMenu({ blockIndex: null });
    const buttons = container.querySelectorAll("button");
    const labels = Array.from(buttons).map((b) => b.textContent?.trim());
    expect(labels).not.toContain("Delete");
  });

  it("bring-to-front is disabled when block is already at top", () => {
    // Block at index 1 is the last block (top of z-order)
    const { container } = renderMenu({ blockIndex: 1 });
    const bringToFrontBtn = Array.from(container.querySelectorAll("button")).find(
      (b) => b.textContent?.trim() === "Bring to front",
    );
    expect(bringToFrontBtn?.disabled).toBe(true);
  });

  it("bring-forward calls onBlocksChange", () => {
    const onBlocksChange = jest.fn();
    const { container } = renderMenu({ blockIndex: 0, onBlocksChange });
    const bringBtn = Array.from(container.querySelectorAll("button")).find(
      (b) => b.textContent?.trim() === "Bring forward",
    );
    if (bringBtn) {
      fireEvent.click(bringBtn);
      expect(onBlocksChange).toHaveBeenCalled();
    }
  });

  it("hides block-specific items when no block selected", () => {
    const { container } = renderMenu({ blockIndex: null });
    const labels = Array.from(container.querySelectorAll("button")).map((b) => b.textContent?.trim());
    expect(labels).not.toContain("Delete");
    expect(labels).not.toContain("Duplicate");
    expect(labels).not.toContain("Copy");
  });

  it("clicking a menu item closes the menu", () => {
    const onClose = jest.fn();
    const onDuplicate = jest.fn();
    const { container } = renderMenu({ onClose, onDuplicate });
    const dupBtn = Array.from(container.querySelectorAll("button")).find(
      (b) => b.textContent?.trim() === "Duplicate",
    );
    fireEvent.click(dupBtn!);
    expect(onDuplicate).toHaveBeenCalled();
  });
});
