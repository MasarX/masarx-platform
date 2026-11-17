import { fireEvent } from "@testing-library/react";
import { NavigationStateProvider } from "../../packages/ui/src/navigation-preferences";
import { Section } from "../../packages/ui/src/section";
import { renderWithIntl } from "./test-utils";

const storageKey = "test:navigation:sections";

const renderSection = (
  collapsedSections: string[] = [],
  variant: "panel" | "plain" = "panel"
) =>
  renderWithIntl(
    <NavigationStateProvider
      storageKey={storageKey}
      legacyStorageKey={undefined}
      maxFavorites={0}
      maxRecents={0}
      defaultSidebarCollapsed={false}
      defaultCollapsedSections={collapsedSections}
      defaultLayoutMode="full"
    >
      <Section
        title="Test section"
        variant={variant}
        collapsible
        collapseKey="section.test"
      >
        <div>Content</div>
      </Section>
    </NavigationStateProvider>
  );

beforeEach(() => {
  window.localStorage.clear();
});

test("section respects default collapsed keys", () => {
  const { container } = renderSection(["section.test"]);
  const details = container.querySelector("details");
  expect(details).not.toBeNull();
  expect(details?.open).toBe(false);
});

test("section persists collapse state in navigation storage", () => {
  const { container } = renderSection();
  const details = container.querySelector("details");
  expect(details).not.toBeNull();
  details!.open = false;
  fireEvent(details!, new Event("toggle"));

  const stored = window.localStorage.getItem(storageKey);
  expect(stored).not.toBeNull();
  const parsed = JSON.parse(stored ?? "{}") as { collapsedSections?: string[] };
  expect(parsed.collapsedSections).toContain("section.test");
});

test("plain section persists collapse state in navigation storage", () => {
  const { container } = renderSection([], "plain");
  const details = container.querySelector("details");
  expect(details).not.toBeNull();
  details!.open = false;
  fireEvent(details!, new Event("toggle"));

  const stored = window.localStorage.getItem(storageKey);
  expect(stored).not.toBeNull();
  const parsed = JSON.parse(stored ?? "{}") as { collapsedSections?: string[] };
  expect(parsed.collapsedSections).toContain("section.test");
});
