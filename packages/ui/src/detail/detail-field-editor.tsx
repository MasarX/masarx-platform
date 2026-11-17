"use client";

import * as React from "react";
import { Input } from "../input";
import { Checkbox } from "../checkbox";
import { Select } from "../select";
import { Combobox } from "../combobox";
import { Button } from "../button";
import { cn } from "../utils";

export type DetailFieldEditorProps = {
  fieldKey: string;
  label: string;
  editType: string;
  value: unknown;
  options?: { label: string; value: string }[];
  saving?: boolean;
  error?: string | null;
  onSave: (key: string, value: unknown) => void;
  onCancel: () => void;
};

/**
 * Per-field inline editor for the detail view.
 * Renders the appropriate input based on editType.
 */
export function DetailFieldEditor({
  fieldKey,
  label,
  editType,
  value,
  options = [],
  saving,
  error,
  onSave,
  onCancel,
}: DetailFieldEditorProps) {
  const [editValue, setEditValue] = React.useState<unknown>(value);

  const handleSave = () => {
    onSave(fieldKey, editValue);
  };

  const handleKeyDown = (event: React.KeyboardEvent) => {
    if (event.key === "Escape") {
      event.stopPropagation();
      onCancel();
    }
    if (event.key === "Enter" && editType !== "textarea") {
      event.preventDefault();
      handleSave();
    }
  };

  const renderInput = () => {
    switch (editType) {
      case "boolean":
        return (
          <Checkbox
            checked={Boolean(editValue)}
            onChange={(e) => setEditValue(e.target.checked)}
            disabled={saving}
          />
        );
      case "select":
        return (
          <Combobox
            mode="single"
            options={options}
            value={String(editValue ?? "")}
            onChange={(next) => setEditValue(next)}
            disabled={saving}
          />
        );
      case "multiselect":
        return (
          <Combobox
            mode="multi"
            options={options}
            value={Array.isArray(editValue) ? editValue : []}
            onChange={(next) => setEditValue(next)}
            disabled={saving}
          />
        );
      case "number":
        return (
          <Input
            type="number"
            value={String(editValue ?? "")}
            onChange={(e) => setEditValue(e.target.value)}
            onKeyDown={handleKeyDown}
            disabled={saving}
            className="h-8 text-xs"
          />
        );
      case "date":
        return (
          <Input
            type="date"
            value={String(editValue ?? "")}
            onChange={(e) => setEditValue(e.target.value)}
            onKeyDown={handleKeyDown}
            disabled={saving}
            className="h-8 text-xs"
          />
        );
      case "datetime":
        return (
          <Input
            type="datetime-local"
            value={String(editValue ?? "")}
            onChange={(e) => setEditValue(e.target.value)}
            onKeyDown={handleKeyDown}
            disabled={saving}
            className="h-8 text-xs"
          />
        );
      case "uuid":
        return (
          <Input
            value={String(editValue ?? "")}
            onChange={(e) => setEditValue(e.target.value)}
            onKeyDown={handleKeyDown}
            disabled={saving}
            placeholder="00000000-0000-0000-0000-000000000000"
            spellCheck={false}
            className="h-8 font-mono text-xs tracking-tight"
          />
        );
      default:
        return (
          <Input
            value={String(editValue ?? "")}
            onChange={(e) => setEditValue(e.target.value)}
            onKeyDown={handleKeyDown}
            disabled={saving}
            className="h-8 text-xs"
          />
        );
    }
  };

  return (
    <div className="space-y-2">
      <div className="text-xs font-medium text-ui-muted">{label}</div>
      {renderInput()}
      <div className="flex items-center gap-2">
        <Button
          type="button"
          variant="ghost"
          className="h-7 px-3 text-xs"
          onClick={handleSave}
          disabled={saving}
        >
          {saving ? "Saving…" : "Save"}
        </Button>
        <Button
          type="button"
          variant="ghost"
          className="h-7 px-3 text-xs"
          onClick={onCancel}
          disabled={saving}
        >
          Cancel
        </Button>
      </div>
      {error ? (
        <div className="text-xs text-ui-danger">{error}</div>
      ) : null}
    </div>
  );
}
