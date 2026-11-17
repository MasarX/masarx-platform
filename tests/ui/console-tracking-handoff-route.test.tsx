import Page from "../../apps/console/app/operate/shipments/page";

jest.mock("@masarx/ui", () => ({ ShipmentResourcePage: () => null }));
jest.mock("../../apps/console/app/app-context", () => ({
  withConsoleConfig: (render: (context: unknown, props: unknown) => unknown) =>
    (props: unknown) => render({ appKey: "console", appBasePath: "/console" }, props),
}));

test("the retained Console route delegates its focus to the authenticated shipment destination", () => {
  const searchParams = { focus: "MX &/ع", tab: "timeline", id: "stale" };
  const node = Page({ searchParams }) as unknown as React.ReactElement<Record<string, unknown>>;
  expect(node.props).toMatchObject({ appKey: "console", appBasePath: "/console", searchParams, operatorHandoffDestination: true });
});
