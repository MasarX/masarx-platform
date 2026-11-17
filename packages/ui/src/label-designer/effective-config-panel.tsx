"use client";

import * as React from "react";
import { createUiTranslator } from "../i18n";
import { Section } from "../section";
import { Textarea } from "../textarea";

const t = createUiTranslator("ui.labelDesigner.effectiveConfig");

type EffectiveConfigPanelProps = {
  prefix: string;
  effectiveDesignJson: string;
  effectiveRenderPolicyJson: string;
  effectivePrintProfileJson: string;
  fieldCatalogJson: string;
  mediaCatalogJson: string;
};

export function EffectiveConfigPanel({
  prefix,
  effectiveDesignJson,
  effectiveRenderPolicyJson,
  effectivePrintProfileJson,
  fieldCatalogJson,
  mediaCatalogJson,
}: EffectiveConfigPanelProps) {
  return (
    <Section
      title={t("title")}
      description={t("description")}
    >
      <div className="grid gap-3 lg:grid-cols-2">
        <div className="space-y-1">
          <label className="text-xs font-medium text-ui-muted">
            {t("labelDesign")}
          </label>
          <Textarea
            value={effectiveDesignJson}
            readOnly
            rows={10}
            className="font-mono text-xs"
            data-testid={`${prefix}-effective-design`}
          />
        </div>
        <div className="space-y-1">
          <label className="text-xs font-medium text-ui-muted">
            {t("printProfile")}
          </label>
          <Textarea
            value={effectivePrintProfileJson}
            readOnly
            rows={10}
            className="font-mono text-xs"
            data-testid={`${prefix}-effective-print-profile`}
          />
        </div>
        <div className="space-y-1">
          <label className="text-xs font-medium text-ui-muted">
            {t("renderPolicy")}
          </label>
          <Textarea
            value={effectiveRenderPolicyJson}
            readOnly
            rows={8}
            className="font-mono text-xs"
            data-testid={`${prefix}-effective-render-policy`}
          />
        </div>
        <div className="space-y-1">
          <label className="text-xs font-medium text-ui-muted">
            {t("fieldCatalog")}
          </label>
          <Textarea
            value={fieldCatalogJson}
            readOnly
            rows={8}
            className="font-mono text-xs"
            data-testid={`${prefix}-field-catalog`}
          />
        </div>
        <div className="space-y-1">
          <label className="text-xs font-medium text-ui-muted">
            {t("mediaCatalog")}
          </label>
          <Textarea
            value={mediaCatalogJson}
            readOnly
            rows={8}
            className="font-mono text-xs"
            data-testid={`${prefix}-media-catalog`}
          />
        </div>
      </div>
    </Section>
  );
}
