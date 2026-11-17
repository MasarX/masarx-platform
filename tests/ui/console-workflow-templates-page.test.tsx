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

jest.mock("@masarx/ui", () => ({
  Button: ({ children }: { children: unknown }) => children,
  createUiTranslator: () => (key: string) => key,
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
  resourceKey: string;
}> = [];

jest.mock("../../apps/console/app/_components/resource-page", () => ({
  ResourcePage: (props: {
    baseHref: string;
    headerActions?: unknown;
    resourceKey: string;
  }) => {
    resourcePageCalls.push(props);

    return (
      <div data-testid="resource-page">
        <div data-testid="resource-key">{props.resourceKey}</div>
        <div data-testid="base-href">{props.baseHref}</div>
        {props.headerActions as any}
      </div>
    );
  },
}));

import { screen } from "@testing-library/react";
import { renderWithIntl } from "./test-utils";
import ConsoleWorkflowTemplatesPage from "../../apps/console/app/workflows/templates/page";

describe("ConsoleWorkflowTemplatesPage", () => {
  beforeEach(() => {
    resourcePageCalls.length = 0;
    jest.resetAllMocks();
  });

  it("adds the onboarding readiness shortcut to the workflow templates surface", async () => {
    const node = await ConsoleWorkflowTemplatesPage({
      searchParams: { detail_open: "1", id: "template-1" },
    });

    renderWithIntl(node);

    expect(screen.getByTestId("resource-key")).toHaveTextContent("workflow_templates");
    expect(screen.getByTestId("base-href")).toHaveTextContent("/console/workflows/templates");
    expect(screen.getByRole("link", { name: "Onboarding readiness" })).toHaveAttribute(
      "href",
      "/console/onboarding/readiness",
    );
    expect(screen.getByRole("link", { name: "Workflow bindings" })).toHaveAttribute(
      "href",
      "/console/workflows/bindings",
    );
    expect(screen.getByRole("link", { name: "actions.newTemplate" })).toHaveAttribute(
      "href",
      "/console/workflows/templates/new",
    );
  });
});
