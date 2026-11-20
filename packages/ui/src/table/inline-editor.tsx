"use client";

import * as React from "react";
import { cn } from "../utils";
import { Checkbox } from "../checkbox";
import { Combobox } from "../combobox";
import { Input } from "../input";
import { Textarea } from "../textarea";
import type { EditConfig, InlineEditState } from "./editing";
import type { TranslateFn } from "./types";

type InlineEditorProps = {
  t: TranslateFn;
  editState: InlineEditState;
  editConfig: EditConfig;
  editLabel: string;
  editPending: boolean;
  onUpdateValue: (value: string | boolean | string[]) => void;
  onCommit: () => void;
  onCancel: () => void;
};

/**
 * Extracted inline editor overlay for cell-level editing.
 * Handles Enter/Escape/Tab keyboard flow and auto-commit on blur.
 */
export function InlineEditor({
  t,
  editState,
  editConfig,
  editLabel,
  editPending,
  onUpdateValue,
  onCommit,
  onCancel,
}: InlineEditorProps) {
  const containerRef = React.useRef<HTMLDivElement>(null);
  const isSaving = editState.status === "saving" || editPending;

  // Auto-focus the input on mount
  React.useEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    const input = container.querySelector<HTMLElement>(
      "input:not([type=checkbox]),select,textarea,[role=combobox]"
    );
    if (input) {
      requestAnimationFrame(() => input.focus());
    }
  }, []);

  const handleKeyDown = (event: React.KeyboardEvent) => {
    if (event.defaultPrevented || event.nativeEvent.isComposing || event.keyCode === 229) return;
    if (event.key === "Escape") {
      event.stopPropagation();
      onCancel();
    }
    if (event.key === "Enter" && !event.shiftKey) {
      event.preventDefault();
      event.stopPropagation();
      onCommit();
    }
  };

  const hasLookupOptions = editConfig.options.length > 0;
  const uuidHint =
    editState.editType === "uuid" && !hasLookupOptions
      ? t("edit.uuidHint", { label: editLabel })
      : null;

  return (
    <div
      ref={containerRef}
      className="space-y-1.5 motion-safe:table-animate-fade-in"
      onKeyDown={handleKeyDown}
    >
      <div className="ring-2 ring-ui-accent/40 rounded-md">
        {editState.editType === "boolean" ? (
          <Checkbox
            aria-label={t("edit.inputAria", { label: editLabel })}
            checked={Boolean(editState.value)}
            onChange={(event) => {
              onUpdateValue(event.target.checked);
              // Auto-commit booleans
              setTimeout(onCommit, 0);
            }}
            disabled={isSaving}
          />
        ) : editState.editType === "multiselect" &&
          (editConfig.options.length ?? 0) > 0 ? (
          <Combobox
            mode="multi"
            options={editConfig.options}
            value={Array.isArray(editState.value) ? editState.value : []}
            onChange={(next) => onUpdateValue(next as string[])}
            disabled={isSaving}
            placeholder={t("edit.selectPlaceholder")}
          />
        ) : (editState.editType === "select" || editState.editType === "uuid") &&
          hasLookupOptions ? (
          <Combobox
            mode="single"
            options={editConfig.options}
            value={String(editState.value)}
            onChange={(next) => {
              onUpdateValue(next as string);
              // Auto-commit selects
              setTimeout(onCommit, 0);
            }}
            disabled={isSaving}
            placeholder={t("edit.selectPlaceholder")}
          />
        ) : editState.editType === "textarea" ? (
          <Textarea
            aria-label={t("edit.inputAria", { label: editLabel })}
            value={String(editState.value ?? "")}
            onChange={(event) => onUpdateValue(event.target.value)}
            className="min-h-[56px] text-xs border-0 ring-0 focus-visible:ring-0"
            disabled={isSaving}
          />
        ) : (
          <Input
            aria-label={t("edit.inputAria", { label: editLabel })}
            type={
              editState.editType === "number"
                ? "number"
                : editState.editType === "date"
                  ? "date"
                  : editState.editType === "datetime"
                    ? "datetime-local"
                    : "text"
            }
            value={String(editState.value ?? "")}
            onChange={(event) => onUpdateValue(event.target.value)}
            placeholder={
              editState.editType === "uuid"
                ? "00000000-0000-0000-0000-000000000000"
                : undefined
            }
            spellCheck={editState.editType === "uuid" ? false : undefined}
            autoCapitalize={editState.editType === "uuid" ? "off" : undefined}
            autoCorrect={editState.editType === "uuid" ? "off" : undefined}
            className={cn(
              "h-8 text-xs border-0 ring-0 focus-visible:ring-0",
              editState.editType === "uuid" && "font-mono tracking-tight"
            )}
            disabled={isSaving}
          />
        )}
      </div>
      {editState.status === "error" ? (
        <div className="text-xs text-ui-danger">
          {editState.error ?? t("edit.error")}
        </div>
      ) : null}
      {uuidHint ? (
        <div className="text-[10px] text-ui-muted">{uuidHint}</div>
      ) : null}
    </div>
  );
}
