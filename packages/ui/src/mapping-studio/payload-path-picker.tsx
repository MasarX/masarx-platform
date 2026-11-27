"use client";

import * as React from "react";
import { Button } from "../button";
import { createUiTranslator } from "../i18n";

type PayloadPathPickerProps = {
  title?: string;
  paths: string[];
  onSelect: (path: string) => void;
  testIdPrefix?: string | null;
};

export function PayloadPathPicker({
  title,
  paths,
  onSelect,
  testIdPrefix,
}: PayloadPathPickerProps) {
  const t = createUiTranslator("ui.mappingStudio.payloadPathPicker");
  return (
    <div className="space-y-3">
      <div className="text-sm font-medium text-ui-ink">{title ?? t("title")}</div>
      {paths.length === 0 ? (
        <p className="text-sm text-ui-muted">{t("empty")}</p>
      ) : (
        <div className="max-h-64 space-y-2 overflow-auto rounded-xl border border-ui-border/60 bg-ui-surface/70 p-3">
          {paths.map((path) => (
            <div key={path} className="flex items-center justify-between gap-3 rounded-lg border border-ui-border/30 bg-ui-paper/60 px-3 py-2">
              <code className="min-w-0 flex-1 truncate text-xs text-ui-ink">{path}</code>
              <Button
                type="button"
                size="sm"
                variant="ghost"
                onClick={() => onSelect(path)}
                data-testid={testIdPrefix ? `${testIdPrefix}-path-${path.replace(/[^a-zA-Z0-9]+/g, "_")}` : undefined}
              >
                {t("use")}
              </Button>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
