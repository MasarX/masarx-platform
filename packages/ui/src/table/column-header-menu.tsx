"use client";

import * as React from "react";
import {
  Dropdown,
  DropdownContent,
  DropdownItem,
  DropdownSeparator,
  DropdownTrigger,
} from "../dropdown";
import type { ResourceColumn } from "./columns";
import { resolveColumnLabel } from "./columns";
import type { TranslateFn } from "./types";

export type ColumnMenuAction =
  | "sortAsc"
  | "sortDesc"
  | "hide"
  | "pin"
  | "unpin"
  | "autoWidth";

type ColumnHeaderMenuProps = {
  t: TranslateFn;
  column: ResourceColumn;
  isPinned: boolean;
  onAction: (action: ColumnMenuAction, columnKey: string) => void;
  trigger: React.ReactNode;
};

export function ColumnHeaderMenu({
  t,
  column,
  isPinned,
  onAction,
  trigger,
}: ColumnHeaderMenuProps) {
  const label = resolveColumnLabel(column);
  return (
    <Dropdown>
      <DropdownTrigger asChild>{trigger}</DropdownTrigger>
      <DropdownContent align="start" className="min-w-[160px]">
        <DropdownItem onSelect={() => onAction("sortAsc", column.key)}>
          {t("columnMenu.sortAsc")}
        </DropdownItem>
        <DropdownItem onSelect={() => onAction("sortDesc", column.key)}>
          {t("columnMenu.sortDesc")}
        </DropdownItem>
        <DropdownSeparator />
        <DropdownItem onSelect={() => onAction("hide", column.key)}>
          {t("columnMenu.hide")}
        </DropdownItem>
        <DropdownItem
          onSelect={() =>
            onAction(isPinned ? "unpin" : "pin", column.key)
          }
        >
          {isPinned ? t("columnMenu.unpin") : t("columnMenu.pin")}
        </DropdownItem>
        <DropdownSeparator />
        <DropdownItem onSelect={() => onAction("autoWidth", column.key)}>
          {t("columnMenu.autoWidth")}
        </DropdownItem>
      </DropdownContent>
    </Dropdown>
  );
}
