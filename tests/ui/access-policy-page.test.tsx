import type React from "react";
import { render, screen } from "@testing-library/react";
import { AccessPolicyPage } from "../../packages/ui/src/access-policy-page";
import { createUiServerClient } from "@masarx/api/server";

jest.mock("../../packages/ui/src/i18n", () => ({
  createUiTranslator:
    (_namespace: string) =>
    (key: string, values?: Record<string, unknown>) => {
      if (key === "request.requiresCapability") {
        return `Requires ${String(values?.capability ?? "")} capability.`;
      }
      if (key === "request.label") return "Request change";
      if (key === "title") return `${String(values?.appLabel ?? "")} access policy`;
      if (key === "description") return "Capability rules resolved for the current scope.";
      if (key === "summary.scope") return "Scope";
      if (key === "summary.settingsResolution") return "Settings resolution";
      if (key === "denies.scope") {
        return `${String(values?.scopeType ?? "")}: ${String(values?.scopeId ?? "")}`;
      }
      if (key === "denied.description") {
        return "You do not have permission to view the access policy for this scope.";
      }
      if (key === "errors.load") return "Unable to load access policy.";
      if (key === "errors.unavailable") return "Access policy unavailable.";
      if (key === "errors.missingPayload") return "Access policy payload is missing.";
      if (key === "unknown") return "unknown";
      return key;
    },
}));

jest.mock("@masarx/api/server", () => ({
  createUiServerClient: jest.fn(),
}));

const mockedCreateUiServerClient = createUiServerClient as jest.Mock;

const basePolicy = {
  policy: {
    capabilities: [{ key: "access_policy.request", label: "Access policy request" }],
    roles: [],
    assignments: {},
    denies: [
      {
        capability_key: "shipments.delete",
        scope_type: "client",
        scope_id: "11111111-2222-4333-8444-555555555555",
        scope_label: "Example Client",
        reason: "Restricted account",
      },
    ],
  },
  settings_resolution_id: "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee",
  scope_type: "tenant",
  scope_id: "99999999-aaaa-4bbb-8ccc-dddddddddddd",
};

describe("AccessPolicyPage", () => {
  beforeEach(() => {
    jest.resetAllMocks();
  });

  it("renders request link when capability is available", async () => {
    mockedCreateUiServerClient.mockReturnValue({
      accessPolicy: jest.fn().mockResolvedValue(basePolicy),
      me: jest.fn().mockResolvedValue({
        capabilities: ["access_policy.request"],
        access_scope: {
          scope_type: "tenant",
          scope_id: "99999999-aaaa-4bbb-8ccc-dddddddddddd",
          scope_label: "Example Tenant",
        },
      }),
    });

    const result = await AccessPolicyPage({
      appLabel: "Console",
      testIdPrefix: "console-access-policy",
      requestHref: "/console/access-policy/request",
      requestLabel: "Edit roles & capabilities",
      requestCapability: "access_policy.request",
    });

    render(result as React.ReactElement);

    const link = screen.getByRole("link", { name: "Edit roles & capabilities" });
    expect(link).toHaveAttribute("href", "/console/access-policy/request");
  });

  it("renders friendly scope and deny labels while keeping raw ids secondary", async () => {
    mockedCreateUiServerClient.mockReturnValue({
      accessPolicy: jest.fn().mockResolvedValue(basePolicy),
      me: jest.fn().mockResolvedValue({
        capabilities: ["access_policy.request"],
        access_scope: {
          scope_type: "tenant",
          scope_id: "99999999-aaaa-4bbb-8ccc-dddddddddddd",
          scope_label: "Example Tenant",
        },
      }),
    });

    const result = await AccessPolicyPage({
      appLabel: "Console",
      testIdPrefix: "console-access-policy",
    });

    render(result as React.ReactElement);

    expect(screen.getByTestId("console-access-policy-summary-scope")).toHaveTextContent(
      "Tenant: Example Tenant",
    );
    expect(
      screen.getByTestId("console-access-policy-summary-scope"),
    ).not.toHaveTextContent("99999999-aaaa-4bbb-8ccc-dddddddddddd");
    expect(
      screen.getByTestId("console-access-policy-summary-scope-reference"),
    ).toHaveTextContent("REF-9999DDDD");
    expect(
      screen.getByTestId("console-access-policy-summary-settings-resolution"),
    ).toHaveTextContent("REF-AAAAEEEE");
    expect(screen.getByTestId("console-access-policy-deny-0-scope")).toHaveTextContent(
      "Client: Example Client",
    );
    expect(screen.getByTestId("console-access-policy-deny-0-scope")).not.toHaveTextContent(
      "11111111-2222-4333-8444-555555555555",
    );
    expect(
      screen.getByTestId("console-access-policy-deny-0-scope-reference"),
    ).toHaveTextContent("REF-11115555");
  });

  it("renders disabled request button when capability is missing", async () => {
    mockedCreateUiServerClient.mockReturnValue({
      accessPolicy: jest.fn().mockResolvedValue(basePolicy),
      me: jest.fn().mockResolvedValue({ capabilities: [] }),
    });

    const result = await AccessPolicyPage({
      appLabel: "Console",
      testIdPrefix: "console-access-policy",
      requestHref: "/console/access-policy/request",
      requestLabel: "Edit roles & capabilities",
      requestCapability: "access_policy.request",
    });

    render(result as React.ReactElement);

    const button = screen.getByRole("button", { name: "Edit roles & capabilities" });
    expect(button).toBeDisabled();
    expect(button).toHaveAttribute(
      "title",
      "Requires access_policy.request capability."
    );
  });

  it("normalizes capability denied detail for blocked state", async () => {
    mockedCreateUiServerClient.mockReturnValue({
      accessPolicy: jest
        .fn()
        .mockRejectedValue(new Error("Capability denied: access_policy.request")),
      me: jest.fn().mockResolvedValue({ capabilities: [] }),
    });

    const result = await AccessPolicyPage({
      appLabel: "Console",
      testIdPrefix: "console-access-policy",
    });

    render(result as React.ReactElement);

    expect(
      screen.getByText("Requires access_policy.request capability.")
    ).toBeInTheDocument();
  });
});
