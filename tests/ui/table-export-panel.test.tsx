import { fireEvent, render, screen } from "@testing-library/react";
import type { TranslateFn } from "../../packages/ui/src/table/types";
import { TableExportPanel } from "../../packages/ui/src/table/export-panel";

const t: TranslateFn = (key) => key;

function renderPanel(
  override: Partial<React.ComponentProps<typeof TableExportPanel>> = {}
) {
  const defaults: React.ComponentProps<typeof TableExportPanel> = {
    t,
    analyticsEnabled: true,
    onExportMetrics: jest.fn(),
    metricsExportDisabled: false,
    onExportCsv: jest.fn(),
    exportDisabled: false,
    onExportExcel: jest.fn(),
    excelExportDisabled: false,
    testIdPrefix: "test",
    ...override,
  };
  return render(<TableExportPanel {...defaults} />);
}

describe("TableExportPanel", () => {
  it("renders export buttons", () => {
    renderPanel();
    expect(screen.getByTestId("test-export-panel")).toBeInTheDocument();
    expect(screen.getByText("export.csv")).toBeInTheDocument();
    expect(screen.getByText("export.excel")).toBeInTheDocument();
  });

  it("calls onExportCsv when CSV button clicked", () => {
    const onExportCsv = jest.fn();
    renderPanel({ onExportCsv });
    fireEvent.click(screen.getByText("export.csv"));
    expect(onExportCsv).toHaveBeenCalledTimes(1);
  });

  it("calls onExportExcel when Excel button clicked", () => {
    const onExportExcel = jest.fn();
    renderPanel({ onExportExcel });
    fireEvent.click(screen.getByText("export.excel"));
    expect(onExportExcel).toHaveBeenCalledTimes(1);
  });

  it("shows metrics button when analyticsEnabled", () => {
    renderPanel({ analyticsEnabled: true });
    expect(screen.getByText("export.metrics")).toBeInTheDocument();
    expect(screen.getByTestId("test-export-metrics")).toBeInTheDocument();
  });

  it("hides metrics button when analytics disabled", () => {
    renderPanel({ analyticsEnabled: false });
    expect(screen.queryByText("export.metrics")).not.toBeInTheDocument();
  });

  it("disables buttons when disabled flags set", () => {
    renderPanel({
      exportDisabled: true,
      excelExportDisabled: true,
      metricsExportDisabled: true,
    });
    expect(screen.getByTestId("test-export-csv")).toBeDisabled();
    expect(screen.getByTestId("test-export-excel")).toBeDisabled();
    expect(screen.getByTestId("test-export-metrics")).toBeDisabled();
  });
});
