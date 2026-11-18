"use client";
import * as React from "react";
import type { UiCommandDefinition } from "@masarx/api";
import { Button } from "./button";
import Link from "next/link";
import { createUiTranslator } from "./i18n";

export type ResourceAction = {
  key: string;
  label: string;
  command: UiCommandDefinition;
  href?: string | null;
  disabledReason?: string | null;
};

type ResourceActionsProps = {
  actions: ResourceAction[];
  selectedIds: string[];
};

export function ResourceActions({ actions, selectedIds }: ResourceActionsProps) {
  const t = createUiTranslator("ui.resourceActions");
  if (!actions || actions.length === 0) return null;

  return (
    <div className="flex flex-wrap items-center gap-2">
      {actions.map((action) => {
        const hasSelection = selectedIds.length > 0;
        const disabledReason =
          action.disabledReason?.trim() ||
          (!hasSelection
            ? t("disabled.noSelection")
            : !action.href
              ? t("disabled.noHref")
              : "");
        const canRun = hasSelection && Boolean(action.href) && !disabledReason;
        return canRun && action.href ? (
          <Button key={action.key} asChild variant="ghost">
            <Link href={action.href}>{action.label}</Link>
          </Button>
        ) : (
          <Button
            key={action.key}
            type="button"
            variant="ghost"
            disabled
            title={disabledReason}
          >
            {action.label}
          </Button>
        );
      })}
    </div>
  );
}
