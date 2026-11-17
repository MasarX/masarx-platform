/**
 * @jest-environment jsdom
 */
import * as React from "react";
import { act, fireEvent, render, screen } from "@testing-library/react";

type DocumentProps = {
  file: string;
  children?: React.ReactNode;
  onLoadSuccess: (value: { numPages: number }) => void;
  onLoadError: (error: Error) => void;
};
const mockDocuments: DocumentProps[] = [];
jest.mock("react-pdf", () => ({
  pdfjs: { version: "fixture", GlobalWorkerOptions: { workerSrc: "/fixture-worker.mjs" } },
  Document: (props: DocumentProps) => {
    mockDocuments.push(props);
    return <div data-testid="document-boundary" data-file={props.file}>{props.children}</div>;
  },
  Page: ({ pageNumber, scale }: { pageNumber: number; scale: number }) =>
    <div data-testid="page-boundary" data-page={pageNumber} data-scale={scale} />,
}));

jest.mock("../../packages/ui/src/label-designer/pdf-worker-url.mjs", () => ({
  __esModule: true, default: "/_next/static/media/pdf.worker.fixture.mjs",
}));
import { pdfjs } from "react-pdf";
import { PdfPreview } from "../../packages/ui/src/label-designer/pdf-preview-document";

const preview = (pdfBase64: string) => <PdfPreview pdfBase64={pdfBase64} testIdPrefix="pdf" />;
const latest = () => mockDocuments[mockDocuments.length - 1];
function load(pages: number) {
  act(() => latest().onLoadSuccess({ numPages: pages }));
}

describe("PdfPreview document lifecycle", () => {
  beforeEach(() => { mockDocuments.length = 0; });

  test("sets the renderer worker URL instead of retaining the library default", () => {
    expect(pdfjs.GlobalWorkerOptions.workerSrc).toBe("/_next/static/media/pdf.worker.fixture.mjs");
  });

  test("empty input does not mount the document boundary", () => {
    render(preview(""));
    expect(screen.getByTestId("pdf-empty")).toBeInTheDocument();
    expect(mockDocuments).toHaveLength(0);
  });

  test("loads base64 and preserves bounded multi-page controls", () => {
    render(preview("Zmlyc3Q="));
    expect(screen.getByTestId("document-boundary")).toHaveAttribute("data-file", "data:application/pdf;base64,Zmlyc3Q=");
    load(2);
    expect(screen.getByText("1 / 2")).toBeInTheDocument();
    expect(screen.getByTestId("pdf-prev-page")).toBeDisabled();
    fireEvent.click(screen.getByTestId("pdf-next-page"));
    expect(screen.getByTestId("page-boundary")).toHaveAttribute("data-page", "2");
    expect(screen.getByText("2 / 2")).toBeInTheDocument();
    expect(screen.getByTestId("pdf-next-page")).toBeDisabled();
    fireEvent.click(screen.getByTestId("pdf-prev-page"));
    expect(screen.getByTestId("page-boundary")).toHaveAttribute("data-page", "1");
  });

  test("bounds zoom at 50–300 percent and fit restores 100 percent", () => {
    render(preview("em9vbQ=="));
    load(1);
    for (let i = 0; i < 20; i++) fireEvent.click(screen.getByTestId("pdf-zoom-in"));
    expect(screen.getByTestId("page-boundary")).toHaveAttribute("data-scale", "3");
    expect(screen.getByTestId("pdf-zoom-in")).toBeDisabled();
    for (let i = 0; i < 20; i++) fireEvent.click(screen.getByTestId("pdf-zoom-out"));
    expect(screen.getByTestId("page-boundary")).toHaveAttribute("data-scale", "0.5");
    expect(screen.getByTestId("pdf-zoom-out")).toBeDisabled();
    fireEvent.click(screen.getByTestId("pdf-fit-width"));
    expect(screen.getByTestId("page-boundary")).toHaveAttribute("data-scale", "1");
  });

  test("same-document rerenders retain page and zoom; replacement retains user zoom", () => {
    const { rerender } = render(preview("c3RhYmxl"));
    load(3);
    fireEvent.click(screen.getByTestId("pdf-next-page"));
    fireEvent.click(screen.getByTestId("pdf-zoom-in"));
    rerender(preview("c3RhYmxl"));
    expect(screen.getByTestId("page-boundary")).toHaveAttribute("data-page", "2");
    expect(screen.getByTestId("page-boundary")).toHaveAttribute("data-scale", "1.25");
    rerender(preview("cmVwbGFjZW1lbnQ="));
    expect(screen.getByTestId("page-boundary")).toHaveAttribute("data-scale", "1.25");
  });

  test("replacement starts on page one without stale pagination before load completes", () => {
    const { rerender } = render(preview("b2xk"));
    load(3);
    fireEvent.click(screen.getByTestId("pdf-next-page"));
    fireEvent.click(screen.getByTestId("pdf-next-page"));
    rerender(preview("bmV3"));
    expect(screen.getByTestId("document-boundary")).toHaveAttribute("data-file", "data:application/pdf;base64,bmV3");
    expect(screen.getByTestId("page-boundary")).toHaveAttribute("data-page", "1");
    expect(screen.queryByTestId("pdf-next-page")).not.toBeInTheDocument();
    load(1);
    expect(screen.getByTestId("page-boundary")).toHaveAttribute("data-page", "1");
  });

  test("a new document recovers after the previous document fails", () => {
    const { rerender } = render(preview("YnJva2Vu"));
    act(() => latest().onLoadError(new Error("broken PDF")));
    expect(screen.getByTestId("pdf-error")).toHaveTextContent("broken PDF");
    expect(screen.queryByTestId("document-boundary")).not.toBeInTheDocument();
    rerender(preview("cmVjb3ZlcmVk"));
    expect(screen.queryByTestId("pdf-error")).not.toBeInTheDocument();
    expect(screen.getByTestId("document-boundary")).toHaveAttribute("data-file", "data:application/pdf;base64,cmVjb3ZlcmVk");
    load(2);
    expect(screen.getByText("1 / 2")).toBeInTheDocument();
  });

  test.each(["success", "error"])("late old-document %s cannot overwrite the replacement", outcome => {
    const { rerender } = render(preview("b2xkLWxhdGU="));
    const old = latest();
    rerender(preview("bmV3LWN1cnJlbnQ="));
    load(2);
    act(() => {
      if (outcome === "success") old.onLoadSuccess({ numPages: 9 });
      else old.onLoadError(new Error("stale failure"));
    });
    expect(screen.queryByTestId("pdf-error")).not.toBeInTheDocument();
    expect(screen.getByText("1 / 2")).toBeInTheDocument();
    expect(screen.getByTestId("document-boundary")).toHaveAttribute("data-file", "data:application/pdf;base64,bmV3LWN1cnJlbnQ=");
  });
});
