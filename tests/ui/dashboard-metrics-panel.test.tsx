import React from "react";
import { screen } from "@testing-library/react";
import { renderWithIntl as render } from "./test-utils";

import { DashboardMetricsPanel } from "../../packages/ui/src/dashboard-metrics-panel";

describe("DashboardMetricsPanel", () => {
  const defaultKpis = [
    { title: "Total shipments", value: "1,200", tone: "neutral" as const },
    { title: "Active deliveries", value: "45", tone: "success" as const },
    { title: "Pending exceptions", value: "3", tone: "warning" as const },
    { title: "Delivery rate", value: "92%", tone: "success" as const },
  ];

  it("renders all KPI cards", () => {
    render(
      <DashboardMetricsPanel
        kpis={defaultKpis}
        donutData={[]}
        testId="dash-metrics"
      />
    );

    expect(screen.getByText("Total shipments")).toBeInTheDocument();
    expect(screen.getByText("1,200")).toBeInTheDocument();
    expect(screen.getByText("Active deliveries")).toBeInTheDocument();
    expect(screen.getByText("45")).toBeInTheDocument();
    expect(screen.getByText("Pending exceptions")).toBeInTheDocument();
    expect(screen.getByText("3")).toBeInTheDocument();
    expect(screen.getByText("Delivery rate")).toBeInTheDocument();
    expect(screen.getByText("92%")).toBeInTheDocument();
  });

  it("renders test id on the wrapper", () => {
    render(
      <DashboardMetricsPanel
        kpis={defaultKpis}
        donutData={[]}
        testId="console-dashboard-metrics"
      />
    );

    expect(
      screen.getByTestId("console-dashboard-metrics")
    ).toBeInTheDocument();
  });

  it("renders donut chart when data is present", () => {
    const donutData = [
      { name: "Delivered", value: 80, color: "green" },
      { name: "In Transit", value: 15, color: "blue" },
    ];

    render(
      <DashboardMetricsPanel
        kpis={defaultKpis}
        donutData={donutData}
        donutTitle="Shipment status"
        donutCenterLabel="Total"
        donutCenterValue={95}
        testId="dash-metrics"
      />
    );

    expect(screen.getByText("Shipment status")).toBeInTheDocument();
  });

  it("hides donut chart when data is empty", () => {
    render(
      <DashboardMetricsPanel
        kpis={defaultKpis}
        donutData={[]}
        donutTitle="Shipment status"
        testId="dash-metrics"
      />
    );

    expect(screen.queryByText("Shipment status")).not.toBeInTheDocument();
  });

  it("renders with no KPIs", () => {
    const { container } = render(
      <DashboardMetricsPanel
        kpis={[]}
        donutData={[]}
        testId="dash-metrics"
      />
    );

    expect(screen.getByTestId("dash-metrics")).toBeInTheDocument();
    const grid = container.querySelector(".grid");
    expect(grid?.children.length).toBe(0);
  });
});
