"use client";

import * as React from "react";
import {
  Dropdown,
  DropdownContent,
  DropdownItem,
  DropdownSeparator,
} from "../dropdown";
import type { TranslateFn } from "./types";

export type ContextMenuAction =
  | "open"
  | "openNewTab"
  | "edit"
  | "duplicate"
  | "copyId"
  | "copyRowJson"
  | "delete";

export type ContextMenuState = {
  rowId: string;
  rowData: Record<string, unknown>;
  x: number;
  y: number;
} | null;

type TableContextMenuProps = {
  t: TranslateFn;
  state: ContextMenuState;
  onAction: (action: ContextMenuAction, rowId: string, rowData: Record<string, unknown>) => void;
  onClose: () => void;
  rowHref?: string | null;
  canEdit?: boolean;
  canDelete?: boolean;
};

export function TableContextMenu({
  t,
  state,
  onAction,
  onClose,
  rowHref,
  canEdit = false,
  canDelete = false,
}: TableContextMenuProps) {
  if (!state) return null;

  const handleAction = (action: ContextMenuAction) => {
    onAction(action, state.rowId, state.rowData);
    onClose();
  };

  return (
    <Dropdown open onOpenChange={(open) => { if (!open) onClose(); }}>
      <div
        style={{
          position: "fixed",
          left: state.x,
          top: state.y,
          width: 0,
          height: 0,
          zIndex: 9999,
        }}
      />
      <DropdownContent
        style={{
          position: "fixed",
          left: state.x,
          top: state.y,
        }}
        align="start"
        side="bottom"
        className="z-[9999] min-w-[180px]"
      >
        {rowHref ? (
          <>
            <DropdownItem onSelect={() => handleAction("open")}>
              {t("contextMenu.open")}
            </DropdownItem>
            <DropdownItem onSelect={() => handleAction("openNewTab")}>
              {t("contextMenu.openNewTab")}
            </DropdownItem>
            <DropdownSeparator />
          </>
        ) : null}
        {canEdit ? (
          <DropdownItem onSelect={() => handleAction("edit")}>
            {t("contextMenu.edit")}
          </DropdownItem>
        ) : null}
        <DropdownItem onSelect={() => handleAction("duplicate")}>
          {t("contextMenu.duplicate")}
        </DropdownItem>
        <DropdownSeparator />
        <DropdownItem onSelect={() => handleAction("copyId")}>
          {t("contextMenu.copyId")}
        </DropdownItem>
        <DropdownItem onSelect={() => handleAction("copyRowJson")}>
          {t("contextMenu.copyRowJson")}
        </DropdownItem>
        {canDelete ? (
          <>
            <DropdownSeparator />
            <DropdownItem
              onSelect={() => handleAction("delete")}
              className="text-[rgb(var(--ui-danger))]"
            >
              {t("contextMenu.delete")}
            </DropdownItem>
          </>
        ) : null}
      </DropdownContent>
    </Dropdown>
  );
}
