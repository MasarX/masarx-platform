jest.mock("../../apps/portal/app/app-context", () => ({
  withPortalConfig: (render: unknown) => render,
}));

jest.mock("@masarx/ui", () => ({
  Button: ({ children }: { children: unknown }) => children,
  PageHeader: ({ children }: { children: unknown }) => children,
  Section: ({ children }: { children: unknown }) => children,
}));

import { render, screen } from "@testing-library/react";
import { PortalMappingsPage } from "../../apps/portal/app/integrations/mappings/mappings-page";

describe("PortalMappingsPage", () => {
  test("links to the guided studio and report index from the portal entrypoint", () => {
    render(
      <PortalMappingsPage
        appBasePath="/portal"
        searchParams={{
          artifact: "webhook_inbound",
          resource: "shipments",
        }}
      />,
    );

    expect(screen.getByTestId("portal-mappings-ready")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Onboarding readiness" })).toHaveAttribute(
      "href",
      "/portal/onboarding/readiness",
    );
    expect(screen.getByRole("link", { name: "Start new mapping draft" })).toHaveAttribute(
      "href",
      "/portal/integrations/mappings/new?artifact=webhook_inbound&resource=shipments",
    );
    expect(screen.getByRole("link", { name: "Open report index" })).toHaveAttribute(
      "href",
      "/portal/resources/mapping_operation_reports",
    );
  });
});
