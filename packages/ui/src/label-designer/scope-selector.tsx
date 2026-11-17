"use client";

import * as React from "react";
import { Badge } from "../badge";
import { createUiTranslator } from "../i18n";
import { Section } from "../section";
import { Select } from "../select";
import type { ScopeOption } from "./types";
import { shortId } from "./utils";

const t = createUiTranslator("ui.labelDesigner.scope");

type ScopeSelectorProps = {
  prefix: string;
  scopeOptions: ScopeOption[];
  selectedScopeKey: string;
  organizationId: string;
  scopeLoading: boolean;
  onScopeChange: (key: string) => void;
};

export function ScopeSelector({
  prefix,
  scopeOptions,
  selectedScopeKey,
  organizationId,
  scopeLoading,
  onScopeChange,
}: ScopeSelectorProps) {
  return (
    <Section
      title={t("title")}
      description={t("description")}
      actions={scopeLoading ? <Badge tone="neutral">{t("loading")}</Badge> : null}
    >
      <div className="grid gap-3 md:grid-cols-2">
        <div className="space-y-1">
          <label
            className="text-xs font-medium text-ui-muted"
            htmlFor={`${prefix}-scope`}
          >
            {t("activeScope")}
          </label>
          <Select
            id={`${prefix}-scope`}
            value={selectedScopeKey}
            onChange={(event) => onScopeChange(event.target.value)}
            data-testid={`${prefix}-scope-select`}
          >
            {scopeOptions.map((option) => (
              <option key={option.key} value={option.key}>
                {option.label}
              </option>
            ))}
          </Select>
        </div>
        <div className="space-y-1">
          <label className="text-xs font-medium text-ui-muted">{t("organization")}</label>
          <div className="rounded-md border border-ui-border/70 bg-ui-paper/70 px-3 py-2 text-sm text-ui-ink">
            {organizationId
              ? `${shortId(organizationId)} (${organizationId})`
              : "-"}
          </div>
        </div>
      </div>
    </Section>
  );
}
