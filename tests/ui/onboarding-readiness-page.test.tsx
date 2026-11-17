import type React from "react";
import { render, screen } from "@testing-library/react";
import { OnboardingReadinessPage } from "../../packages/ui/src/onboarding-readiness-page";
import { createUiServerClient } from "@masarx/api/server";

jest.mock("@masarx/api/server", () => ({
  createUiServerClient: jest.fn(),
}));

const mockedCreateUiServerClient = createUiServerClient as jest.Mock;

describe("OnboardingReadinessPage", () => {
  beforeEach(() => {
    jest.resetAllMocks();
  });

  it("renders readiness summary and plugin table", async () => {
    mockedCreateUiServerClient.mockReturnValue({
      me: jest.fn().mockResolvedValue({
        capabilities: [
          "settings.read",
          "workflow_runs.read",
          "integration_plugins.read",
        ],
        access_scope: {
          scope_type: "tenant",
          scope_id: "tenant-1",
        },
      }),
      onboardingReadiness: jest.fn().mockResolvedValue({
        scope_type: "tenant",
        scope_id: "tenant-1",
        generated_at: "2026-04-17T10:11:12.000Z",
        overall_status: "healthy",
        healthy: true,
        settings_defaults: {
          status: "healthy",
          present_count: 4,
          required_count: 4,
        },
        workflow_bindings: {
          status: "healthy",
          present_count: 3,
          required_count: 3,
        },
        integration_plugins: {
          status: "healthy",
          healthy_count: 1,
          pending_credentials_count: 0,
          required_count: 1,
          items: [
            {
              plugin_key: "default-shipment-webhook-intake",
              plugin_name: "Default Shipment Webhook Intake",
              activation_mode: "auto_activate",
              status: "healthy",
              effective_version_status: "active",
              binding_count: 1,
            },
          ],
        },
        blocking_findings: [],
      }),
    });

    const result = await OnboardingReadinessPage({
      appKey: "console",
      appBasePath: "/console",
      baseHref: "/console/onboarding/readiness",
      testIdPrefix: "console-onboarding-readiness",
      searchParams: {},
    });

    render(result as React.ReactElement);

    expect(screen.getByText("Onboarding readiness")).toBeInTheDocument();
    expect(screen.getByTestId("console-onboarding-readiness-ready")).toBeInTheDocument();
    expect(screen.getByText("Default Shipment Webhook Intake")).toBeInTheDocument();
    expect(screen.getByText("1/1 ready")).toBeInTheDocument();
    expect(
      screen.getByTestId("console-onboarding-readiness-read-at")
    ).toHaveTextContent("2026-04-17T10:11:12.000Z");
    expect(
      screen.getByText(
        "All required onboarding defaults for this scope are currently ready."
      )
    ).toBeInTheDocument();
  });

  it("shows capability guidance when read access is missing", async () => {
    const onboardingReadiness = jest.fn();

    mockedCreateUiServerClient.mockReturnValue({
      me: jest.fn().mockResolvedValue({
        capabilities: [],
        access_scope: {
          scope_type: "tenant",
          scope_id: "tenant-1",
        },
      }),
      onboardingReadiness,
    });

    const result = await OnboardingReadinessPage({
      appKey: "portal",
      appBasePath: "/portal",
      baseHref: "/portal/onboarding/readiness",
      testIdPrefix: "portal-onboarding-readiness",
      searchParams: {},
    });

    render(result as React.ReactElement);

    expect(screen.getByTestId("portal-onboarding-readiness-blocked")).toBeInTheDocument();
    expect(
      screen.getByText(
        "This surface requires at least one of `settings.read`, `workflow_runs.read`, or `integration_plugins.read`."
      )
    ).toBeInTheDocument();
    expect(onboardingReadiness).not.toHaveBeenCalled();
  });

  it("renders a client-safe subset for portal readiness", async () => {
    mockedCreateUiServerClient.mockReturnValue({
      me: jest.fn().mockResolvedValue({
        capabilities: [
          "settings.read",
          "workflow_runs.read",
          "integration_plugins.read",
        ],
        access_scope: {
          scope_type: "client",
          scope_id: "client-1",
        },
      }),
      onboardingReadiness: jest.fn().mockResolvedValue({
        scope_type: "client",
        scope_id: "client-1",
        generated_at: "2026-04-17T10:11:12.000Z",
        overall_status: "blocked",
        healthy: false,
        settings_defaults: {
          status: "healthy",
          present_count: 4,
          required_count: 4,
        },
        workflow_bindings: {
          status: "healthy",
          present_count: 3,
          required_count: 3,
        },
        integration_plugins: {
          status: "pending_credentials",
          healthy_count: 1,
          pending_credentials_count: 1,
          required_count: 2,
          items: [
            {
              plugin_key: "provider-credentials-handoff",
              plugin_name: "Provider Credentials Handoff",
              activation_mode: "auto_install_pending_credentials",
              status: "pending_credentials",
              effective_version_status: "installed",
              binding_count: 1,
              pending_task_exists: true,
            },
          ],
        },
        blocking_findings: [
          {
            code: "pending_credentials",
            component: "integration_plugins",
            message: "Provider credentials still pending.",
          },
        ],
      }),
    });

    const result = await OnboardingReadinessPage({
      appKey: "portal",
      appBasePath: "/portal",
      baseHref: "/portal/onboarding/readiness",
      testIdPrefix: "portal-onboarding-readiness",
      visibility: "client_safe",
      searchParams: {},
    });

    render(result as React.ReactElement);

    expect(screen.getByTestId("portal-onboarding-readiness-ready")).toBeInTheDocument();
    expect(
      screen.getByTestId("portal-onboarding-readiness-findings-summary")
    ).toBeInTheDocument();
    expect(
      screen.getByTestId("portal-onboarding-readiness-plugins-summary")
    ).toBeInTheDocument();
    expect(
      screen.queryByTestId("portal-onboarding-readiness-findings")
    ).not.toBeInTheDocument();
    expect(
      screen.queryByTestId("portal-onboarding-readiness-plugins-table")
    ).not.toBeInTheDocument();
    expect(screen.queryByText("Provider Credentials Handoff")).not.toBeInTheDocument();
    expect(
      screen.getByTestId("portal-onboarding-readiness-read-at")
    ).toHaveTextContent("2026-04-17T10:11:12.000Z");
  });
});
