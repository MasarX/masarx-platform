import type React from "react";
import { render, screen } from "@testing-library/react";
import { AccessPolicyRequestPage } from "../../packages/ui/src/access-policy-request-page";
import { createUiServerClient } from "@masarx/api/server";

jest.mock("server-only", () => ({}));

let capturedAccessPolicyRequestFormProps: Record<string, unknown> | null = null;
let capturedAccessPolicyRequestAction:
  | ((prevState: unknown, formData: FormData) => Promise<unknown>)
  | null = null;

jest.mock("next/link", () => ({
  __esModule: true,
  default: ({
    children,
    href,
    ...props
  }: React.PropsWithChildren<{ href: string }>) => (
    <a href={href} {...props}>
      {children}
    </a>
  ),
}));

jest.mock("../../packages/ui/src/i18n", () => ({
  createUiTranslator:
    (_namespace: string) =>
    (key: string, values?: Record<string, unknown>) => {
      if (key === "title") return `${String(values?.appLabel ?? "")} access policy request`;
      if (key === "description") {
        return "Submit access policy changes through the workflow approval queue.";
      }
      if (key === "actions.backToPolicy") return "Back to access policy";
      if (key === "summary.title") return "Current scope";
      if (key === "summary.scopeLabel") return "Scope";
      if (key === "summary.settingsResolutionLabel") return "Settings resolution";
      if (key === "summary.currentPolicy") return "Current policy";
      if (key === "summary.requestTitle") return "Request changes";
      if (key === "labels.unknown") return "Unknown";
      if (key === "errors.loadPolicy") return "Unable to load access policy.";
      if (key === "errors.missingPolicy") return "Access policy payload is missing.";
      if (key === "blocked.title") return "Access policy request blocked";
      if (key === "blocked.action") return "Request access, then retry.";
      if (key === "errors.unavailableTitle") return "Access policy request unavailable";
      if (key === "errors.unavailableAction") return "Reload and retry.";
      return key;
    },
}));

jest.mock("../../packages/ui/src/access-policy-request-form", () => ({
  AccessPolicyRequestForm: (props: Record<string, unknown>) => {
    capturedAccessPolicyRequestFormProps = props;
    capturedAccessPolicyRequestAction = props.action as (
      prevState: unknown,
      formData: FormData,
    ) => Promise<unknown>;
    return <div data-testid={`${String(props.testIdPrefix ?? "access-policy-request")}-mock-form`} />;
  },
}));

jest.mock("@masarx/api/server", () => ({
  createUiServerClient: jest.fn(),
}));

const mockedCreateUiServerClient = createUiServerClient as jest.Mock;

const scopeId = "550e8400-e29b-41d4-a716-446655440000";
const settingsResolutionId = "660e8400-e29b-41d4-a716-446655440222";
const basePolicy = {
  policy: {
    capabilities: [{ key: "access_policy.request", label: "Access policy request" }],
    roles: [],
    assignments: {},
  },
  settings_resolution_id: settingsResolutionId,
  scope_type: "tenant",
  scope_id: scopeId,
  scope_label: "Sample Organization",
};

describe("AccessPolicyRequestPage", () => {
  beforeEach(() => {
    jest.resetAllMocks();
    capturedAccessPolicyRequestFormProps = null;
    capturedAccessPolicyRequestAction = null;
  });

  it("shows a friendly scope label as the primary visible summary and keeps the reference secondary", async () => {
    mockedCreateUiServerClient.mockReturnValue({
      me: jest.fn().mockResolvedValue({
        access_scope: {
          scope_type: "tenant",
          scope_id: scopeId,
          scope_label: "Sample Organization",
        },
      }),
      accessPolicy: jest.fn().mockResolvedValue(basePolicy),
      requestAccessPolicyChange: jest.fn(),
    });

    const result = await AccessPolicyRequestPage({
      appLabel: "Portal",
      testIdPrefix: "portal-access-policy-request",
      returnHref: "/portal/access-policy",
    });

    render(result as React.ReactElement);

    expect(screen.getByTestId("portal-access-policy-request-summary-scope")).toHaveTextContent(
      "Tenant: Sample Organization"
    );
    expect(
      screen.getByTestId("portal-access-policy-request-summary-scope")
    ).not.toHaveTextContent(scopeId);
    expect(
      screen.getByTestId("portal-access-policy-request-summary-scope-reference")
    ).toHaveTextContent("REF-550E0000");
    expect(
      screen.getByTestId("portal-access-policy-request-summary-settings-resolution")
    ).toHaveTextContent("REF-660E0222");
    expect(
      screen.getByTestId("portal-access-policy-request-summary-settings-resolution")
    ).not.toHaveTextContent(settingsResolutionId);
    expect(capturedAccessPolicyRequestFormProps).toEqual(
      expect.objectContaining({
        defaultScopeType: "tenant",
        defaultScopeId: scopeId,
        defaultScopeLabel: "Sample Organization",
      })
    );
  });

  it("prefers the canonical policy scope label when me access scope omits the friendly label", async () => {
    mockedCreateUiServerClient.mockReturnValue({
      me: jest.fn().mockResolvedValue({
        access_scope: {
          scope_type: "tenant",
          scope_id: scopeId,
          scope_label: null,
        },
      }),
      accessPolicy: jest.fn().mockResolvedValue(basePolicy),
      requestAccessPolicyChange: jest.fn(),
    });

    const result = await AccessPolicyRequestPage({
      appLabel: "Portal",
      testIdPrefix: "portal-access-policy-request",
      returnHref: "/portal/access-policy",
    });

    render(result as React.ReactElement);

    expect(screen.getByTestId("portal-access-policy-request-summary-scope")).toHaveTextContent(
      "Tenant: Sample Organization"
    );
    expect(
      screen.getByTestId("portal-access-policy-request-summary-scope-reference")
    ).toHaveTextContent("REF-550E0000");
    expect(capturedAccessPolicyRequestFormProps).toEqual(
      expect.objectContaining({
        defaultScopeType: "tenant",
        defaultScopeId: scopeId,
        defaultScopeLabel: "Sample Organization",
      })
    );
  });

  it("falls back to a readable scope reference when no friendly label exists", async () => {
    mockedCreateUiServerClient.mockReturnValue({
      me: jest.fn().mockResolvedValue({
        access_scope: {
          scope_type: "tenant",
          scope_id: scopeId,
          scope_label: null,
        },
      }),
      accessPolicy: jest.fn().mockResolvedValue({
        ...basePolicy,
        scope_label: null,
      }),
      requestAccessPolicyChange: jest.fn(),
    });

    const result = await AccessPolicyRequestPage({
      appLabel: "Portal",
      testIdPrefix: "portal-access-policy-request",
      returnHref: "/portal/access-policy",
    });

    render(result as React.ReactElement);

    expect(screen.getByTestId("portal-access-policy-request-summary-scope")).toHaveTextContent(
      "Tenant: REF-550E0000"
    );
    expect(
      screen.getByTestId("portal-access-policy-request-summary-scope")
    ).not.toHaveTextContent(scopeId);
    expect(
      screen.queryByTestId("portal-access-policy-request-summary-scope-reference")
    ).not.toBeInTheDocument();
    expect(capturedAccessPolicyRequestFormProps).toEqual(
      expect.objectContaining({
        defaultScopeType: "tenant",
        defaultScopeId: scopeId,
        defaultScopeLabel: null,
      })
    );
  });

  it("rejects tampered hidden scope ids before submitting the access policy request", async () => {
    const requestAccessPolicyChange = jest.fn();
    mockedCreateUiServerClient.mockReturnValue({
      me: jest.fn().mockResolvedValue({
        access_scope: {
          scope_type: "tenant",
          scope_id: scopeId,
          scope_label: "Sample Organization",
        },
      }),
      accessPolicy: jest.fn().mockResolvedValue(basePolicy),
      requestAccessPolicyChange,
    });

    const result = await AccessPolicyRequestPage({
      appLabel: "Portal",
      testIdPrefix: "portal-access-policy-request",
      returnHref: "/portal/access-policy",
    });

    render(result as React.ReactElement);

    const formData = new FormData();
    formData.set("scope_type", "tenant");
    formData.set("scope_id", "550e8400-e29b-41d4-a716-446655449999");
    formData.set(
      "policy_json",
      JSON.stringify({
        capabilities: [{ key: "shipments.read", label: "Shipments read" }],
        roles: [],
        assignments: {},
      }),
    );
    formData.set("change_reason", "scope tamper test");
    formData.set("effective_from", "");

    const submitResult = (await capturedAccessPolicyRequestAction?.(
      { status: "idle" },
      formData,
    )) as { status: string; message?: string };

    expect(submitResult.status).toBe("error");
    expect(submitResult.message).toBe("errors.scopeIdInvalid");
    expect(requestAccessPolicyChange).not.toHaveBeenCalled();
  });

  it("keeps scope selection available to the global request form", async () => {
    mockedCreateUiServerClient.mockReturnValue({
      me: jest.fn().mockResolvedValue({ access_scope: { scope_type: "platform" } }),
      accessPolicy: jest.fn().mockResolvedValue({ ...basePolicy, scope_type: "global", scope_id: null, scope_label: null }),
    });

    render(await AccessPolicyRequestPage({ appLabel: "Console", testIdPrefix: "access-policy-request" }));

    expect(capturedAccessPolicyRequestFormProps).toEqual(expect.objectContaining({ lockScope: false }));
  });
});
