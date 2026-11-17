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

afterEach(() => {
  setUiReporter(null);
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
