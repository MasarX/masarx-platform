import type React from "react";
import { render, screen } from "@testing-library/react";
import { AccessPage } from "../../packages/ui/src/access-page";
import { createUiServerClient } from "@masarx/api/server";

jest.mock("../../packages/ui/src/i18n", () => ({
  createUiTranslator:
    (_namespace: string) =>
    (key: string, values?: Record<string, unknown>) => {
      if (key === "title") return `${String(values?.appLabel ?? "")} access`;
      if (key === "description") return "Access overview";
      if (key === "sections.contextTitle") return "Context";
      if (key === "labels.user") return "User";
      if (key === "labels.role") return "Role";
      if (key === "labels.org") return "Organization";
      if (key === "labels.scope") return "Scope";
      if (key === "labels.locale") return "Locale";
      if (key === "labels.timezone") return "Timezone";
      if (key === "settingsResolution") return "Settings resolution";
      if (key === "capabilities.title") return "Capabilities";
      if (key === "capabilities.empty") return "No capabilities";
      if (key === "errors.loadContext") return "Unable to load access context.";
      if (key === "errors.unavailable") return "Access overview unavailable.";
      if (key === "unknown") return "unknown";
      if (key === "scopeLabel") {
        return `${String(values?.scopeType ?? "")}: ${String(values?.scopeLabel ?? "")}`;
      }
      return key;
    },
}));

jest.mock("@masarx/api/server", () => ({
  createUiServerClient: jest.fn(),
}));

const mockedCreateUiServerClient = createUiServerClient as jest.Mock;

describe("AccessPage", () => {
  beforeEach(() => {
    jest.resetAllMocks();
  });

  it("renders friendly primary labels and keeps readable references secondary", async () => {
    mockedCreateUiServerClient.mockReturnValue({
      me: jest.fn().mockResolvedValue({
        user: {
          id: "11111111-2222-4333-8444-555555555555",
          email: "ops@example.com",
          user_type: "ops_admin",
        },
        org: {
          id: "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee",
          name: "Example Tenant",
        },
        access_scope: {
          scope_type: "tenant",
          scope_id: "99999999-aaaa-4bbb-8ccc-dddddddddddd",
          scope_label: "Example Tenant",
        },
        locale: "en",
        timezone: "Asia/Riyadh",
        capabilities: ["access_policy.request"],
        settings_resolution_id: "12345678-aaaa-4bbb-8ccc-1234567890ab",
      }),
    });

    const result = await AccessPage({
      appLabel: "Console",
      testIdPrefix: "console-access",
    });

    render(result as React.ReactElement);

    expect(screen.getByTestId("console-access-user-primary")).toHaveTextContent(
      "ops@example.com",
    );
    expect(screen.getByTestId("console-access-user-primary")).not.toHaveTextContent(
      "11111111-2222-4333-8444-555555555555",
    );
    expect(screen.getByTestId("console-access-user-reference")).toHaveTextContent(
      "REF-11115555",
    );

    expect(screen.getByTestId("console-access-org-primary")).toHaveTextContent(
      "Example Tenant",
    );
    expect(screen.getByTestId("console-access-org-primary")).not.toHaveTextContent(
      "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee",
    );
    expect(screen.getByTestId("console-access-org-reference")).toHaveTextContent(
      "REF-AAAAEEEE",
    );

    expect(screen.getByTestId("console-access-scope-primary")).toHaveTextContent(
      "tenant: Example Tenant",
    );
    expect(screen.getByTestId("console-access-scope-primary")).not.toHaveTextContent(
      "99999999-aaaa-4bbb-8ccc-dddddddddddd",
    );
    expect(screen.getByTestId("console-access-scope-reference")).toHaveTextContent(
      "REF-9999DDDD",
    );

    expect(screen.getByTestId("console-access-settings-resolution")).toHaveTextContent(
      "REF-123490AB",
    );
    expect(screen.getByTestId("console-access-settings-resolution")).not.toHaveTextContent(
      "12345678-aaaa-4bbb-8ccc-1234567890ab",
    );
  });

  it("falls back to readable references when friendly labels are missing", async () => {
    mockedCreateUiServerClient.mockReturnValue({
      me: jest.fn().mockResolvedValue({
        user: {
          id: "11111111-2222-4333-8444-555555555555",
          email: null,
          user_type: "ops_admin",
        },
        org: {
          id: "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee",
          name: null,
        },
        access_scope: {
          scope_type: "tenant",
          scope_id: "99999999-aaaa-4bbb-8ccc-dddddddddddd",
          scope_label: null,
        },
        locale: "en",
        timezone: "Asia/Riyadh",
        capabilities: [],
        settings_resolution_id: "12345678-aaaa-4bbb-8ccc-1234567890ab",
      }),
    });

    const result = await AccessPage({
      appLabel: "Console",
      testIdPrefix: "console-access",
    });

    render(result as React.ReactElement);

    expect(screen.getByTestId("console-access-user-primary")).toHaveTextContent(
      "REF-11115555",
    );
    expect(screen.queryByTestId("console-access-user-reference")).not.toBeInTheDocument();

    expect(screen.getByTestId("console-access-org-primary")).toHaveTextContent(
      "REF-AAAAEEEE",
    );
    expect(screen.queryByTestId("console-access-org-reference")).not.toBeInTheDocument();

    expect(screen.getByTestId("console-access-scope-primary")).toHaveTextContent(
      "tenant: REF-9999DDDD",
    );
    expect(screen.queryByTestId("console-access-scope-reference")).not.toBeInTheDocument();
  });
});
