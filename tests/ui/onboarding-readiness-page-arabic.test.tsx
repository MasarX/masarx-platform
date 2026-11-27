import type React from "react";
import { render, screen, within } from "@testing-library/react";
import { unwrapMessagesImport } from "@masarx/config";
import { createUiServerClient } from "@masarx/api/server";
import * as arRaw from "../../packages/config/messages/ar.json";
import * as enRaw from "../../packages/config/messages/en.json";
import { OnboardingReadinessPage } from "../../packages/ui/src/onboarding-readiness-page";

jest.mock("@masarx/api/server", () => ({ createUiServerClient: jest.fn() }));
// createUiTranslator reads the locale from getPublicConfig at render time.
jest.mock("@masarx/config", () => ({
  ...jest.requireActual("@masarx/config"),
  getPublicConfig: () => ({ locale: "ar" }),
}));

type Messages = Record<string, unknown>;
type Area = {
  page: { title: string; refresh: string };
  summary: { title: string; healthy: string; readyCount: string; readRequired: string };
  findings: { title: string; empty: string };
  plugins: { title: string; columns: { plugin: string }; noTask: string };
};
const area = (raw: unknown) =>
  (unwrapMessagesImport(raw as Messages | { default: Messages }) as { ui: { onboardingReadiness: Area } }).ui
    .onboardingReadiness;
const ar = area(arRaw);
const en = area(enRaw);
const ARABIC = /[؀-ۿ]/;

function mockReadiness(capabilities: string[]) {
  (createUiServerClient as jest.Mock).mockReturnValue({
    me: jest.fn().mockResolvedValue({
      capabilities,
      access_scope: { scope_type: "tenant", scope_id: "tenant-1" },
    }),
    onboardingReadiness: jest.fn().mockResolvedValue({
      scope_type: "tenant",
      scope_id: "tenant-1",
      generated_at: "2026-04-17T10:11:12.000Z",
      overall_status: "healthy",
      healthy: true,
      settings_defaults: { status: "healthy", present_count: 4, required_count: 4 },
      workflow_bindings: { status: "healthy", present_count: 3, required_count: 3 },
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
}

async function renderPage() {
  const node = await OnboardingReadinessPage({
    appKey: "console",
    appBasePath: "/console",
    baseHref: "/console/onboarding/readiness",
    testIdPrefix: "console-onboarding-readiness",
    searchParams: {},
  });
  render(node as React.ReactElement);
}

describe("OnboardingReadinessPage in Arabic", () => {
  beforeEach(() => {
    jest.resetAllMocks();
  });

  it("renders headings, summary and plugin table from the ui.onboardingReadiness catalog", async () => {
    mockReadiness(["settings.read", "workflow_runs.read", "integration_plugins.read"]);
    await renderPage();

    expect(screen.getByText(ar.page.title)).toBeInTheDocument();
    // The Status section title and the plugin Status column share one Arabic word.
    expect(screen.getAllByText(ar.summary.title).length).toBeGreaterThanOrEqual(1);
    expect(screen.getByText(ar.summary.healthy)).toBeInTheDocument();
    expect(screen.getByText(ar.findings.title)).toBeInTheDocument();
    expect(screen.getByText(ar.findings.empty)).toBeInTheDocument();
    expect(screen.getByText(ar.plugins.title)).toBeInTheDocument();
    expect(screen.getByRole("link", { name: ar.page.refresh })).toBeInTheDocument();

    const cards = screen.getByTestId("console-onboarding-readiness-cards");
    expect(within(cards).getByText(ar.summary.readyCount.replace("{current}", "1").replace("{total}", "1")))
      .toBeInTheDocument();
    const table = screen.getByTestId("console-onboarding-readiness-plugins-table");
    expect(within(table).getByText(ar.plugins.columns.plugin)).toBeInTheDocument();
    expect(within(table).getByText(ar.plugins.noTask)).toBeInTheDocument();
  });

  it("shows the Arabic capability guidance when read access is missing", async () => {
    mockReadiness([]);
    await renderPage();
    expect(screen.getByText(ar.summary.readRequired)).toBeInTheDocument();
  });

  it("keeps the English values equal to the former literals and gives Arabic values", () => {
    expect(en.page.title).toBe("Onboarding readiness");
    expect(en.summary.readyCount).toBe("{current}/{total} ready");
    expect(en.summary.healthy).toBe("All required onboarding defaults for this scope are currently ready.");
    for (const value of [ar.page.title, ar.summary.readyCount, ar.summary.healthy]) {
      expect(value).toMatch(ARABIC);
    }
  });
});
