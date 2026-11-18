import { fireEvent, render, screen } from "@testing-library/react";
import { OperationReportViewer } from "../../packages/ui/src/mapping-studio/operation-report-viewer";

describe("OperationReportViewer", () => {
  beforeEach(() => {
    Object.assign(navigator, {
      clipboard: {
        writeText: jest.fn().mockResolvedValue(undefined),
      },
    });
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
    expect(screen.getByText("direct")).toBeInTheDocument();
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

  test("copy button writes report JSON to clipboard", async () => {
    render(
      <OperationReportViewer
        appBasePath="/console"
        report={{
          id: "report-2",
          status: "failed",
          next_steps: [],
        }}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Copy report details" }));
    expect(navigator.clipboard.writeText).toHaveBeenCalledWith(
      expect.stringContaining("Status: failed")
    );
  });

  test("shows the no-report fallback when the studio has not produced a report yet", () => {
    render(<OperationReportViewer appBasePath="/console" report={null} />);

    expect(screen.getByText("No submit report is available yet.")).toBeInTheDocument();
    expect(screen.queryByRole("link", { name: "Open saved report" })).toBeNull();
  });
});
