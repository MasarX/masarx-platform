/**
 * WCAG 2.5.7: a kanban card moves between columns without dragging (#301).
 */
import * as React from "react";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { KanbanBoard } from "../../packages/ui/src/kanban/kanban-board";

const columns = [
  { id: "pending", title: "Pending", cards: [{ id: "1", title: "Card A" }] },
  { id: "transit", title: "In Transit", cards: [] },
  { id: "delivered", title: "Delivered", cards: [] },
];

describe("KanbanBoard move without dragging", () => {
  test("Tab reaches the card's move select, which lists the other columns and calls onCardMove", async () => {
    const user = userEvent.setup();
    const onCardMove = jest.fn();
    render(<KanbanBoard columns={columns} onCardMove={onCardMove} />);

    await user.tab();
    expect(screen.getByRole("button", { name: "Card A" })).toHaveFocus();
    await user.tab();
    const move = screen.getByRole("combobox", { name: "Move to column: Card A" });
    expect(move).toHaveFocus();
    expect(Array.from((move as HTMLSelectElement).options).map((o) => o.text)).toEqual([
      "Move to column…",
      "In Transit",
      "Delivered",
    ]);

    await user.selectOptions(move, "delivered");
    expect(onCardMove).toHaveBeenCalledWith("1", "pending", "delivered");
  });

  test("Enter on a card opens it", async () => {
    const user = userEvent.setup();
    const onCardClick = jest.fn();
    render(<KanbanBoard columns={columns} onCardClick={onCardClick} />);

    await user.tab();
    await user.keyboard("{Enter}");
    expect(onCardClick).toHaveBeenCalledWith(expect.objectContaining({ id: "1" }), "pending");
  });

  test("without onCardMove there is no move select", () => {
    render(<KanbanBoard columns={columns} />);
    expect(screen.queryByRole("combobox")).toBeNull();
  });
});
