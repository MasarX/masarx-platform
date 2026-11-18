import type React from "react";
import { render, screen } from "@testing-library/react";
import { SettingsRequestPage } from "../../packages/ui/src/settings-request-page";
import { createUiServerClient } from "@masarx/api/server";

let capturedSettingsRequestAction:
  | ((prevState: unknown, formData: FormData) => Promise<unknown>)
  | null = null;
let capturedSettingsRequestProps: Record<string, unknown> | null = null;

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
    capturedSettingsRequestProps = { ...props };
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


describe("label provider request boundary", () => {
  beforeEach(() => { jest.resetAllMocks(); capturedSettingsRequestAction = null; capturedSettingsRequestProps = null; });
  const tenant = "4d1fbd36-6b6e-4c35-acc4-5e3ad9043830";
  function client() {
    return {
      me: jest.fn().mockResolvedValue({ capabilities: ["settings.request"] }),
      listResource: jest.fn().mockResolvedValue({ items: [{ category: "label_provider", request_capability: "settings.request", allowed_scopes: ["tenant"] }], total: 1 }),
      labelRendererReadiness: jest.fn().mockResolvedValue({ configured: false }),
      settingsPreview: jest.fn().mockResolvedValue({ value: { version: 2, custom: { retained: true }, providers: [{ name: "existing", timeout_ms: 12345, invoke_secret: "old-sentinel", custom: 7 }, { name: "sibling", invoke_secret: "sibling-sentinel" }] } }),
      requestSettingsChange: jest.fn().mockResolvedValue({ settings_version_id: "pending-version", domain_event_id: "event" }),
    };
  }
  async function page() {
    render(await SettingsRequestPage({ appLabel: "Console", testIdPrefix: "provider", searchParams: { category: "label_provider", scope_type: "tenant", scope_id: tenant }, requestHref: "/settings/request" }) as React.ReactElement);
    expect(capturedSettingsRequestAction).not.toBeNull();
  }
  function payload() {
    const data = new FormData();
    data.set("category", "label_provider"); data.set("scope_type", "tenant"); data.set("scope_id", tenant);
    data.set("invoke_url", "https://renderer.example.test/functions/v1/label-renderer");
    data.set("invoke_secret", "new-sentinel");
    return data;
  }
  it("does not fetch provider secrets during page rendering", async () => {
    const ui = client(); mockedCreateUiServerClient.mockReturnValue(ui);
    await page();
    expect(ui.settingsPreview).not.toHaveBeenCalled();
    expect(ui.labelRendererReadiness).toHaveBeenCalledWith(tenant);
  });
  it("preserves complete provider configuration and submits approval rather than activation", async () => {
    const ui = client(); mockedCreateUiServerClient.mockReturnValue(ui);
    await page();
    const result = await capturedSettingsRequestAction!({}, payload());
    expect(result).toEqual({ status: "success", settingsVersionId: "pending-version", domainEventId: "event" });
    expect(ui.requestSettingsChange).toHaveBeenCalledWith(expect.objectContaining({ category: "label_provider", scopeType: "tenant", scopeId: tenant, value: {
      version: 2, custom: { retained: true }, providers: [
        { name: "existing", timeout_ms: 12345, invoke_secret: "new-sentinel", invoke_url: "https://renderer.example.test/functions/v1/label-renderer", custom: 7 },
        { name: "sibling", invoke_secret: "sibling-sentinel" },
      ],
    } }));
  });
  it.each([null, {}, { providers: [] }, { providers: ["invalid"] }])("rejects missing or malformed baseline without a lossy request [%#]: %p", async (value) => {
    const ui = client(); ui.settingsPreview.mockResolvedValue({ value } as never);
    mockedCreateUiServerClient.mockReturnValue(ui); await page();
    expect(await capturedSettingsRequestAction!({}, payload())).toEqual({ status: "error", message: "Unable to submit settings request." });
    expect(ui.requestSettingsChange).not.toHaveBeenCalled();
  });
  it("never returns secret-bearing errors", async () => {
    const ui = client(); ui.requestSettingsChange.mockRejectedValue(new Error("private-error-sentinel"));
    mockedCreateUiServerClient.mockReturnValue(ui); await page();
    expect(await capturedSettingsRequestAction!({}, payload())).toEqual({ status: "error", message: "Unable to submit settings request." });
  });
  it.each(['settingsPreview', 'labelRendererReadiness'] as const)("sanitizes action %s failure before requesting any change", async method => {
    const ui = client(); mockedCreateUiServerClient.mockReturnValue(ui); await page();
    ui[method].mockClear();
    ui[method].mockRejectedValue(new Error('private-baseline-resolver-sentinel'));
    const result = await capturedSettingsRequestAction!({}, payload());
    expect(ui[method]).toHaveBeenCalledTimes(1);
    expect(ui[method]).toHaveBeenCalledWith(method === 'labelRendererReadiness' ? tenant
      : { category: 'label_provider', scopeType: 'tenant', scopeId: tenant });
    expect(result).toEqual({ status: 'error', message: 'Unable to submit settings request.' });
    expect(ui.requestSettingsChange).not.toHaveBeenCalled();
    if (method === 'labelRendererReadiness') expect(ui.settingsPreview).not.toHaveBeenCalled();
    expect(JSON.stringify({ result, props: capturedSettingsRequestProps })).not.toContain('private-baseline-resolver-sentinel');
  });
  it("keeps complete client-bound props free of provider values on success", async () => {
    const ui = client(); mockedCreateUiServerClient.mockReturnValue(ui); await page();
    expect(capturedSettingsRequestProps).toEqual(expect.objectContaining({ defaultSettingsJson: '', providerConfigured: false,
      previewError: null, previewResolutionId: null, previewSettingsVersionId: null }));
    expect(typeof capturedSettingsRequestProps?.action).toBe('function');
    const result = await capturedSettingsRequestAction!({}, payload());
    expect(result).toEqual({ status: 'success', settingsVersionId: 'pending-version', domainEventId: 'event' });
    const serializableBoundary = JSON.stringify({ props: capturedSettingsRequestProps, result });
    for (const secret of ['old-sentinel', 'sibling-sentinel', 'new-sentinel']) expect(serializableBoundary).not.toContain(secret);
  });
  it("sanitizes render-time readiness failure in the complete client-bound props", async () => {
    const ui = client(); ui.labelRendererReadiness.mockRejectedValue(new Error('private-render-resolver-sentinel'));
    mockedCreateUiServerClient.mockReturnValue(ui); await page();
    expect(ui.labelRendererReadiness).toHaveBeenCalledWith(tenant);
    expect(ui.settingsPreview).not.toHaveBeenCalled();
    expect(capturedSettingsRequestProps).toEqual(expect.objectContaining({ defaultSettingsJson: '', providerConfigured: null,
      previewError: 'Unable to load settings preview.' }));
    expect(JSON.stringify(capturedSettingsRequestProps)).not.toContain('private-render-resolver-sentinel');
  });
  it("rejects forged foreign scope before reading baseline or requesting changes", async () => {
    const ui = client(); mockedCreateUiServerClient.mockReturnValue(ui); await page();
    ui.labelRendererReadiness.mockRejectedValue(new Error("foreign-scope-private-sentinel"));
    const data = payload(); data.set("scope_id", "22222222-2222-4222-8222-222222222222");
    expect(await capturedSettingsRequestAction!({}, data)).toEqual({ status: "error", message: "Unable to submit settings request." });
    expect(ui.settingsPreview).not.toHaveBeenCalled();
    expect(ui.requestSettingsChange).not.toHaveBeenCalled();
  });
  it.each(["invoke_url", "invoke_secret"])("preserves omitted provider field for %s-only update", async (field) => {
    const ui = client(); mockedCreateUiServerClient.mockReturnValue(ui); await page();
    const data = payload(); data.delete(field === "invoke_url" ? "invoke_secret" : "invoke_url");
    await capturedSettingsRequestAction!({}, data);
    const submitted = ui.requestSettingsChange.mock.calls[0][0].value;
    const baseline = (await ui.settingsPreview.mock.results[0].value).value;
    expect(submitted).toEqual({
      ...baseline,
      providers: [{ ...baseline.providers[0], [field]: data.get(field) }, ...baseline.providers.slice(1)],
    });
  });
  it("rejects blank changes before baseline read or request", async () => {
    const ui = client(); mockedCreateUiServerClient.mockReturnValue(ui); await page();
    const data = payload(); data.delete("invoke_url"); data.delete("invoke_secret");
    expect(await capturedSettingsRequestAction!({}, data)).toEqual({ status: "error", message: "Unable to submit settings request." });
    expect(ui.settingsPreview).not.toHaveBeenCalled(); expect(ui.requestSettingsChange).not.toHaveBeenCalled();
  });

});
