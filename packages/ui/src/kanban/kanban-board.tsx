"use client";

import * as React from "react";
import { Badge } from "../badge";
import { createUiTranslator } from "../i18n";
import { Select } from "../select";
import { cn } from "../utils";

export type KanbanCard = {
  id: string;
  title: string;
  subtitle?: string | null;
  meta?: string | null;
  tone?: "neutral" | "success" | "warning" | "danger" | "info";
};

export type KanbanColumn = {
  id: string;
  title: string;
  tone?: "neutral" | "success" | "warning" | "danger" | "info";
  cards: KanbanCard[];
};

type KanbanBoardProps = {
  columns: KanbanColumn[];
  onCardClick?: (card: KanbanCard, columnId: string) => void;
  onCardMove?: (cardId: string, fromColumnId: string, toColumnId: string) => void;
  className?: string;
};

/**
 * Kanban board with status columns for visual pipeline management.
 * Supports card click and moving cards between columns by drag or by each card's
 * "Move to column" select (WCAG 2.5.7: a single-pointer and keyboard path).
 */
export function KanbanBoard({
  columns,
  onCardClick,
  onCardMove,
  className,
}: KanbanBoardProps) {
  const t = createUiTranslator("ui.kanbanBoard");
  const [dragCard, setDragCard] = React.useState<{ cardId: string; fromColumn: string } | null>(null);
  const [dragOverColumn, setDragOverColumn] = React.useState<string | null>(null);

  const handleDragStart = (cardId: string, fromColumn: string) => {
    setDragCard({ cardId, fromColumn });
  };

  const handleDragOver = (e: React.DragEvent, columnId: string) => {
    e.preventDefault();
    setDragOverColumn(columnId);
  };

  const handleDrop = (e: React.DragEvent, toColumn: string) => {
    e.preventDefault();
    if (dragCard && dragCard.fromColumn !== toColumn) {
      onCardMove?.(dragCard.cardId, dragCard.fromColumn, toColumn);
    }
    setDragCard(null);
    setDragOverColumn(null);
  };

  return (
    <div className={cn("flex gap-4 overflow-x-auto pb-4", className)}>
      {columns.map((column) => (
        <div key={column.id} className={cn("flex w-72 shrink-0 flex-col rounded-lg border border-ui-border/40 bg-ui-surface/50", dragOverColumn === column.id && "ring-2 ring-ui-accent/30")} onDragOver={(e) => handleDragOver(e, column.id)} onDragLeave={() => setDragOverColumn(null)} onDrop={(e) => handleDrop(e, column.id)}>
          <div className="flex items-center gap-2 border-b border-ui-border/30 px-3 py-2.5">
            <Badge tone={column.tone ?? "neutral"} size="sm" dot>{column.title}</Badge>
            <span className="ms-auto text-xs text-ui-muted">{column.cards.length}</span>
          </div>

          <div className="flex-1 space-y-2 p-2">
            {column.cards.map((card) => (
              <div key={card.id} draggable onDragStart={() => handleDragStart(card.id, column.id)} className={cn("rounded-lg border border-ui-border/30 bg-ui-paper p-3 shadow-sm transition", "hover:border-ui-accent/30 hover:shadow-md")}>
                <button type="button" onClick={() => onCardClick?.(card, column.id)} className="block w-full cursor-pointer text-start active:scale-[0.98]">
                  <span className="block text-sm font-medium text-ui-ink">{card.title}</span>
                  {card.subtitle ? (<span className="mt-0.5 block truncate text-xs text-ui-muted">{card.subtitle}</span>) : null}
                  {card.meta ? (<span className="mt-1 block text-[10px] text-ui-muted/60">{card.meta}</span>) : null}
                </button>
                {onCardMove && columns.length > 1 ? (
                  <Select
                    aria-label={t("moveCard", { card: card.title })}
                    value=""
                    onChange={(e) => {
                      if (e.target.value) onCardMove(card.id, column.id, e.target.value);
                    }}
                    className="mt-2 h-8 text-xs"
                  >
                    <option value="">{t("moveTo")}</option>
                    {columns.filter((other) => other.id !== column.id).map((other) => (
                      <option key={other.id} value={other.id}>{other.title}</option>
                    ))}
                  </Select>
                ) : null}
              </div>
            ))}
            {column.cards.length === 0 ? (
              <div className="py-6 text-center text-xs text-ui-muted/40">{t("noItems")}</div>
            ) : null}
          </div>
        </div>
      ))}
    </div>
  );
}
