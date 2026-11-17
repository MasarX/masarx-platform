jest.mock("next-intl", () => ({
  NextIntlClientProvider: ({ children }: { children: unknown }) => children,
  useTranslations:
    (namespace?: string) =>
    (key: string) =>
      namespace ? `${namespace}.${key}` : key,
  createTranslator:
    ({ namespace }: { namespace?: string } = {}) =>
    (key: string) =>
      namespace ? `${namespace}.${key}` : key,
}));

import type { ReactElement } from "react";
import { screen, within } from "@testing-library/react";
import { axe } from "jest-axe";
import { renderWithIntl } from "./test-utils";
import { RouteOperationsWorkspacePage } from "../../packages/ui/src/route-operations-workspace-page";
import { getVerifiedUser } from "@masarx/auth";
import { createUiServerClient } from "@masarx/api/server";

jest.mock("@masarx/auth", () => ({
  getVerifiedUser: jest.fn(),
}));

jest.mock("@masarx/api/server", () => ({
  createUiServerClient: jest.fn(),
}));

const mockedGetVerifiedUser = getVerifiedUser as jest.Mock;
const mockedCreateUiServerClient = createUiServerClient as jest.Mock;

function createAuthenticatedSession() {
  mockedGetVerifiedUser.mockResolvedValue({
    user: { id: "user-1", email: "gxhmruwnxrrgxpwtklhlhutg@example.invalid" },
    error: null,
  });
}

function createUiClientMock(resourceKeys: string[]) {
  const commands = resourceKeys.map((key) => ({
    key: `${key}.triage`,
    label: `triage ${key}`,
    schema_category: `resource:${key}`,
    capability: `${key}.write`,
    execution: { type: "workflow" },
  }));
  return {
    context: jest.fn().mockResolvedValue({
      me: {
        user: { id: "user-1", email: "gxhmruwnxrrgxpwtklhlhutg@example.invalid", user_type: "ops_admin" },
        access_scope: {
          scope_type: "global",
          scope_id: "global",
          scope_label: "Global",
        },
      },
      navigation: {
        app: "console",
        sections: [
          {
            id: "operations",
            label: "Operations",
            items: resourceKeys.map((key) => ({
              id: key,
              label: key.replaceAll("_", " "),
              href: `/console/resources/${key}`,
              resource: key,
            })),
          },
        ],
      },
    }),
    readRegistry: jest.fn().mockResolvedValue({
      resources: resourceKeys.map((key) => ({
        key,
        label: key.replaceAll("_", " "),
        capability_read: `${key}.read`,
      })),
    }),
    commandRegistry: jest.fn().mockResolvedValue({
      commands,
    }),
    dashboardMetrics: jest.fn().mockResolvedValue({
      metrics: resourceKeys.map((key, index) => ({ resource: key, total: index + 1 })),
    }),
    listResource: jest.fn().mockResolvedValue({
      resource: "fallback",
      items: [],
      limit: 1,
      offset: 0,
      total: 0,
    }),
  };
}

describe("ExceptionInboxWorkspacePage", () => {
  beforeEach(() => {
    jest.resetAllMocks();
  });

  it("filters lanes to exception-oriented resources when available", async () => {
    createAuthenticatedSession();
    mockedCreateUiServerClient.mockReturnValue(
      createUiClientMock(["shipments", "dispatch_alerts", "workflow_exceptions"])
    );

    const node = await RouteOperationsWorkspacePage({
      appBasePath: "/console",
      appKey: "console",
      resourceSelector: "exceptions",
      workspacePathSegment: "exceptions",
      i18nNamespace: "ui.exceptionInbox",
      testIdPrefix: "console-exception-inbox",
    });

    renderWithIntl(node as ReactElement);

    expect(screen.getAllByText("dispatch alerts").length).toBeGreaterThan(0);
    expect(screen.getAllByText("workflow exceptions").length).toBeGreaterThan(0);
    expect(screen.queryByText("shipments")).not.toBeInTheDocument();
  });

  it("detects warehouse Batch 3 exception lanes from registry metadata", async () => {
    createAuthenticatedSession();
    const uiClient = createUiClientMock([
      "warehouse_transfers",
      "handling_units",
      "scan_events",
    ]);
    uiClient.readRegistry.mockResolvedValue({
      resources: [
        {
          key: "warehouse_transfers",
          label: "warehouse transfers",
          capability_read: "warehouse_transfers.read",
          column_labels: {
            unmanifested_shipment_count: "Unmanifested exceptions",
            missing_shipment_count: "Missing shipment incidents",
            damaged_shipment_count: "Damage alerts",
            driver_user_id: "Assigned driver",
          },
        },
        {
          key: "handling_units",
          label: "handling units",
          capability_read: "handling_units.read",
        },
        {
          key: "scan_events",
          label: "scan events",
          capability_read: "scan_events.read",
          column_labels: {
            correction_reason: "Correction exception reason",
            correction_approval_task_id: "Manual review approval task",
            actor_user_id: "Assigned operator",
          },
        },
      ],
    });
    mockedCreateUiServerClient.mockReturnValue(uiClient);

    const node = await RouteOperationsWorkspacePage({
      appBasePath: "/console",
      appKey: "console",
      resourceSelector: "exceptions",
      workspacePathSegment: "exceptions",
      i18nNamespace: "ui.exceptionInbox",
      testIdPrefix: "console-exception-inbox",
    });

    renderWithIntl(node as ReactElement);

    expect(screen.getAllByText("warehouse transfers").length).toBeGreaterThan(0);
    expect(screen.getAllByText("scan events").length).toBeGreaterThan(0);
    expect(screen.queryByText("handling units")).not.toBeInTheDocument();
  });

  it("detects the B04 mis-sort exception lane from row-driven registry metadata", async () => {
    createAuthenticatedSession();
    const uiClient = createUiClientMock([
      "mis_sort_exceptions",
      "baskets",
    ]);
    uiClient.readRegistry.mockResolvedValue({
      resources: [
        {
          key: "mis_sort_exceptions",
          label: "mis-sort exceptions",
          capability_read: "baskets.read",
          column_labels: {
            exception_reason: "Exception reason",
            expected_zone_id: "Expected zone exception bucket",
            actual_zone_id: "Current zone exception bucket",
          },
        },
        {
          key: "baskets",
          label: "baskets",
          capability_read: "baskets.read",
        },
      ],
    });
    mockedCreateUiServerClient.mockReturnValue(uiClient);

    const node = await RouteOperationsWorkspacePage({
      appBasePath: "/console",
      appKey: "console",
      resourceSelector: "exceptions",
      workspacePathSegment: "exceptions",
      i18nNamespace: "ui.exceptionInbox",
      testIdPrefix: "console-exception-inbox",
    });

    renderWithIntl(node as ReactElement);

    expect(screen.getAllByText("mis-sort exceptions").length).toBeGreaterThan(0);
    expect(screen.queryByText("baskets")).not.toBeInTheDocument();
  });

  it("detects the B04 wrong-zone exception lane from row-driven registry metadata", async () => {
    createAuthenticatedSession();
    const uiClient = createUiClientMock([
      "wrong_zone_exceptions",
      "baskets",
    ]);
    uiClient.readRegistry.mockResolvedValue({
      resources: [
        {
          key: "wrong_zone_exceptions",
          label: "wrong-zone exceptions",
          capability_read: "baskets.read",
          column_labels: {
            exception_reason: "Exception reason",
            expected_zone_id: "Expected zone",
            actual_zone_id: "Actual zone",
          },
        },
        {
          key: "baskets",
          label: "baskets",
          capability_read: "baskets.read",
        },
      ],
    });
    mockedCreateUiServerClient.mockReturnValue(uiClient);

    const node = await RouteOperationsWorkspacePage({
      appBasePath: "/console",
      appKey: "console",
      resourceSelector: "exceptions",
      workspacePathSegment: "exceptions",
      i18nNamespace: "ui.exceptionInbox",
      testIdPrefix: "console-exception-inbox",
    });

    renderWithIntl(node as ReactElement);

    expect(screen.getAllByText("wrong-zone exceptions").length).toBeGreaterThan(0);
    expect(screen.queryByText("baskets")).not.toBeInTheDocument();
  });

  it("shows selector fallback notice when no exception lanes are detected", async () => {
    createAuthenticatedSession();
    mockedCreateUiServerClient.mockReturnValue(
      createUiClientMock(["shipments", "routes"])
    );

    const node = await RouteOperationsWorkspacePage({
      appBasePath: "/console",
      appKey: "console",
      resourceSelector: "exceptions",
      workspacePathSegment: "exceptions",
      i18nNamespace: "ui.exceptionInbox",
      testIdPrefix: "console-exception-inbox",
    });

    renderWithIntl(node as ReactElement);

    expect(
      screen.getByText("ui.exceptionInbox.lanes.selectorFallbackTitle")
    ).toBeInTheDocument();
    expect(screen.getAllByText("shipments").length).toBeGreaterThan(0);
    expect(screen.getAllByText("routes").length).toBeGreaterThan(0);
  });

  it("renders triage presets and severity summary cards for exception lanes", async () => {
    createAuthenticatedSession();
    mockedCreateUiServerClient.mockReturnValue(
      createUiClientMock([
        "critical_incidents",
        "dispatch_exception_review",
        "dispatch_exception_review_mine",
        "shipments_delayed",
        "sla_deadline_alerts",
        "unassigned_exceptions",
      ])
    );

    const node = await RouteOperationsWorkspacePage({
      appBasePath: "/console",
      appKey: "console",
      resourceSelector: "exceptions",
      workspacePathSegment: "exceptions",
      i18nNamespace: "ui.exceptionInbox",
      testIdPrefix: "console-exception-inbox",
    });

    const { container } = renderWithIntl(node as ReactElement);

    expect(
      screen.getByText("ui.exceptionInbox.summary.criticalLanes")
    ).toBeInTheDocument();
    expect(
      screen.getByText("ui.exceptionInbox.summary.slaRiskLanes")
    ).toBeInTheDocument();
    expect(
      screen.getByText("ui.exceptionInbox.summary.slaCountdownLanes")
    ).toBeInTheDocument();
    expect(
      screen.getByText("ui.exceptionInbox.summary.unownedLanes")
    ).toBeInTheDocument();
    expect(
      screen.getByText("ui.exceptionInbox.triage.title")
    ).toBeInTheDocument();
    expect(
      screen.getByText("ui.exceptionInbox.triage.workflowCoverage")
    ).toBeInTheDocument();

    const highestRiskLink = screen
      .getByText("ui.exceptionInbox.triage.highestRisk")
      .closest("a");
    expect(highestRiskLink).toHaveAttribute(
      "href",
      "/console/operations/exceptions/critical_incidents"
    );

    const manualReviewLink = screen
      .getByText("ui.exceptionInbox.triage.manualReview")
      .closest("a");
    expect(manualReviewLink).toHaveAttribute(
      "href",
      "/console/operations/exceptions/dispatch_exception_review_mine"
    );

    const slaCountdownLink = screen
      .getByText("ui.exceptionInbox.triage.slaCountdown")
      .closest("a");
    expect(slaCountdownLink).toHaveAttribute(
      "href",
      "/console/operations/exceptions/sla_deadline_alerts"
    );

    const unownedLink = screen
      .getByText("ui.exceptionInbox.triage.unowned")
      .closest("a");
    expect(unownedLink).toHaveAttribute(
      "href",
      "/console/operations/exceptions/unassigned_exceptions"
    );

    const runHighestRiskWorkflowsLink = screen
      .getByText("ui.exceptionInbox.triage.runHighestRisk")
      .closest("a");
    expect(runHighestRiskWorkflowsLink).toHaveAttribute(
      "href",
      "/console/commands?category=resource%3Acritical_incidents&access=allowed"
    );

    const runManualReviewWorkflowsLink = screen
      .getByText("ui.exceptionInbox.triage.runManualReview")
      .closest("a");
    expect(runManualReviewWorkflowsLink).toHaveAttribute(
      "href",
      "/console/commands?category=resource%3Adispatch_exception_review_mine&access=allowed"
    );

    const runSlaCountdownWorkflowsLink = screen
      .getByText("ui.exceptionInbox.triage.runSlaCountdown")
      .closest("a");
    expect(runSlaCountdownWorkflowsLink).toHaveAttribute(
      "href",
      "/console/commands?category=resource%3Asla_deadline_alerts&access=allowed"
    );

    const runUnownedWorkflowsLink = screen
      .getByText("ui.exceptionInbox.triage.runUnowned")
      .closest("a");
    expect(runUnownedWorkflowsLink).toHaveAttribute(
      "href",
      "/console/commands?category=resource%3Aunassigned_exceptions&access=allowed"
    );

    const runAutomationReadyWorkflowsLink = screen
      .getByText("ui.exceptionInbox.triage.runAutomationReady")
      .closest("a");
    expect(runAutomationReadyWorkflowsLink).toHaveAttribute(
      "href",
      "/console/commands?category=resource%3Acritical_incidents&access=allowed"
    );

    expect(
      screen.getAllByText("ui.exceptionInbox.lanes.openLaneCommands").length
    ).toBeGreaterThan(0);
    expect(
      screen.getByTestId("console-exception-inbox-triage-matrix")
    ).toBeInTheDocument();
    const results = await axe(container);
    expect(results).toHaveNoViolations();
  });

  it("surfaces SLA and ownership signals from row-driven exception metadata", async () => {
    createAuthenticatedSession();
    const uiClient = createUiClientMock([
      "dispatch_exception_review",
      "dispatch_exception_review_mine",
      "unassigned_exceptions",
    ]);
    uiClient.readRegistry.mockResolvedValue({
      resources: [
        {
          key: "dispatch_exception_review",
          label: "dispatch exception review",
          capability_read: "dispatch_exception_review.read",
          column_labels: {
            assigned_to: "Assigned owner",
            sla_due_at: "Resolution deadline",
          },
        },
        {
          key: "dispatch_exception_review_mine",
          label: "my exception reviews",
          capability_read: "dispatch_exception_review.read",
        },
        {
          key: "unassigned_exceptions",
          label: "unassigned exceptions",
          capability_read: "unassigned_exceptions.read",
          column_labels: {
            status_reason: "Exception reason",
          },
        },
      ],
    });
    mockedCreateUiServerClient.mockReturnValue(uiClient);

    const node = await RouteOperationsWorkspacePage({
      appBasePath: "/console",
      appKey: "console",
      resourceSelector: "exceptions",
      workspacePathSegment: "exceptions",
      i18nNamespace: "ui.exceptionInbox",
      testIdPrefix: "console-exception-inbox",
    });

    renderWithIntl(node as ReactElement);

    const triageMatrix = screen.getByTestId("console-exception-inbox-triage-matrix");
    const triageRows = within(triageMatrix).getAllByRole("row");
    const ownedRow = triageRows.find((row) =>
      within(row).queryByText("dispatch exception review")
    );
    expect(ownedRow).toBeTruthy();
    expect(
      within(ownedRow as HTMLElement).getByText(
        "ui.exceptionInbox.triage.matrix.slaRiskCountdown"
      )
    ).toBeInTheDocument();
    expect(
      within(ownedRow as HTMLElement).getByText(
        "ui.exceptionInbox.triage.matrix.manualReview"
      )
    ).toBeInTheDocument();

    const mineRow = triageRows.find((row) =>
      within(row).queryByText("my exception reviews")
    );
    expect(mineRow).toBeTruthy();
    expect(
      within(mineRow as HTMLElement).getByText(
        "ui.exceptionInbox.triage.matrix.manualReview"
      )
    ).toBeInTheDocument();

    const unownedRow = triageRows.find((row) =>
      within(row).queryByText("unassigned exceptions")
    );
    expect(unownedRow).toBeTruthy();
    expect(
      within(unownedRow as HTMLElement).getByText(
        "ui.exceptionInbox.triage.matrix.unowned"
      )
    ).toBeInTheDocument();
  });

  it("shows a triage warning when command registry is unavailable", async () => {
    createAuthenticatedSession();
    const uiClient = createUiClientMock(["critical_incidents"]);
    uiClient.commandRegistry.mockRejectedValue(new Error("registry offline"));
    mockedCreateUiServerClient.mockReturnValue(uiClient);

    const node = await RouteOperationsWorkspacePage({
      appBasePath: "/console",
      appKey: "console",
      resourceSelector: "exceptions",
      workspacePathSegment: "exceptions",
      i18nNamespace: "ui.exceptionInbox",
      testIdPrefix: "console-exception-inbox",
    });

    renderWithIntl(node as ReactElement);

    expect(
      screen.getByText("ui.exceptionInbox.triage.commandRegistryWarning")
    ).toBeInTheDocument();
    expect(
      screen.queryByText("ui.exceptionInbox.triage.runHighestRisk")
    ).not.toBeInTheDocument();
  });
});
