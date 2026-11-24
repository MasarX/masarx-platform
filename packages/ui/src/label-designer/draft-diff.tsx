"use client";

import * as React from "react";
import { createUiTranslator } from "../i18n";

const t = createUiTranslator("ui.labelDesigner.diff");

type DraftDiffProps = {
  leftJson: string;
  rightJson: string;
  leftLabel?: string;
  rightLabel?: string;
  testIdPrefix?: string;
};

type DiffLine = {
  key: string;
  left: string;
  right: string;
  status: "equal" | "changed" | "added" | "removed";
};

function flattenObject(obj: unknown, prefix = ""): Record<string, string> {
  const result: Record<string, string> = {};
  if (!obj || typeof obj !== "object") {
    result[prefix || "(root)"] = String(obj);
    return result;
  }
  if (Array.isArray(obj)) {
    obj.forEach((item, i) => {
      const key = prefix ? `${prefix}[${i}]` : `[${i}]`;
      Object.assign(result, flattenObject(item, key));
    });
    return result;
  }
  for (const [k, v] of Object.entries(obj as Record<string, unknown>)) {
    const key = prefix ? `${prefix}.${k}` : k;
    if (v && typeof v === "object") {
      Object.assign(result, flattenObject(v, key));
    } else {
      result[key] = v === null ? "null" : v === undefined ? "undefined" : String(v);
    }
  }
  return result;
}

function computeDiff(leftJson: string, rightJson: string): DiffLine[] {
  let leftObj: unknown;
  let rightObj: unknown;
  try {
    leftObj = JSON.parse(leftJson);
  } catch {
    leftObj = {};
  }
  try {
    rightObj = JSON.parse(rightJson);
  } catch {
    rightObj = {};
  }

  const leftFlat = flattenObject(leftObj);
  const rightFlat = flattenObject(rightObj);
  const allKeys = new Set([...Object.keys(leftFlat), ...Object.keys(rightFlat)]);
  const lines: DiffLine[] = [];

  for (const key of Array.from(allKeys).sort()) {
    const leftVal = leftFlat[key];
    const rightVal = rightFlat[key];
    if (leftVal === undefined) {
      lines.push({ key, left: "", right: rightVal!, status: "added" });
    } else if (rightVal === undefined) {
      lines.push({ key, left: leftVal, right: "", status: "removed" });
    } else if (leftVal !== rightVal) {
      lines.push({ key, left: leftVal, right: rightVal, status: "changed" });
    } else {
      lines.push({ key, left: leftVal, right: rightVal, status: "equal" });
    }
  }

  return lines;
}

const STATUS_BG: Record<string, string> = {
  added: "bg-[rgb(var(--ui-success)/0.08)]",
  removed: "bg-[rgb(var(--ui-danger)/0.08)]",
  changed: "bg-[rgb(var(--ui-warning)/0.08)]",
  equal: "",
};

export function DraftDiff({
  leftJson,
  rightJson,
  leftLabel = "Before",
  rightLabel = "After",
  testIdPrefix,
}: DraftDiffProps) {
  const prefix = testIdPrefix || "draft-diff";
  const [showEqual, setShowEqual] = React.useState(false);

  const lines = React.useMemo(
    () => computeDiff(leftJson, rightJson),
    [leftJson, rightJson],
  );

  const filtered = showEqual ? lines : lines.filter((l) => l.status !== "equal");
  const changeCount = lines.filter((l) => l.status !== "equal").length;

  return (
    <div className="space-y-2" data-testid={`${prefix}-container`}>
      <div className="flex items-center justify-between">
        <span className="text-xs text-ui-muted">
          {t("changes", { count: changeCount })}
        </span>
        <label className="flex items-center gap-1 text-[10px] text-ui-muted">
          <input
            type="checkbox"
            checked={showEqual}
            onChange={(e) => setShowEqual(e.target.checked)}
            className="h-3 w-3"
          />
          {t("showUnchanged")}
        </label>
      </div>
      <div className="max-h-64 overflow-auto rounded border border-ui-border/50">
        <table className="w-full text-xs">
          <thead>
            <tr className="border-b border-ui-border/50 bg-ui-paper/50">
              <th className="px-2 py-1 text-left font-medium text-ui-muted">{t("key")}</th>
              <th className="px-2 py-1 text-left font-medium text-ui-muted">{leftLabel}</th>
              <th className="px-2 py-1 text-left font-medium text-ui-muted">{rightLabel}</th>
            </tr>
          </thead>
          <tbody>
            {filtered.map((line) => (
              <tr key={line.key} className={STATUS_BG[line.status]}>
                <td className="max-w-[160px] truncate px-2 py-0.5 font-mono text-[10px] text-ui-muted">
                  {line.key}
                </td>
                <td className="max-w-[120px] truncate px-2 py-0.5 font-mono text-[10px]">
                  {line.left}
                </td>
                <td className="max-w-[120px] truncate px-2 py-0.5 font-mono text-[10px]">
                  {line.right}
                </td>
              </tr>
            ))}
            {filtered.length === 0 ? (
              <tr>
                <td colSpan={3} className="px-2 py-4 text-center text-ui-muted">
                  {t("noDifferences")}
                </td>
              </tr>
            ) : null}
          </tbody>
        </table>
      </div>
    </div>
  );
}
