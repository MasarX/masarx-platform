import type React from "react";
import { render, screen, within } from "@testing-library/react";
import type { UiOnboardingReadinessLabelDesign } from "@masarx/api";
import { createUiTranslator } from "../../packages/ui/src/i18n";
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
    expect(screen.queryByTestId("console-onboarding-readiness-label-design")).not.toBeInTheDocument();
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

  async function renderLabelReadiness(labelDesign: UiOnboardingReadinessLabelDesign, clientSafe = false) {
    const onboardingReadiness = jest.fn().mockResolvedValue({
      scope_type: "tenant", scope_id: "tenant-1", generated_at: "2026-09-06T00:00:00Z",
      overall_status: "blocked", healthy: false, label_design: labelDesign,
      blocking_findings: clientSafe ? [{
        severity: "blocking", component: "label_design",
        code: "label_diagnostic_sentinel", message: "PRIVATE_LABEL_PROVIDER_ERROR_SENTINEL",
      }] : [],
    });
    mockedCreateUiServerClient.mockReturnValue({
      me: jest.fn().mockResolvedValue({
        capabilities: ["settings.read"],
        access_scope: { scope_type: "tenant", scope_id: "tenant-1" },
      }),
      onboardingReadiness,
    });
    const node = await OnboardingReadinessPage({
      appKey: clientSafe ? "portal" : "console", appBasePath: "",
      baseHref: "/onboarding/readiness", testIdPrefix: "label-readiness",
      visibility: clientSafe ? "client_safe" : "full",
    });
    render(node as React.ReactElement);
    expect(onboardingReadiness).toHaveBeenCalledWith("tenant", "tenant-1");
    return screen.getByTestId("label-readiness-label-design");
  }

  it.each([
    ["ready", "Ready", "ui-success"],
    ["healthy", "Healthy", "ui-success"],
    ["warning", "Warning", "ui-warning"],
    ["blocked", "Blocked", "ui-danger"],
    ["not_applicable", "Not applicable", "bg-ui-surface"],
    ["future_status", "Unknown", "bg-ui-surface"],
  ])("renders backend label status %s without rewriting overall readiness", async (status, text, tone) => {
    const card = await renderLabelReadiness({
      status, healthy: status === "ready", present_count: 2, required_count: 3,
      blocking_count: 1, warning_count: 4,
    });
    expect(within(card).getByText("Label design")).toBeInTheDocument();
    expect(within(card).getByText("2/3 settings present")).toBeInTheDocument();
    expect(within(card).getByText("Blocking: 1")).toBeInTheDocument();
    expect(within(card).getByText("Warnings: 4")).toBeInTheDocument();
    const badge = screen.getByTestId("label-readiness-label-design-status");
    expect(badge).toHaveTextContent(text);
    expect(badge.className).toContain(tone);
    expect(screen.getByTestId("label-readiness-overall")).toHaveTextContent("blocked");
  });

  it.each([
    [{ present_count: 0, healthy_count: 3, required_count: 3 }, "0/3 settings present"],
    [{ healthy_count: 2, required_count: 3 }, "2/3 settings present"],
    [{ healthy_count: 2 }, "2/2 settings present"],
    [{ present_count: 0, required_count: 0 }, "0/0 settings present"],
  ])("preserves backend count precedence for %j", async (counts, expected) => {
    const card = await renderLabelReadiness({ status: "ready", ...counts });
    expect(within(card).getByText(expected)).toBeInTheDocument();
  });

  it("does not call present but unhealthy settings ready", async () => {
    const card = await renderLabelReadiness({
      status: "blocked", healthy: false, present_count: 3, healthy_count: 2,
      required_count: 3, blocking_count: 1, warning_count: 0,
    });
    expect(within(card).getByText("3/3 settings present")).toBeInTheDocument();
    expect(screen.getByTestId("label-readiness-label-design-status")).toHaveTextContent("Blocked");
    expect(within(card).getByText("Blocking: 1")).toBeInTheDocument();
    expect(card).not.toHaveTextContent("3/3 ready");
  });

  it("keeps Portal label readiness aggregate-only even when raw details arrive", async () => {
    const labelDesign = {
      status: "warning", required_count: 3, present_count: 3, warning_count: 1,
      renderer_provider: { endpoint: "PRIVATE_PROVIDER_ENDPOINT_SENTINEL" },
      renderer_provider_status: "PRIVATE_PROVIDER_STATUS_SENTINEL",
      items: [{ settings_version_id: "PRIVATE_SETTINGS_ID_SENTINEL", payload: "PRIVATE_LAYOUT_SENTINEL" }],
    };
    const card = await renderLabelReadiness(labelDesign, true);
    expect(within(card).getByText("3/3 settings present")).toBeInTheDocument();
    expect(within(card).getByText("Warnings: 1")).toBeInTheDocument();
    expect(screen.getByTestId("label-readiness-findings-summary")).toBeInTheDocument();
    expect(screen.queryByTestId("label-readiness-findings")).not.toBeInTheDocument();
    expect(document.body.textContent).not.toMatch(/PRIVATE_|label_diagnostic_sentinel/);
  });

  it("provides localized label summary messages in Arabic", () => {
    const t = createUiTranslator("ui.onboardingReadiness.labelDesign", { locale: "ar" });
    expect(t("title")).toBe("تصميم الملصقات");
    expect(t("readyCount", { current: 2, total: 3 })).toBe("الإعدادات الموجودة: 2/3");
    expect(t("status.warning")).toBe("تحذير");
    expect(t("blockingCount", { count: 1 })).toBe("العوائق: 1");
    expect(t("warningCount", { count: 2 })).toBe("التحذيرات: 2");
  });
});
