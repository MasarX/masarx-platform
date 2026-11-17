jest.mock("@masarx/api/server", () => ({
  createUiServerClient: jest.fn(),
}));

jest.mock("next-intl", () => ({
  NextIntlClientProvider: ({ children }: { children: unknown }) => children,
  useTranslations:
    (namespace?: string) =>
    (key: string) =>
      namespace ? `${namespace}.${key}` : key,
  createTranslator:
    ({ namespace }: { namespace?: string } = {}) =>
    (key: string, values?: Record<string, unknown>) => {
      if (key === "ui.resourcePage.unavailable.title") return "Resource view unavailable.";
      if (key === "ui.resourcePage.errors.suggestedResources") {
        return "Suggested resources:";
      }
      if (key === "ui.resourcePage.errors.openSuggestedResource") {
        return `Open ${String(values?.resourceKey ?? "")}`.trim();
      }
      if (key === "ui.resourcePage.errors.resourceNotRegisteredSuggested") {
        return `Resource \"${String(values?.resourceKey ?? "")}\" is not registered in ui_read_registry. Did you mean: ${String(values?.suggestions ?? "")}?`;
      }
      if (key === "ui.context.nextStep") {
        return `Next step: ${String(values?.action ?? "")}`;
      }
      return namespace ? `${namespace}.${key}` : key;
    },
}));

jest.mock("../../packages/ui/src/i18n", () => ({
  createUiTranslator:
    (namespace?: string) =>
    (key: string, values?: Record<string, unknown>) => {
      const fullKey = namespace ? `${namespace}.${key}` : key;
      if (fullKey === "ui.resourcePage.unavailable.title") return "Resource view unavailable.";
      if (fullKey === "ui.resourcePage.unavailable.action") {
        return "Confirm the UI registry and resource read RPCs are provisioned for this scope.";
      }
      if (fullKey === "ui.resourcePage.errors.suggestedResources") {
        return "Suggested resources:";
      }
      if (fullKey === "ui.resourcePage.errors.openSuggestedResource") {
        return `Open ${String(values?.resourceKey ?? "")}`.trim();
      }
      if (fullKey === "ui.resourcePage.errors.resourceNotRegisteredSuggested") {
        return `Resource \"${String(values?.resourceKey ?? "")}\" is not registered in ui_read_registry. Did you mean: ${String(values?.suggestions ?? "")}?`;
      }
      if (fullKey === "ui.resourcePage.errors.resourceNotRegistered") {
        return `Resource \"${String(values?.resourceKey ?? "")}\" is not registered in ui_read_registry.`;
      }
      if (fullKey === "ui.context.nextStep") {
        return `Next step: ${String(values?.action ?? "")}`;
      }
      return fullKey;
    },
}));

jest.mock("next/navigation", () => ({
  useRouter: () => ({ replace: jest.fn(), push: jest.fn() }),
  useSearchParams: () => new URLSearchParams(),
  usePathname: () => "/",
  useParams: () => ({}),
}));

import { screen } from "@testing-library/react";
import { createUiServerClient } from "@masarx/api/server";
import { ResourcePage } from "../../packages/ui/src/resource-page";
import { renderWithIntl } from "./test-utils";

const mockedCreateUiServerClient = createUiServerClient as unknown as jest.Mock;

describe("ResourcePage unavailable suggestions", () => {
  beforeEach(() => {
    jest.resetAllMocks();
  });

  it("shows quick links for suggested resources when key is missing", async () => {
    mockedCreateUiServerClient.mockReturnValue({
      readRegistry: jest.fn().mockResolvedValue({
        resources: [{ key: "shipments" }, { key: "labels" }],
      }),
      me: jest.fn().mockResolvedValue({ capabilities: ["shipments.read"] }),
    });

    const node = await ResourcePage({
      appKey: "portal",
      resourceKey: "shipments_missing",
      searchParams: {},
      appBasePath: "/portal",
      testIdPrefix: "resource-page",
    });

    renderWithIntl(node);

    expect(screen.getByText("Resource view unavailable.")).toBeInTheDocument();
    expect(
      screen.getByText(
        /Resource "shipments_missing" is not registered in ui_read_registry\./i
      )
    ).toBeInTheDocument();
    expect(screen.getByText("Suggested resources:")).toBeInTheDocument();
    expect(
      screen.getByRole("link", { name: "Open shipments" })
    ).toHaveAttribute("href", "/portal/resources/shipments");
  });

  it("does not render suggested links when there is no close match", async () => {
    mockedCreateUiServerClient.mockReturnValue({
      readRegistry: jest.fn().mockResolvedValue({
        resources: [{ key: "labels" }],
      }),
      me: jest.fn().mockResolvedValue({ capabilities: ["labels.read"] }),
    });

    const node = await ResourcePage({
      appKey: "console",
      resourceKey: "zzzz_missing_resource",
      searchParams: {},
      appBasePath: "/console",
      testIdPrefix: "resource-page",
    });

    renderWithIntl(node);

    expect(
      screen.queryByRole("link", { name: /Open /i })
    ).not.toBeInTheDocument();
    expect(screen.queryByText("Suggested resources:")).not.toBeInTheDocument();
  });

  it("omits unsafe suggestion links when appBasePath is untrusted", async () => {
    mockedCreateUiServerClient.mockReturnValue({
      readRegistry: jest.fn().mockResolvedValue({
        resources: [{ key: "shipments" }, { key: "labels" }],
      }),
      me: jest.fn().mockResolvedValue({ capabilities: ["shipments.read"] }),
    });

    const node = await ResourcePage({
      resourceKey: "shipments_missing",
      searchParams: {},
      appBasePath: "javascript:alert(1)",
      testIdPrefix: "resource-page",
    });

    renderWithIntl(node);

    expect(
      screen.queryByText("Suggested resources:")
    ).not.toBeInTheDocument();
    expect(screen.queryByRole("link", { name: /Open /i })).not.toBeInTheDocument();
    for (const link of screen.queryAllByRole("link")) {
      expect(link).not.toHaveAttribute("href", /javascript:/i);
    }
  });
});
