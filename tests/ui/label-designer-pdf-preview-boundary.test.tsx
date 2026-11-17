/**
 * @jest-environment jsdom
 */
import * as React from "react";
import { render, screen } from "@testing-library/react";

const mockRenderer = jest.fn(({ pdfBase64, testIdPrefix }) => (
  <div data-testid={testIdPrefix} data-pdf={pdfBase64} />
));
jest.mock("../../packages/ui/src/label-designer/pdf-preview-document", () => ({
  PdfPreview: mockRenderer,
}));
jest.mock("next/dynamic", () => ({
  __esModule: true,
  default: jest.fn(() => (props: { pdfBase64: string; testIdPrefix?: string }) => mockRenderer(props)),
}));

import dynamic from "next/dynamic";
import { PdfPreview } from "../../packages/ui/src/label-designer/pdf-preview";

test("public PDF boundary disables SSR and resolves the document renderer", async () => {
  const [loader, options] = (dynamic as jest.Mock).mock.calls[0];
  expect(options.ssr).toBe(false);
  expect(await loader()).toBe(mockRenderer);
});

test("public PDF boundary forwards the existing input and test prefix", () => {
  render(<PdfPreview pdfBase64="ZG9jdW1lbnQ=" testIdPrefix="public-pdf" />);
  expect(screen.getByTestId("public-pdf")).toHaveAttribute("data-pdf", "ZG9jdW1lbnQ=");
});

test("public PDF boundary preserves a localized loading state", () => {
  const [, options] = (dynamic as jest.Mock).mock.calls[0];
  const Loading = options.loading;
  render(<Loading />);
  expect(screen.getByText("Loading PDF…")).toBeInTheDocument();
});
