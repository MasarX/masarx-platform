"use client";

import * as React from "react";
import { Document, Page, pdfjs } from "react-pdf";
import "react-pdf/dist/Page/AnnotationLayer.css";
import "react-pdf/dist/Page/TextLayer.css";
import { Button } from "../button";
import { createUiTranslator } from "../i18n";
import workerUrl from "./pdf-worker-url.mjs";
import type { PdfPreviewProps } from "./pdf-preview";

const t = createUiTranslator("ui.labelDesigner.preview");

// Assign beside Document/Page so module evaluation cannot restore the default worker.
pdfjs.GlobalWorkerOptions.workerSrc = workerUrl;

const ZOOM_MIN = 0.5;
const ZOOM_MAX = 3;
const ZOOM_STEP = 0.25;

export function PdfPreview({ pdfBase64, testIdPrefix }: PdfPreviewProps) {
  const [scale, setScale] = React.useState<number>(1);
  return <PdfDocumentPreview key={pdfBase64} pdfBase64={pdfBase64} testIdPrefix={testIdPrefix} scale={scale} setScale={setScale} />;
}

function PdfDocumentPreview({
  pdfBase64, testIdPrefix, scale, setScale,
}: PdfPreviewProps & {
  scale: number;
  setScale: React.Dispatch<React.SetStateAction<number>>;
}) {
  const prefix = testIdPrefix || "pdf-preview";
  const [numPages, setNumPages] = React.useState<number>(0);
  const [pageNumber, setPageNumber] = React.useState<number>(1);
  const [loadError, setLoadError] = React.useState<string | null>(null);
  const containerRef = React.useRef<HTMLDivElement>(null);

  const fileData = React.useMemo(() => {
    if (!pdfBase64) return null;
    return `data:application/pdf;base64,${pdfBase64}`;
  }, [pdfBase64]);

  const handleLoadSuccess = React.useCallback(
    ({ numPages: pages }: { numPages: number }) => {
      setNumPages(pages);
      setPageNumber(1);
      setLoadError(null);
    },
    [],
  );

  const handleLoadError = React.useCallback((error: Error) => {
    setLoadError(error.message || "Failed to load PDF.");
    setNumPages(0);
  }, []);

  const handleZoomIn = React.useCallback(() => {
    setScale((prev) => Math.min(prev + ZOOM_STEP, ZOOM_MAX));
  }, []);

  const handleZoomOut = React.useCallback(() => {
    setScale((prev) => Math.max(prev - ZOOM_STEP, ZOOM_MIN));
  }, []);

  const handleFitWidth = React.useCallback(() => {
    setScale(1);
  }, []);

  if (!fileData) {
    return (
      <div
        className="flex items-center justify-center rounded-lg border border-dashed border-ui-border/50 bg-ui-paper/30 p-8 text-sm text-ui-muted"
        data-testid={`${prefix}-empty`}
      >
        {t("pdfEmpty")}
      </div>
    );
  }

  if (loadError) {
    return (
      <div
        className="rounded-lg border border-ui-danger/30 bg-ui-danger/5 p-4 text-sm text-ui-danger"
        data-testid={`${prefix}-error`}
      >
        {t("pdfError", { error: loadError })}
      </div>
    );
  }

  return (
    <div className="space-y-2" data-testid={`${prefix}-container`}>
      <div className="flex items-center justify-between gap-2">
        <div className="flex items-center gap-1">
          <Button
            type="button"
            size="sm"
            variant="ghost"
            onClick={handleZoomOut}
            disabled={scale <= ZOOM_MIN}
            data-testid={`${prefix}-zoom-out`}
          >
            -
          </Button>
          <span className="min-w-[3.5rem] text-center text-xs text-ui-muted">
            {Math.round(scale * 100)}%
          </span>
          <Button
            type="button"
            size="sm"
            variant="ghost"
            onClick={handleZoomIn}
            disabled={scale >= ZOOM_MAX}
            data-testid={`${prefix}-zoom-in`}
          >
            +
          </Button>
          <Button
            type="button"
            size="sm"
            variant="ghost"
            onClick={handleFitWidth}
            data-testid={`${prefix}-fit-width`}
          >
            {t("zoomFit")}
          </Button>
        </div>
        {numPages > 1 ? (
          <div className="flex items-center gap-1">
            <Button
              type="button"
              size="sm"
              variant="ghost"
              disabled={pageNumber <= 1}
              onClick={() => setPageNumber((p) => Math.max(1, p - 1))}
              data-testid={`${prefix}-prev-page`}
            >
              {t("prevPage")}
            </Button>
            <span className="text-xs text-ui-muted">
              {pageNumber} / {numPages}
            </span>
            <Button
              type="button"
              size="sm"
              variant="ghost"
              disabled={pageNumber >= numPages}
              onClick={() => setPageNumber((p) => Math.min(numPages, p + 1))}
              data-testid={`${prefix}-next-page`}
            >
              {t("nextPage")}
            </Button>
          </div>
        ) : null}
      </div>

      <div
        ref={containerRef}
        className="overflow-auto rounded-lg border border-ui-border/50 bg-ui-paper/50"
        style={{ maxHeight: "600px" }}
        data-testid={`${prefix}-viewport`}
      >
        <Document
          file={fileData}
          onLoadSuccess={handleLoadSuccess}
          onLoadError={handleLoadError}
          loading={
            <div className="flex items-center justify-center p-8 text-sm text-ui-muted">
              {t("pdfLoading")}
            </div>
          }
        >
          <Page
            pageNumber={pageNumber}
            scale={scale}
            renderAnnotationLayer={false}
            renderTextLayer={false}
          />
        </Document>
      </div>
    </div>
  );
}
