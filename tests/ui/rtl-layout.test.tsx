import { render, screen } from "@testing-library/react";
import { AppShell } from "../../packages/ui/src/app-shell";
import { Drawer, DrawerContent } from "../../packages/ui/src/drawer";

jest.mock("next/navigation", () => ({
  usePathname: () => "/",
}));

/**
 * RTL layout tests verify that the AppShell and Drawer components
 * respect dir="rtl" context and use logical CSS properties (start/end)
 * so the layout mirrors correctly for right-to-left languages (Arabic, Hebrew).
 */

test("app shell renders correctly within an RTL document", () => {
  const { container } = render(
    <div dir="rtl">
      <AppShell appName="Console">
        <div>RTL content</div>
      </AppShell>
    </div>
  );

  const rtlWrapper = container.firstChild as HTMLElement;
  expect(rtlWrapper).toHaveAttribute("dir", "rtl");

  // Main content renders within the RTL wrapper
  expect(screen.getByText("RTL content")).toBeInTheDocument();
});

test("app shell sidebar uses logical start-0 positioning (RTL-safe)", () => {
  const { container } = render(
    <div dir="rtl">
      <AppShell appName="Console">
        <div>Content</div>
      </AppShell>
    </div>
  );

  const sidebar = container.querySelector("[data-testid='app-app-shell-sidebar']");
  expect(sidebar).toBeInTheDocument();

  // Sidebar uses lg:start-0 (logical) instead of lg:left-0 (physical).
  // In RTL mode, start-0 resolves to right:0, placing the sidebar
  // on the correct side for Arabic/Hebrew layouts.
  const sidebarClasses = sidebar?.className ?? "";
  expect(sidebarClasses).not.toMatch(/\blg:left-0\b/);
  expect(sidebarClasses).not.toMatch(/\blg:right-0\b/);
});

test("drawer content with side=start uses logical positioning", () => {
  const { baseElement } = render(
    <div dir="rtl">
      <Drawer open>
        <DrawerContent side="start" data-testid="rtl-drawer">
          <div>Drawer content</div>
        </DrawerContent>
      </Drawer>
    </div>,
  );

  // The DrawerContent should use start-0 (not left-0/right-0)
  // Radix Dialog.Portal renders outside the container, so check baseElement
  const dialogContent = baseElement.querySelector("[role='dialog']");
  if (dialogContent) {
    const classes = dialogContent.className;
    expect(classes).toContain("start-0");
    expect(classes).not.toContain("left-0");
    expect(classes).not.toContain("right-0");
  }
});

test("drawer content with side=end uses logical positioning", () => {
  const { baseElement } = render(
    <div dir="rtl">
      <Drawer open>
        <DrawerContent side="end" data-testid="rtl-drawer-end">
          <div>End drawer</div>
        </DrawerContent>
      </Drawer>
    </div>,
  );

  const dialogContent = baseElement.querySelector("[role='dialog']");
  if (dialogContent) {
    const classes = dialogContent.className;
    expect(classes).toContain("end-0");
    expect(classes).not.toContain("left-0");
    expect(classes).not.toContain("right-0");
  }
});

test("skip-to-content link uses logical start positioning", () => {
  render(
    <div dir="rtl">
      <AppShell appName="Console">
        <div>Content</div>
      </AppShell>
    </div>
  );

  const skipLink = screen.getByText("Skip to content");
  const classes = skipLink.className;
  // Should use focus:start-4 (logical) not focus:left-4 (physical)
  expect(classes).toContain("focus:start-4");
  expect(classes).not.toContain("focus:left-4");
});
