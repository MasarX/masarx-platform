const routeOperationsWorkspaceMock = jest.fn();

jest.mock("../../apps/portal/app/app-context", () => ({
  withPortalConfig: (render: unknown) => render,
}));

jest.mock("../../apps/portal/app/_components/route-operations-workspace-page", () => ({
  RouteOperationsWorkspacePage: (props: Record<string, unknown>) => {
    routeOperationsWorkspaceMock(props);
    return <div data-testid="portal-exception-workspace-page" />;
  },
}));

import { render, screen } from "@testing-library/react";
import { PortalExceptionInboxPage } from "../../apps/portal/app/operations/exceptions/exception-inbox-page";
import { PortalExceptionResourcePage } from "../../apps/portal/app/operations/exceptions/[resource]/exception-resource-page";

describe("Portal exception route pages", () => {
  beforeEach(() => {
    routeOperationsWorkspaceMock.mockReset();
  });

  test("routes the portal exception inbox through the shared exception workspace contract", () => {
    render(
      <PortalExceptionInboxPage
        appBasePath="/portal"
        appKey="portal"
        searchParams={{ lane: "dispatch_exception_review_mine" }}
      />,
    );

    expect(screen.getByTestId("portal-exception-workspace-page")).toBeInTheDocument();
    expect(routeOperationsWorkspaceMock).toHaveBeenCalledWith(
      expect.objectContaining({
        appBasePath: "/portal",
        appKey: "portal",
        searchParams: { lane: "dispatch_exception_review_mine" },
        sectionId: "operations",
        resourceSelector: "exceptions",
        workspacePathSegment: "exceptions",
        i18nNamespace: "ui.exceptionInbox",
        testIdPrefix: "portal-exception-inbox",
      }),
    );
  });

  test("routes portal exception detail pages through the shared resource-backed exception workspace contract", () => {
    render(
      <PortalExceptionResourcePage
        appBasePath="/portal"
        appKey="portal"
        resource="dispatch_exception_review"
        searchParams={{ status: "manual_review" }}
      />,
    );

    expect(screen.getByTestId("portal-exception-workspace-page")).toBeInTheDocument();
    expect(routeOperationsWorkspaceMock).toHaveBeenCalledWith(
      expect.objectContaining({
        appBasePath: "/portal",
        appKey: "portal",
        resourceKey: "dispatch_exception_review",
        searchParams: { status: "manual_review" },
        sectionId: "operations",
        resourceSelector: "exceptions",
        workspacePathSegment: "exceptions",
        i18nNamespace: "ui.exceptionInbox",
        testIdPrefix: "portal-exception-inbox",
      }),
    );
  });
});
