import { render, screen } from "@testing-library/react";
import { AppShell } from "../../packages/ui/src/app-shell";
import { UiNavigationProvider } from "../../packages/ui/src/ui-navigation-context";

jest.mock("next/navigation", () => ({
  usePathname: () => "/resources/shipments",
}));

test("app shell exposes a skip-to-content link", () => {
  render(
    <AppShell appName="Console">
      <div>Child content</div>
    </AppShell>
  );

  const skipLink = screen.getByText("Skip to content");
  expect(skipLink).toHaveAttribute("href", "#main-content");
});

test("app shell anchors the main content target", () => {
  render(
    <AppShell appName="Console">
      <div>Child content</div>
    </AppShell>
  );

  const main = screen.getByRole("main");
  expect(main).toHaveAttribute("id", "main-content");
  expect(main).toHaveAttribute("tabindex", "-1");
});

test("app shell defaults to contained layout", () => {
  const { container } = render(
    <AppShell appName="Console">
      <div>Child content</div>
    </AppShell>
  );
  const root = container.firstChild as HTMLElement;
  expect(root.style.getPropertyValue("--ui-layout-max-width")).toBe("1200px");
});

test("app shell applies contained layout when enabled", () => {
  const { container } = render(
    <AppShell appName="Console" layout="contained" layoutMaxWidth="64rem">
      <div>Child content</div>
    </AppShell>
  );
  const root = container.firstChild as HTMLElement;
  expect(root.style.getPropertyValue("--ui-layout-max-width")).toBe("64rem");
});

test("app shell applies full-width layout when requested", () => {
  const { container } = render(
    <AppShell appName="Console" layout="full" layoutMaxWidth="64rem">
      <div>Child content</div>
    </AppShell>
  );
  const root = container.firstChild as HTMLElement;
  expect(root.style.getPropertyValue("--ui-layout-max-width")).toBe("100%");
});

test("app shell shows breadcrumbs when navigation resolves", () => {
  render(
    <UiNavigationProvider
      basePath=""
      sections={[
        {
          id: "ops",
          label: "Operations",
          items: [
            {
              id: "shipments",
              label: "Shipments",
              href: "/resources/shipments",
            },
          ],
        },
      ]}
    >
      <AppShell appName="Console">
        <div>Child content</div>
      </AppShell>
    </UiNavigationProvider>
  );

  expect(
    screen.getByRole("navigation", { name: "Breadcrumb" })
  ).toHaveTextContent("Operations");
  expect(screen.getByText("Shipments")).toBeInTheDocument();
});

test("app shell shows breadcrumbs when base path is unsafe", () => {
  render(
    <UiNavigationProvider
      basePath="//portal"
      sections={[
        {
          id: "ops",
          label: "Operations",
          items: [
            {
              id: "shipments",
              label: "Shipments",
              href: "/resources/shipments",
            },
          ],
        },
      ]}
    >
      <AppShell appName="Console">
        <div>Child content</div>
      </AppShell>
    </UiNavigationProvider>
  );

  expect(
    screen.getByRole("navigation", { name: "Breadcrumb" })
  ).toHaveTextContent("Operations");
  expect(screen.getByText("Shipments")).toBeInTheDocument();
});
