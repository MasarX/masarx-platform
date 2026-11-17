if (typeof Request === "undefined") {
  Object.assign(globalThis, {
    Headers: class Headers {},
    Request: class Request {},
    Response: class Response {},
  });
}

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
    (key: string) =>
      namespace ? `${namespace}.${key}` : key,
}));

jest.mock("../../apps/console/app/app-context", () => ({
  withConsoleConfig:
    (
      render: (
        context: { appKey: string; appBasePath: string },
        props: { searchParams: Record<string, string | string[] | undefined> },
      ) => unknown,
    ) =>
    (props: { searchParams: Record<string, string | string[] | undefined> }) =>
      render(
        {
          appKey: "console",
          appBasePath: "/console",
        },
        props,
      ),
}));

const resourcePageCalls: Array<{
  baseHref: string;
  headerActions?: unknown;
  renderDetailFooter?: (context: {
    detailId: string;
    detail: Record<string, unknown> | null;
    detailError: string | null;
    downloadHref: string | null;
    baseHref: string;
    resource: Record<string, unknown> | null;
  }) => unknown;
  resourceKey: string;
}> = [];

jest.mock("../../apps/console/app/_components/resource-page", () => ({
  ResourcePage: (props: {
    baseHref: string;
    headerActions?: unknown;
    renderDetailFooter?: (context: {
      detailId: string;
      detail: Record<string, unknown> | null;
      detailError: string | null;
      downloadHref: string | null;
      baseHref: string;
      resource: Record<string, unknown> | null;
    }) => unknown;
    resourceKey: string;
  }) => {
    resourcePageCalls.push(props);

    return (
      <div data-testid="resource-page">
        <div data-testid="resource-key">{props.resourceKey}</div>
        <div data-testid="base-href">{props.baseHref}</div>
        {props.headerActions as any}
        {props.renderDetailFooter?.({
          detailId: "plugin-workspace-123",
          detail: { id: "plugin-workspace-123" },
          detailError: null,
          downloadHref: null,
          baseHref: props.baseHref,
          resource: { key: props.resourceKey },
        }) as any}
      </div>
    );
  },
}));

import { screen } from "@testing-library/react";
import { renderWithIntl } from "./test-utils";
import ConsoleIntegrationPluginsPage from "../../apps/console/app/integrations/plugins/page";

describe("ConsoleIntegrationPluginsPage", () => {
  beforeEach(() => {
    resourcePageCalls.length = 0;
    jest.resetAllMocks();
  });

  it("renders the integration plugins entrypoint and provider-health workspace links", async () => {
    const node = await ConsoleIntegrationPluginsPage({
      searchParams: { detail_open: "1", id: "plugin-1" },
    });

    renderWithIntl(node);

    expect(screen.getByTestId("resource-key")).toHaveTextContent("integration_plugins");
    expect(screen.getByTestId("base-href")).toHaveTextContent("/console/integrations/plugins");
    expect(screen.getByRole("link", { name: "Onboarding readiness" })).toHaveAttribute(
      "href",
      "/console/organizations/readiness",
    );
    expect(screen.getByRole("link", { name: "Onboarding readiness" })).toHaveAttribute(
      "href",
      "/console/organizations/readiness",
    );
    expect(screen.getByRole("link", { name: "New Plugin" })).toHaveAttribute(
      "href",
      "/console/integrations/plugins/new",
    );
    expect(screen.getByRole("link", { name: "Provider Health" })).toHaveAttribute(
      "href",
      "/console/resources/provider_health_latest",
    );
    expect(screen.getByRole("link", { name: "Circuit Breakers" })).toHaveAttribute(
      "href",
      "/console/resources/circuit_breaker_dashboard",
    );
    expect(screen.getByRole("link", { name: "Open Plugin Workspace" })).toHaveAttribute(
      "href",
      "/console/integrations/plugins/plugin-workspace-123",
    );

    expect(resourcePageCalls).toHaveLength(1);
    const renderDetailFooter = resourcePageCalls[0].renderDetailFooter;
    expect(renderDetailFooter).toBeDefined();
    expect(
      renderDetailFooter?.({
        detailId: "plugin-1",
        detail: { id: "plugin-1" },
        detailError: null,
        downloadHref: null,
        baseHref: "/console/integrations/plugins",
        resource: { key: "integration_plugins" },
      }),
    ).toBeTruthy();
    expect(
      renderDetailFooter?.({
        detailId: "plugin-1",
        detail: { id: "plugin-1" },
        detailError: "failed",
        downloadHref: null,
        baseHref: "/console/integrations/plugins",
        resource: { key: "integration_plugins" },
      }),
    ).toBeNull();
  });
});
