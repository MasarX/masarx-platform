"use client";

import dynamic from "next/dynamic";
import { createUiTranslator } from "../i18n";

export type PdfPreviewProps = {
  pdfBase64: string;
  testIdPrefix?: string;
};

const t = createUiTranslator("ui.labelDesigner.preview");

export const PdfPreview = dynamic<PdfPreviewProps>(
  () => import("./pdf-preview-document").then((mod) => mod.PdfPreview),
  {
    ssr: false,
    loading: () => (
      <div className="flex items-center justify-center p-8 text-sm text-ui-muted">
        {t("pdfLoading")}
      </div>
    ),
  },
);
