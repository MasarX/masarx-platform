import type React from "react";
import { render, screen } from "@testing-library/react";
import { SettingsRequestPage } from "../../packages/ui/src/settings-request-page";
import { createUiServerClient } from "@masarx/api/server";

let capturedSettingsRequestAction:
  | ((prevState: unknown, formData: FormData) => Promise<unknown>)
  | null = null;

jest.mock("../../packages/ui/src/i18n", () => ({
  createUiTranslator:
    (_namespace: string) =>
    (key: string, values?: Record<string, unknown>) => {
      if (key === "title") return `${String(values?.appLabel ?? "")} settings request`;
      if (key === "description") {
        return "Submit settings changes through the workflow approval queue.";
      }
      if (key === "actions.backToCategories") return "Back to settings categories";
      if (key === "blocked.title") {
        return "Settings requests are not available for your role.";
      }
      if (key === "blocked.action") {
        return "Request access from your organization admin, then refresh.";
      }
      if (key === "errors.loadCategories") return "Unable to load settings categories.";
      if (key === "errors.noCategories") {
        return "No settings categories are registered yet.";
      }
      if (key === "errors.previewFailed") return "Unable to load settings preview.";
      if (key === "errors.noScopesConfigured") {
        return "No allowed scopes are configured for this category.";
      }
      if (key === "errors.unavailableTitle") return "Settings requests are unavailable.";
      if (key === "errors.unavailableAction") {
        return "Confirm settings registry access, then refresh or sign in again.";
      }
      if (key === "errors.categoryRequired") return "Category is required.";
      if (key === "errors.scopeTypeRequired") return "Scope type is required.";
      if (key === "errors.settingsRequired") return "Settings JSON is required.";
      if (key === "errors.scopeIdInvalid") return "Scope id must be a valid UUID.";
      if (key === "errors.settingsInvalid") return "Settings JSON must be valid JSON.";
      if (key === "errors.settingsNull") return "Settings JSON must not be null.";
      if (key === "errors.effectiveInvalid") {
        return "Effective from must be a valid date.";
      }
      if (key === "errors.submitFailed") return "Unable to submit settings request.";
      if (key === "errors.settingsRequestRpcUnavailable") {
        return "Settings request service is syncing. Retry in a few seconds.";
      }
      return key;
    },
}));

jest.mock("../../packages/ui/src/settings-request-form", () => ({
  SettingsRequestForm: (props: {
    action: (prevState: unknown, formData: FormData) => Promise<unknown>;
  }) => {
    capturedSettingsRequestAction = props.action;
    return null;
  },
}));

jest.mock("@masarx/api/server", () => ({
  createUiServerClient: jest.fn(),
}));

const mockedCreateUiServerClient = createUiServerClient as jest.Mock;

describe("SettingsRequestPage", () => {
  beforeEach(() => {
    jest.resetAllMocks();
    capturedSettingsRequestAction = null;
  });

  it("normalizes denied capability message from registry load error", async () => {
    mockedCreateUiServerClient.mockReturnValue({
      me: jest.fn().mockResolvedValue({ capabilities: [] }),
      listResource: jest
        .fn()
        .mockRejectedValue(
          new Error("Missing required capability: settings.request.write")
        ),
      settingsPreview: jest.fn(),
      requestSettingsChange: jest.fn(),
    });

    const result = await SettingsRequestPage({
      appLabel: "Portal",
      testIdPrefix: "portal-settings-request",
      searchParams: {},
      requestHref: "/portal/settings/request",
    });

    render(result as React.ReactElement);

    expect(
      screen.getByText("Capability denied: settings.request.write")
    ).toBeInTheDocument();
  });

  it("blocks request when category capability is missing", async () => {
    mockedCreateUiServerClient.mockReturnValue({
      me: jest.fn().mockResolvedValue({ capabilities: [] }),
      listResource: jest.fn().mockResolvedValue({
        items: [
          {
            category: "shipment_filters",
            request_capability: "settings.request.write",
            allowed_scopes: ["client"],
          },
        ],
        total: 1,
      }),
      settingsPreview: jest.fn(),
      requestSettingsChange: jest.fn(),
    });

    const result = await SettingsRequestPage({
      appLabel: "Portal",
      testIdPrefix: "portal-settings-request",
      searchParams: {},
      requestHref: "/portal/settings/request",
    });

    render(result as React.ReactElement);

    expect(
      screen.getByText("Capability denied: settings.request.write")
    ).toBeInTheDocument();
  });

  it("returns guidance message when settings request RPC is missing in schema cache", async () => {
    mockedCreateUiServerClient.mockReturnValue({
      me: jest.fn().mockResolvedValue({ capabilities: [] }),
      listResource: jest.fn().mockResolvedValue({
        items: [
          {
            category: "ui_table_views",
            request_capability: null,
            allowed_scopes: ["global"],
          },
        ],
        total: 1,
      }),
      settingsPreview: jest.fn(),
      requestSettingsChange: jest.fn().mockRejectedValue({
        code: "PGRST202",
        message:
          "Could not find the function api.request_settings_change_v1(p_category, p_scope_type, p_scope_id, p_value) in the schema cache",
      }),
    });

    const result = await SettingsRequestPage({
      appLabel: "Portal",
      testIdPrefix: "portal-settings-request",
      searchParams: {},
      requestHref: "/portal/settings/request",
    });

    render(result as React.ReactElement);
    expect(capturedSettingsRequestAction).not.toBeNull();

    const formData = new FormData();
    formData.set("category", "ui_table_views");
    formData.set("scope_type", "global");
    formData.set("scope_id", "");
    formData.set("settings_json", "{\"resources\":{}}");
    formData.set("change_reason", "test");
    formData.set("effective_from", "");

    const submitResult = (await capturedSettingsRequestAction?.(
      { status: "idle" },
      formData
    )) as { status: string; message?: string };

    expect(submitResult.status).toBe("error");
    expect(submitResult.message).toBe(
      "Settings request service is syncing. Retry in a few seconds."
    );
  });
});
