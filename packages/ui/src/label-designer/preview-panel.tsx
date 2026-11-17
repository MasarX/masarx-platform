"use client";

import * as React from "react";
import { Button } from "../button";
import { ErrorBoundary } from "../error-boundary";
import { createUiTranslator } from "../i18n";
import { Section } from "../section";
import { Select } from "../select";
import { Textarea } from "../textarea";
import type { ShipmentBoxOption, ShipmentOption } from "./types";

const t = createUiTranslator("ui.labelDesigner.preview");

const LazyPdfPreview = React.lazy(() =>
  import("./pdf-preview").then((mod) => ({ default: mod.PdfPreview })),
);

type PreviewPanelProps = {
  prefix: string;
  isBusy: boolean;
  busyAction: string | null;

  shipments: ShipmentOption[];
  selectedShipmentId: string;
  shipmentBoxes: ShipmentBoxOption[];
  selectedShipmentBoxId: string;
  selectedDraftId: string;

  samplePayloadJson: string;
  previewResponseJson: string;

  onShipmentChange: (id: string) => void;
  onShipmentBoxChange: (id: string) => void;
  onLoadSamplePayload: () => void;
  onPreviewDraft: () => void;
};

function extractPdfBase64(responseJson: string): string {
  if (!responseJson) return "";
  try {
    const parsed = JSON.parse(responseJson);
    if (parsed && typeof parsed === "object" && typeof parsed.pdf_base64 === "string") {
      return parsed.pdf_base64;
    }
  } catch {
    // not valid JSON
  }
  return "";
}

export function PreviewPanel({
  prefix,
  isBusy,
  busyAction,
  shipments,
  selectedShipmentId,
  shipmentBoxes,
  selectedShipmentBoxId,
  selectedDraftId,
  samplePayloadJson,
  previewResponseJson,
  onShipmentChange,
  onShipmentBoxChange,
  onLoadSamplePayload,
  onPreviewDraft,
}: PreviewPanelProps) {
  const [showDebugJson, setShowDebugJson] = React.useState(false);
  const pdfBase64 = React.useMemo(
    () => extractPdfBase64(previewResponseJson),
    [previewResponseJson],
  );

  return (
    <Section
      title={t("title")}
      description={t("description")}
      actions={
        <div className="flex items-center gap-2">
          <Button
            type="button"
            size="sm"
            variant="ghost"
            onClick={onLoadSamplePayload}
            disabled={isBusy || !selectedShipmentId}
            data-testid={`${prefix}-load-sample`}
          >
            {busyAction === "sample-payload" ? t("loadingSample") : t("loadSample")}
          </Button>
          <Button
            type="button"
            size="sm"
            onClick={onPreviewDraft}
            disabled={isBusy || !selectedDraftId || !selectedShipmentId}
            data-testid={`${prefix}-preview`}
          >
            {busyAction === "preview-draft" ? t("rendering") : t("previewBtn")}
          </Button>
        </div>
      }
    >
      <div className="grid gap-3 md:grid-cols-2">
        <div className="space-y-1">
          <label
            className="text-xs font-medium text-ui-muted"
            htmlFor={`${prefix}-shipment`}
          >
            {t("shipment")}
          </label>
          <Select
            id={`${prefix}-shipment`}
            value={selectedShipmentId}
            onChange={(event) => onShipmentChange(event.target.value)}
            data-testid={`${prefix}-shipment`}
          >
            <option value="">{t("selectShipment")}</option>
            {shipments.map((shipment) => (
              <option key={shipment.id} value={shipment.id}>
                {shipment.label}
              </option>
            ))}
          </Select>
        </div>
        <div className="space-y-1">
          <label
            className="text-xs font-medium text-ui-muted"
            htmlFor={`${prefix}-shipment-box`}
          >
            {t("shipmentBox")}
          </label>
          <Select
            id={`${prefix}-shipment-box`}
            value={selectedShipmentBoxId}
            onChange={(event) => onShipmentBoxChange(event.target.value)}
            data-testid={`${prefix}-shipment-box`}
          >
            <option value="">{t("autoFirstBox")}</option>
            {shipmentBoxes.map((box) => (
              <option key={box.id} value={box.id}>
                {box.label}
              </option>
            ))}
          </Select>
        </div>
      </div>

      {/* PDF Preview */}
      <ErrorBoundary
        fallback={
          <div className="flex items-center justify-center rounded-lg border border-ui-danger/30 bg-ui-danger/5 p-4 text-sm text-ui-danger">
            PDF viewer failed to load. Check the raw response below for preview data.
          </div>
        }
      >
        <React.Suspense
          fallback={
            <div className="flex items-center justify-center rounded-lg border border-dashed border-ui-border/50 bg-ui-paper/30 p-8 text-sm text-ui-muted">
              {t("pdfLoading")}
            </div>
          }
        >
          <LazyPdfPreview
            pdfBase64={pdfBase64}
            testIdPrefix={`${prefix}-pdf`}
          />
        </React.Suspense>
      </ErrorBoundary>

      {/* Sample payload + debug JSON */}
      <div className="space-y-2">
        <div className="space-y-1">
          <label className="text-xs font-medium text-ui-muted">
            {t("samplePayload")}
          </label>
          <Textarea
            value={samplePayloadJson || "{}"}
            readOnly
            rows={8}
            className="font-mono text-xs"
            data-testid={`${prefix}-sample-payload`}
          />
        </div>

        <div className="space-y-1">
          <button
            type="button"
            className="text-xs font-medium text-ui-muted underline decoration-dotted hover:text-ui-ink"
            onClick={() => setShowDebugJson((v) => !v)}
            data-testid={`${prefix}-toggle-debug`}
          >
            {showDebugJson ? t("hideDebug") : t("showDebug")}
          </button>
          {showDebugJson ? (
            <Textarea
              value={previewResponseJson || "{}"}
              readOnly
              rows={10}
              className="font-mono text-xs"
              data-testid={`${prefix}-preview-response`}
            />
          ) : null}
        </div>
      </div>
    </Section>
  );
}
