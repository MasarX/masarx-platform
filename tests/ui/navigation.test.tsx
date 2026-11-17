import { fireEvent, render, screen } from "@testing-library/react";
import { Navigation } from "../../packages/ui/src/navigation";

test("navigation renders placeholder when empty", () => {
  render(<Navigation sections={[]} />);
  expect(screen.getByText("Navigation pending")).toBeInTheDocument();
  expect(
    screen.getByText(
      "Navigation updates once your access scope and UI registry resolve."
    )
  ).toBeInTheDocument();
  expect(screen.getByText("Next steps")).toBeInTheDocument();
});

test("navigation renders section and item labels", () => {
  render(
    <Navigation
      sections={[
        {
          id: "ops",
          label: "Operations",
          items: [{ id: "shipments", label: "Shipments", href: "/resources/shipments" }]
        }
      ]}
      activeHref="/resources/shipments"
    />
  );

  expect(screen.getByText("Operations")).toBeInTheDocument();
  expect(screen.getByText("Shipments")).toBeInTheDocument();
});

test("navigation renders disabled reasons for unavailable items", () => {
  render(
    <Navigation
      sections={[
        {
          id: "ops",
          label: "Operations",
          items: [
            {
              id: "shipments",
              label: "Shipments",
              href: "/resources/shipments",
              disabled_reason: "Requires shipments.read capability.",
            },
          ],
        },
      ]}
    />
  );

  expect(
    screen.getByText("Requires shipments.read capability.")
  ).toBeInTheDocument();
});

test("navigation collapses sections when configured", () => {
  const onToggleSection = jest.fn();
  render(
    <Navigation
      sections={[
        {
          id: "ops",
          label: "Operations",
          items: [{ id: "shipments", label: "Shipments", href: "/resources/shipments" }],
        },
      ]}
      collapsedSections={["ops"]}
      onToggleSection={onToggleSection}
    />
  );

  const sectionContent = document.getElementById("nav-section-ops");
  expect(sectionContent).toHaveAttribute("hidden");
  const toggle = screen.getByRole("button", {
    name: "Expand section Operations",
  });
  expect(toggle).toHaveAttribute("aria-expanded", "false");
  fireEvent.click(toggle);
  expect(onToggleSection).toHaveBeenCalledWith("ops");
});

test("navigation supports pinning favorites", () => {
  const onToggleFavorite = jest.fn();
  render(
    <Navigation
      sections={[
        {
          id: "ops",
          label: "Operations",
          items: [{ id: "shipments", label: "Shipments", href: "/resources/shipments" }],
        },
      ]}
      favorites={[]}
      onToggleFavorite={onToggleFavorite}
    />
  );

  const toggle = screen.getByTestId("navigation-favorite-toggle-shipments");
  expect(toggle).toHaveAttribute("aria-pressed", "false");

  fireEvent.click(toggle);
  expect(onToggleFavorite).toHaveBeenCalledWith(
    expect.objectContaining({ id: "shipments" })
  );
});

test("navigation reflects pinned favorite state", () => {
  render(
    <Navigation
      sections={[
        {
          id: "ops",
          label: "Operations",
          items: [{ id: "shipments", label: "Shipments", href: "/resources/shipments" }],
        },
      ]}
      favorites={["shipments"]}
      onToggleFavorite={() => undefined}
    />
  );

  expect(screen.getByTestId("navigation-favorite-toggle-shipments")).toHaveAttribute(
    "aria-pressed",
    "true"
  );
});
