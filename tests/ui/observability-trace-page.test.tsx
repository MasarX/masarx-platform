import React from "react";
import { screen } from "@testing-library/react";
import { renderWithIntl } from "./test-utils";
import { createUiTranslator } from "../../packages/ui/src/i18n";
import portalEn from "../../apps/portal/messages/en.json";
import portalAr from "../../apps/portal/messages/ar.json";

jest.mock("@masarx/ui", () => ({
  __esModule: true,
  labelFromKey: (key: string) => key,
  PageHeader: ({ title, description }: { title: string; description: string }) => (
    <div>
      <h1>{title}</h1>
      <p>{description}</p>
    </div>
  ),
  ResourceTable: ({
    columns,
    items,
    emptyMessage,
  }: {
    columns?: Array<{ key: string; label: string }>;
    items?: Array<Record<string, unknown>>;
    emptyMessage?: string | null;
  }) => (
    <div>
      <div>{columns?.map((column) => column.label).join(",")}</div>
      <div>{items?.length ? `${items.length} rows` : emptyMessage}</div>
    </div>
  ),
  Section: ({ title, children }: { title: string; children?: React.ReactNode }) => (
    <section>
      <h2>{title}</h2>
      {children}
    </section>
  ),
  resolvePaginationSettings: (value: unknown) => value,
}));

const { ObservabilityTracePage } = require("../../apps/shared/observability-trace-page");

describe("ObservabilityTracePage", () => {
  const translate = (key: string, values?: Record<string, string | number>) => {
    if (key === "observability.trace.correlationLabel") {
      return `Trace: ${values?.id ?? ""}`;
    }
    return key;
  };

  const paginationSettings = {
    allowedSizes: [10, 25, 50],
    defaultPageSize: 10,
  };

  it.each([
    ["en", portalEn, "Activity timeline", "Tracking key: activity-1", "No activity events recorded for this reference."],
    ["ar", portalAr, "الخط الزمني للنشاط", "مفتاح التتبع: activity-1", "لا توجد أحداث نشاط مسجلة لهذا المرجع."],
  ] as const)("renders real Portal %s activity labels and tracking identity", (locale, messages, title, tracking, empty) => {
    renderWithIntl(<ObservabilityTracePage correlationId="activity-1" trace={{}}
      errorMessage={null} paginationSettings={paginationSettings} testIdPrefix="portal"
      t={createUiTranslator(undefined, { locale, messages })} />);
    expect(screen.getByRole("heading", { name: title })).toBeInTheDocument();
    expect(screen.getByText(tracking)).toBeInTheDocument();
    expect(screen.getByText(empty)).toBeInTheDocument();
  });

  it("shows ready state and renders event sections when trace data is available", () => {
    renderWithIntl(
      <ObservabilityTracePage
        correlationId="123e4567-e89b-12d3-a456-426614174000"
        errorMessage={null}
        paginationSettings={paginationSettings}
        testIdPrefix="console"
        t={translate}
        trace={{
          observability_events: [
            { id: "obs-1", severity: "info", message: "started" },
            { id: "obs-2", severity: "error", message: "failed" },
          ],
          domain_events: [{ id: "dom-1", name: "shipment.created" }],
          workflow_runs: [{ id: "run-1", status: "completed" }],
        } as never}
      />
    );

    expect(screen.getByTestId("console-trace-ready")).toBeInTheDocument();
    expect(
      screen.getByText("Trace: 123e4567-e89b-12d3-a456-426614174000")
    ).toBeInTheDocument();
    expect(
      screen.getByText("observability.trace.sections.observability")
    ).toBeInTheDocument();
    expect(screen.getByText("observability.trace.sections.domain")).toBeInTheDocument();
    expect(
      screen.getByText("observability.trace.sections.workflowRuns")
    ).toBeInTheDocument();
  });

  it("uses empty-state copy for each table when arrays are absent", () => {
    renderWithIntl(
      <ObservabilityTracePage
        correlationId="00000000-0000-0000-0000-000000000000"
        errorMessage={null}
        paginationSettings={paginationSettings}
        testIdPrefix="portal"
        t={translate}
        trace={{} as never}
      />
    );

    expect(screen.getByTestId("portal-trace-ready")).toBeInTheDocument();
    expect(
      screen.getByText("observability.trace.empty.observability")
    ).toBeInTheDocument();
    expect(screen.getByText("observability.trace.empty.domain")).toBeInTheDocument();
    expect(screen.getByText("observability.trace.empty.workflowRuns")).toBeInTheDocument();
  });

  it("treats null trace payload as an empty, ready state", () => {
    renderWithIntl(
      <ObservabilityTracePage
        correlationId="22222222-2222-2222-2222-222222222222"
        errorMessage={null}
        paginationSettings={paginationSettings}
        testIdPrefix="console"
        t={translate}
        trace={null}
      />
    );

    expect(screen.getByTestId("console-trace-ready")).toBeInTheDocument();
    expect(screen.getByText("observability.trace.empty.domain")).toBeInTheDocument();
    expect(screen.getByText("observability.trace.empty.workflowRuns")).toBeInTheDocument();
    expect(screen.getByText("observability.trace.empty.observability")).toBeInTheDocument();
  });

  it("renders error state and suppresses section content", () => {
    renderWithIntl(
      <ObservabilityTracePage
        correlationId="11111111-1111-1111-1111-111111111111"
        errorMessage="Observability API unavailable"
        paginationSettings={paginationSettings}
        testIdPrefix="portal"
        t={translate}
        trace={null}
      />
    );

    expect(screen.getByTestId("portal-trace-error")).toBeInTheDocument();
    expect(
      screen.getByText("Observability API unavailable")
    ).toBeInTheDocument();
    expect(
      screen.queryByText("observability.trace.sections.observability")
    ).not.toBeInTheDocument();
  });
});
