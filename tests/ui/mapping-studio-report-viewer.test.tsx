import { act, fireEvent, render, screen } from "@testing-library/react";
import { OperationReportViewer } from "../../packages/ui/src/mapping-studio/operation-report-viewer";
import { copyTextToClipboard } from "../../packages/ui/src/clipboard";
import { buildDownloadBlob } from "../../packages/ui/src/mapping-studio/utils";
import * as en from "../../packages/config/messages/en.json";
import * as ar from "../../packages/config/messages/ar.json";

jest.mock("../../packages/ui/src/clipboard", () => ({ copyTextToClipboard: jest.fn() }));
jest.mock("../../packages/ui/src/mapping-studio/utils", () => ({
  ...jest.requireActual("../../packages/ui/src/mapping-studio/utils"),
  buildDownloadBlob: jest.fn(),
}));

const copy = jest.mocked(copyTextToClipboard);

describe("OperationReportViewer", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    copy.mockResolvedValue(true);
  });

  test("renders persisted report metadata and links", async () => {
    render(
      <OperationReportViewer
        appBasePath="/console"
        result={{ mapping_config_id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa" }}
        report={{
          id: "report-1",
          artifact_type: "webhook_inbound",
          save_mode: "direct",
          status: "succeeded",
          primary_resource_type: "mapping_configs",
          primary_resource_id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
          workflow_template_id: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
          correlation_id: "corr-123",
          next_steps: ["Review saved mapping", "Open workflow binding"],
        }}
      />,
    );

    expect(screen.getByText("Operation report")).toBeInTheDocument();
    expect(screen.getByText("webhook_inbound")).toBeInTheDocument();
    expect(screen.getByText("Direct")).toBeInTheDocument();
    expect(screen.getByText(/Activity reference: corr-123/)).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Open saved report" })).toHaveAttribute(
      "href",
      "/console/resources/mapping_operation_reports?id=report-1",
    );
    expect(screen.getByRole("link", { name: "Open primary resource" })).toHaveAttribute(
      "href",
      "/console/resources/mapping_configs?id=aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
    );
  });

  test("copies an allowlisted redacted summary while retaining explicit support JSON and the operator export", async () => {
    const report = {
      id: "report-2", status: "failed" as const,
      primary_resource_type: "mapping_configs",
      primary_resource_id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      next_steps: ["Review saved mapping", ("Token " + [Buffer.from("{\"alg\":\"none\"}").toString("base64url"),Buffer.from("{\"sub\":\"secret\"}").toString("base64url"),"signature"].join("."))],
      request_summary: { password: "synthetic-password", visible: "Support context" },
      result_payload: { token: "synthetic-token" },
    };
    render(
      <OperationReportViewer
        appBasePath="/console"
        report={report}
        result={{ secret: "runtime-secret", diagnostic: "Retained diagnostic" }}
      />,
    );

    await act(async () => fireEvent.click(screen.getByRole("button", { name: "Copy report details" })));
    expect(copy).toHaveBeenCalledWith(expect.stringContaining("Status: Failed"));
    const summary = copy.mock.calls[0]?.[0];
    expect(summary).toContain("Primary resource: mapping_configs (aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa)");
    expect(summary).toContain("Review saved mapping");
    expect(summary).toContain("[redacted]");
    expect(summary).not.toMatch(/synthetic-|request_summary|result_payload|eyJhbGci|runtime-secret/);
    expect(screen.getByRole("status")).toHaveTextContent("Copied to clipboard.");

    const details = screen.getByText("Report support details (redacted)").closest("details");
    expect(details).not.toHaveAttribute("open");
    fireEvent.click(screen.getByText("Report support details (redacted)"));
    await act(async () => fireEvent.click(screen.getByRole("button", { name: "Copy JSON" })));
    expect(copy).toHaveBeenLastCalledWith(expect.stringContaining("Support context"));
    expect(copy).toHaveBeenLastCalledWith(expect.not.stringContaining("synthetic-password"));
    expect(screen.getByText(/Retained diagnostic/)).toHaveTextContent("[redacted]");
    expect(screen.getByText(/Retained diagnostic/)).not.toHaveTextContent("runtime-secret");

    fireEvent.click(screen.getByRole("button", { name: "Download JSON" }));
    expect(buildDownloadBlob).toHaveBeenCalledWith("report-2.json", report);
  });

  test.each(["false", "reject"])("reports clipboard failure (%s)", async (mode) => {
    if (mode === "reject") copy.mockRejectedValue(new Error("Clipboard denied"));
    else copy.mockResolvedValue(false);
    render(<OperationReportViewer appBasePath="/console" report={{ id: "report-3" }} />);
    await act(async () => fireEvent.click(screen.getByRole("button", { name: "Copy report details" })));
    expect(screen.getByRole("status")).toHaveTextContent("Copy failed. Try again or download the report.");
  });

  test("does not report copied before the clipboard promise resolves", async () => {
    let finish!: (value: boolean) => void;
    copy.mockReturnValue(new Promise<boolean>((resolve) => { finish = resolve; }));
    render(<OperationReportViewer appBasePath="/console" report={{ id: "report-4" }} />);
    fireEvent.click(screen.getByRole("button", { name: "Copy report details" }));
    expect(screen.getByRole("status")).toBeEmptyDOMElement();
    await act(async () => finish(true));
    expect(screen.getByRole("status")).toHaveTextContent("Copied to clipboard.");
  });

  test("copies the Arabic summary with the original record identity", async () => {
    const previousLocale = process.env.NEXT_PUBLIC_LOCALE;
    process.env.NEXT_PUBLIC_LOCALE = "ar";
    try {
      render(<OperationReportViewer appBasePath="/portal" report={{ id: "report-ar", status: "failed" }} />);
      expect(screen.getByText("تقرير العملية")).toBeInTheDocument();
      await act(async () => fireEvent.click(screen.getByRole("button", { name: "نسخ تفاصيل التقرير" })));
      expect(copy).toHaveBeenCalledWith(expect.stringContaining("الحالة: فشلت"));
      expect(copy).toHaveBeenCalledWith(expect.stringContaining("مرجع النشاط: report-ar"));
      expect(screen.getByRole("status")).toHaveTextContent("تم النسخ إلى الحافظة.");
    } finally {
      if (previousLocale === undefined) delete process.env.NEXT_PUBLIC_LOCALE;
      else process.env.NEXT_PUBLIC_LOCALE = previousLocale;
    }
  });

  test.each([["en", en.ui.operationReport], ["ar", ar.ui.operationReport]] as const)(
    "report and runtime disclosures reveal only their redacted payloads (%s)", (locale, messages) => {
      const previousLocale = process.env.NEXT_PUBLIC_LOCALE;
      process.env.NEXT_PUBLIC_LOCALE = locale;
      try {
        render(<OperationReportViewer appBasePath="/portal" report={{
          id: "report-import",
          result_payload: { status: "completed", created_count: 2, password: "synthetic-secret" },
          next_steps: ["Review the imported records in the destination table or import history."],
        }} result={{ rows: [{ related_nodes: [
          { node_key: "recipient", target_record_id: "recipient-id" },
          { node_key: "destination_address", target_record_id: "address-id" },
        ] }], secret: "runtime-secret" }} />);
        const reveal = (label: string) => {
          const summary = screen.getByText(label, { selector: "summary" });
          const details = summary.closest("details")!;
          const payload = details.querySelector("pre")!;
          expect(details.open).toBe(false);
          expect(payload).not.toBeVisible();
          fireEvent.click(summary);
          expect(details.open).toBe(true);
          expect(payload).toBeVisible();
          return payload;
        };
        const report = reveal(messages.reportDetails);
        expect(report).toHaveTextContent('"created_count": 2');
        expect(report).toHaveTextContent('"status": "completed"');
        expect(report).toHaveTextContent("Review the imported records in the destination table or import history.");
        expect(report).toHaveTextContent("[redacted]");
        expect(report).not.toHaveTextContent("synthetic-secret");
        expect(report).not.toHaveTextContent("related_nodes");
        const runtime = reveal(messages.resultDetails);
        expect(runtime).toHaveTextContent('"recipient"');
        expect(runtime).toHaveTextContent('"destination_address"');
        expect(runtime).toHaveTextContent("[redacted]");
        expect(runtime).not.toHaveTextContent("runtime-secret");
      } finally {
        if (previousLocale === undefined) delete process.env.NEXT_PUBLIC_LOCALE;
        else process.env.NEXT_PUBLIC_LOCALE = previousLocale;
      }
    },
  );

  test("shows the no-report fallback when the studio has not produced a report yet", () => {
    render(<OperationReportViewer appBasePath="/console" report={null} />);

    expect(screen.getByText("No submit report is available yet.")).toBeInTheDocument();
    expect(screen.queryByRole("link", { name: "Open saved report" })).toBeNull();
  });
});
