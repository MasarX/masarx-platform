"use client";

import * as React from "react";
import { Button } from "../button";
import { Input } from "../input";
import { Select } from "../select";
import type { ResourceColumn } from "./columns";
import { resolveColumnLabel } from "./columns";
import type { ConditionalFormattingRule } from "./view-types";
import type { TranslateFn } from "./types";

type ConditionalFormattingPanelProps = {
  t: TranslateFn;
  columns: ResourceColumn[];
  rules: ConditionalFormattingRule[];
  onRulesChange: (rules: ConditionalFormattingRule[]) => void;
};

const OPERATORS: { value: ConditionalFormattingRule["operator"]; label: string }[] = [
  { value: "eq", label: "equals" },
  { value: "ne", label: "not equals" },
  { value: "gt", label: "greater than" },
  { value: "gte", label: "≥" },
  { value: "lt", label: "less than" },
  { value: "lte", label: "≤" },
  { value: "contains", label: "contains" },
  { value: "empty", label: "is empty" },
  { value: "notEmpty", label: "is not empty" },
];

function makeRuleId() {
  return globalThis.crypto?.randomUUID?.() ?? `rule_${Date.now()}`;
}

export function ConditionalFormattingPanel({
  t,
  columns,
  rules,
  onRulesChange,
}: ConditionalFormattingPanelProps) {
  const handleAddRule = () => {
    const firstColumn = columns[0];
    if (!firstColumn) return;
    onRulesChange([
      ...rules,
      {
        id: makeRuleId(),
        field: firstColumn.key,
        operator: "eq",
        value: "",
        style: { bgColor: "#fef3c7", textColor: null, bold: null },
        scope: "row",
      },
    ]);
  };

  const handleRemoveRule = (id: string) => {
    onRulesChange(rules.filter((r) => r.id !== id));
  };

  const handleUpdateRule = (
    id: string,
    patch: Partial<ConditionalFormattingRule>
  ) => {
    onRulesChange(
      rules.map((r) => (r.id === id ? { ...r, ...patch } : r))
    );
  };

  return (
    <div className="space-y-3">
      <div className="text-xs font-medium text-ui-muted">
        Conditional formatting
      </div>
      {rules.map((rule) => (
        <div key={rule.id} className="flex flex-wrap items-center gap-2 text-xs">
          <Select
            value={rule.field}
            onChange={(e) => handleUpdateRule(rule.id, { field: e.target.value })}
            className="h-7 min-h-0 w-auto min-w-[100px] text-xs"
          >
            {columns.map((col) => (
              <option key={col.key} value={col.key}>
                {resolveColumnLabel(col)}
              </option>
            ))}
          </Select>
          <Select
            value={rule.operator}
            onChange={(e) =>
              handleUpdateRule(rule.id, {
                operator: e.target.value as ConditionalFormattingRule["operator"],
              })
            }
            className="h-7 min-h-0 w-auto min-w-[80px] text-xs"
          >
            {OPERATORS.map((op) => (
              <option key={op.value} value={op.value}>
                {op.label}
              </option>
            ))}
          </Select>
          {rule.operator !== "empty" && rule.operator !== "notEmpty" ? (
            <Input
              value={String(rule.value ?? "")}
              onChange={(e) => handleUpdateRule(rule.id, { value: e.target.value })}
              className="h-7 min-h-0 w-20 text-xs"
              placeholder="Value"
            />
          ) : null}
          <Input
            type="color"
            value={rule.style.bgColor ?? "#fef3c7"}
            onChange={(e) =>
              handleUpdateRule(rule.id, {
                style: { ...rule.style, bgColor: e.target.value },
              })
            }
            className="h-7 min-h-0 w-8 cursor-pointer p-0"
            title="Background color"
          />
          <Select
            value={rule.scope}
            onChange={(e) =>
              handleUpdateRule(rule.id, {
                scope: e.target.value as "row" | "cell",
              })
            }
            className="h-7 min-h-0 w-auto text-xs"
          >
            <option value="row">Row</option>
            <option value="cell">Cell</option>
          </Select>
          <Button
            type="button"
            variant="ghost"
            className="h-7 px-2 text-xs text-ui-muted"
            onClick={() => handleRemoveRule(rule.id)}
          >
            ×
          </Button>
        </div>
      ))}
      <Button
        type="button"
        variant="ghost"
        className="h-7 px-3 text-xs"
        onClick={handleAddRule}
      >
        + Add rule
      </Button>
    </div>
  );
}
