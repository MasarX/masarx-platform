import * as React from "react";
import { act, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { renderWithIntl } from "./test-utils";
import { NavigationNext } from "../../packages/ui/src/navigation-next";
import { setUiReporter } from "../../packages/ui/src/reporting";
import { buildNavigationStorageKey } from "../../packages/ui/src/navigation-preferences";

const push = jest.fn();

jest.mock("next/navigation", () => ({
  usePathname: () => "/",
  useRouter: () => ({ push })
}));
jest.mock("next/link", () => ({
  __esModule: true,
  default: ({ href, children, ...props }: { href: string; children: React.ReactNode }) =>
    React.createElement("a", { href, ...props }, children)
}));
jest.mock("../../packages/ui/src/command-registry-client", () => ({
  useCommandRegistry: () => ({ data: [], isLoading: false }),
}));
const useReadRegistry = jest.fn();
jest.mock("../../packages/ui/src/read-registry-client", () => ({
  useReadRegistry: (...args: unknown[]) => useReadRegistry(...args),
}));

const sections = [
  {
    id: "ops",
    label: "Operations",
    items: [
      {
        id: "shipments",
        label: "Shipments",
        href: "/resources/shipments"
      }
    ]
  }
];

beforeEach(() => {
  push.mockClear();
  localStorage.clear();
  useReadRegistry.mockReturnValue({ data: null, isLoading: false });
});

test.each([true, false])("scope gate applies to configured=%s and fallback navigation", (configured) => {
  useReadRegistry.mockReturnValue({ data: { resources: [{
    key: "route_stop_reassignment_events", label: "Reassignments", relation: "public.events",
    capability_read: "routes.read", read_scope_types: ["tenant"],
    scope_columns: { tenant: "organization_id" },
  }] }, isLoading: false });
  const navigation = configured ? [{ id: "routes", label: "Routes", items: [{
    id: "events", label: "Reassignments", href: "/resources/route_stop_reassignment_events",
    resource: "route_stop_reassignment_events", capability: "routes.read",
  }] }] : [];
  const { rerender } = renderWithIntl(<NavigationNext sections={navigation} appKey="console" userId="user-1" capabilities={["*"]} scopeType="platform" />);
  expect(screen.getByText("Reassignments").closest('[aria-disabled]')).toHaveAttribute("aria-disabled", "true");
  expect(screen.queryByRole("link", { name: "Reassignments" })).not.toBeInTheDocument();
  rerender(<NavigationNext sections={navigation} appKey="console" userId="user-1" capabilities={["routes.read"]} scopeType="tenant" scopeId={null} organizationId="org-1" />);
  expect(screen.getByRole("link", { name: "Reassignments" })).toBeInTheDocument();
});

afterEach(() => {
  setUiReporter(null);
});

test.each([["loading", false], ["ready", false], ["error", false], ["loading", true], ["error", true]] as const)("registry %s with stale=%s remains distinct from access denial", (state, stale) => {
  const resource = { key: "shipments", label: "Shipments", relation: "api.shipments" };
  useReadRegistry.mockReturnValue({
    data: state === "ready" || stale ? { resources: [resource] } : undefined,
    isFetching: state === "loading", isError: state === "error",
  });
  const navigation = [{ id: "ops", label: "Operations", items: [{
    id: "shipments", label: "Shipments", href: "/resources/shipments", resource: "shipments",
  }] }];
  const { container } = renderWithIntl(<NavigationNext sections={navigation} appKey="portal" userId="user-1" scopeType="client" scopeId="client-1" />);
  expect(container.querySelector('[data-navigation-registry-state]')).toHaveAttribute('data-navigation-registry-state', state);
  if (state === "ready") expect(screen.getByRole("link", { name: "Shipments" })).toBeInTheDocument();
  else {
    expect(screen.queryByRole("link", { name: "Shipments" })).toBeNull();
    expect(screen.getByText("Shipments").closest('[aria-disabled]')).toHaveAttribute('aria-disabled', 'true');
    expect(screen.queryByText("Request access from your organization admin, then refresh.")).toBeNull();
  }
});

test("omnibox navigates on enter via command palette", async () => {
  const user = userEvent.setup();
  renderWithIntl(
    <NavigationNext sections={sections} appKey="console" userId="user-1" />
  );

  expect(
    screen.queryByTestId("console-navigation-search")
  ).toBeNull();

  const openButton = screen.getByTestId("console-navigation-command-palette");
  await user.click(openButton);

  const input = await screen.findByTestId("console-command-palette-search");
  await user.type(input, "ship");
  await user.keyboard("{Enter}");

  expect(push).toHaveBeenCalledWith("/resources/shipments");
});

test.each(["missing_capability", "future_denial_code", "   "])(
  "command palette keeps server-denied navigation disabled with readable copy (%j)",
  async (reason) => {
    const user = userEvent.setup();
    renderWithIntl(<NavigationNext sections={[{ id: "ops", label: "Operations", items: [{
      id: "denied", label: "Denied shipment", href: "/denied", disabled_reason: reason,
    }] }]} appKey="console" userId="user-1" />);
    const copy = reason === "missing_capability"
      ? "You do not have access to this page."
      : "This page is currently unavailable.";
    expect(screen.getByTestId("navigation-item-denied")).toHaveAttribute("title", copy);
    await user.click(screen.getByTestId("console-navigation-command-palette"));
    const input = await screen.findByTestId("console-command-palette-search");
    await user.type(input, "Denied shipment");
    const result = screen.getByRole("button", { name: new RegExp(`Denied shipment.*${copy}`) });
    expect(result).toBeDisabled();
    await user.keyboard("{Enter}");
    expect(push).not.toHaveBeenCalled();
    expect(screen.queryByText(reason, { exact: true })).toBeNull();
  }
);

test("client capability denial uses generic copy without exposing capability names", () => {
  renderWithIntl(<NavigationNext sections={[{ id: "ops", label: "Operations", items: [{
    id: "denied", label: "Denied shipment", href: "/denied", capability: "shipments.read",
  }] }]} capabilities={[]} appKey="console" userId="user-1" />);
  const row = screen.getByTestId("navigation-item-denied");
  expect(row).toHaveAttribute("aria-disabled", "true");
  expect(row).toHaveAttribute("title", "You do not have access to this page.");
  expect(row).not.toHaveTextContent("shipments.read");
  expect(screen.queryByRole("link", { name: "Denied shipment" })).toBeNull();
});

test("navigation records recents", async () => {
  const user = userEvent.setup();
  renderWithIntl(
    <NavigationNext sections={sections} appKey="console" userId="user-1" />
  );

  const link = screen.getByRole("link", { name: "Shipments" });
  link.addEventListener("click", (event) => event.preventDefault());
  await user.click(link);

  expect(await screen.findByText("Recents")).toBeInTheDocument();
});

test("navigation toggles favorites", async () => {
  const reporter = jest.fn();
  setUiReporter(reporter);
  const user = userEvent.setup();
  renderWithIntl(
    <NavigationNext sections={sections} appKey="console" userId="user-1" />     
  );

  expect(screen.queryByText("Favorites")).toBeNull();

  const pinButton = screen.getByRole("button", { name: "Pin to favorites" });   
  await user.click(pinButton);

  expect(await screen.findByText("Favorites")).toBeInTheDocument();
  expect(reporter).toHaveBeenCalledWith(
    expect.objectContaining({
      type: "ui.navigation.favorite.toggle",
      context: "console",
      name: "shipments",
    })
  );
});

test("navigation persists collapsed sections", async () => {
  const user = userEvent.setup();
  const { unmount } = renderWithIntl(
    <NavigationNext sections={sections} appKey="console" userId="user-1" />
  );

  const toggleButton = screen.getByRole("button", {
    name: "Collapse section Operations",
  });
  await user.click(toggleButton);

  expect(
    screen.queryByRole("link", { name: "Shipments" })
  ).toBeNull();

  unmount();

  renderWithIntl(
    <NavigationNext sections={sections} appKey="console" userId="user-1" />
  );

  expect(
    screen.queryByRole("link", { name: "Shipments" })
  ).toBeNull();
});

test("navigation keyboard shortcut toggles sidebar state", async () => {        
  renderWithIntl(
    <NavigationNext sections={sections} appKey="console" userId="user-1" />     
  );
  await new Promise((resolve) => setTimeout(resolve, 0));

  await act(async () => {
    window.dispatchEvent(
      new KeyboardEvent("keydown", { key: "b", ctrlKey: true })
    );
  });

  const storageKey = buildNavigationStorageKey("console", "user-1");
  const stored = JSON.parse(localStorage.getItem(storageKey) ?? "{}");
  expect(stored.sidebarCollapsed).toBe(true);
});

test("command palette opens from navigation button", async () => {
  const user = userEvent.setup();
  renderWithIntl(
    <NavigationNext sections={sections} appKey="console" userId="user-1" />
  );

  expect(screen.queryByTestId("console-command-palette-search")).toBeNull();

  const openButton = screen.getByTestId("console-navigation-command-palette");
  await user.click(openButton);

  expect(
    await screen.findByTestId("console-command-palette-search")
  ).toBeInTheDocument();
});

test("command palette opens from keyboard shortcut", async () => {
  const user = userEvent.setup();
  renderWithIntl(
    <NavigationNext sections={sections} appKey="console" userId="user-1" />
  );

  expect(screen.queryByTestId("console-command-palette-search")).toBeNull();

  await act(async () => {
    window.dispatchEvent(
      new KeyboardEvent("keydown", { key: "k", ctrlKey: true })
    );
    await new Promise((resolve) => setTimeout(resolve, 0));
  });

  expect(
    await screen.findByTestId("console-command-palette-search")
  ).toBeInTheDocument();
});

test("navigation falls back to registry resources when sections are empty", async () => {
  useReadRegistry.mockReturnValue({
    data: {
      resources: [
        {
          key: "shipments",
          label: "Shipments",
          capability_read: "shipments.read",
        },
      ],
    },
    isLoading: false,
  });

  renderWithIntl(
    <NavigationNext
      sections={[]}
      appKey="console"
      userId="user-1"
      basePath="/console"
      capabilities={["shipments.read"]}
    />
  );

  expect(await screen.findByText("Registry resources")).toBeInTheDocument();
  const link = screen.getByRole("link", { name: "Shipments" });
  expect(link).toHaveAttribute("href", "/resources/shipments");
});

test("navigation fallback strips unsafe base paths for registry resources", async () => {
  useReadRegistry.mockReturnValue({
    data: {
      resources: [
        {
          key: "shipments",
          label: "Shipments",
          capability_read: "shipments.read",
        },
      ],
    },
    isLoading: false,
  });

  renderWithIntl(
    <NavigationNext
      sections={[]}
      appKey="console"
      userId="user-1"
      basePath="//portal"
      capabilities={["shipments.read"]}
    />
  );

  expect(await screen.findByText("Registry resources")).toBeInTheDocument();
  const link = screen.getByRole("link", { name: "Shipments" });
  expect(link).toHaveAttribute("href", "/resources/shipments");
});

test("Providers navigation is available to an integrations reader without plugin write", () => {
  // Normal navigation row from 202601071210_ui_navigation_integrations.sql.
  // Matching registry row from 202601071200_ui_read_registry_integrations.sql:
  // no explicit read_scope_types restriction (legacy scope contract).
  useReadRegistry.mockReturnValue({ data: { resources: [{
    key: "providers", relation: "public.providers",
    capability_read: "integrations.read", scope_columns: { tenant: "organization_id" },
  }] }, isLoading: false });
  renderWithIntl(<NavigationNext
    appKey="console" userId="provider-reader" basePath="/console"
    capabilities={["integrations.read"]}
    sections={[{ id: "integrations", label: "Integrations", items: [{
      id: "console-providers", label: "Providers",
      href: "/console/resources/providers", resource: "providers",
      capability: "integrations.read",
    }] }]}
  />);
  expect(screen.getByRole("link", { name: "Providers" }))
    .toHaveAttribute("href", "/resources/providers");
});
