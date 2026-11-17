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
    screen.getByText("You do not have access to this page.")
  ).toBeInTheDocument();
});

test("navigation presents a known machine reason without changing access gating", () => {
  render(
    <Navigation sections={[{
      id: "ops",
      label: "Operations",
      items: [{
        id: "shipments",
        label: "Shipments",
        href: "/resources/shipments",
        capability: "shipments.read",
        disabled_reason: "missing_capability",
      }],
    }]} />
  );
  expect(screen.getByText("You do not have access to this page.")).toBeInTheDocument();
  expect(screen.queryByText("missing_capability")).not.toBeInTheDocument();
  expect(screen.getByTestId("navigation-item-shipments")).toHaveAttribute("aria-disabled", "true");
  expect(screen.queryByRole("link", { name: "Shipments" })).not.toBeInTheDocument();
});

test.each([
  ["missing_capability", "You do not have access to this page."],
  ["explicit_deny", "You do not have access to this page."],
  ["no_roles", "You do not have access to this page."],
  ["no_policy", "You do not have access to this page."],
  ["no_capabilities", "You do not have access to this page."],
  ["future_denial_code", "This page is currently unavailable."],
  ["future/denial", "This page is currently unavailable."],
  ["no_route", "This page is currently unavailable."],
  ["   ", "This page is currently unavailable."],
  ["Awaiting enrollment approval.", "Awaiting enrollment approval."],
])("navigation presents readable reasons for %j and keeps nested links disabled", (reason, copy) => {
  const onNavigate = jest.fn();
  const onToggleFavorite = jest.fn();
  render(<Navigation sections={[{ id: "ops", label: "Operations", items: [{
    id: "parent", label: "Parent", href: "/parent", items: [{
      id: "denied", label: "Denied page", href: "/denied", disabled_reason: reason,
    }],
  }] }]} onNavigate={onNavigate} onToggleFavorite={onToggleFavorite} />);
  const row = screen.getByTestId("navigation-item-denied");
  expect(row).toHaveAttribute("aria-disabled", "true");
  expect(row).toHaveAttribute("title", copy);
  expect(row).toHaveTextContent(copy);
  expect(row.querySelector("a, button, [tabindex]")).toBeNull();
  fireEvent.click(row);
  fireEvent.keyDown(row, { key: "Enter" });
  expect(onNavigate).not.toHaveBeenCalled();
  expect(onToggleFavorite).not.toHaveBeenCalled();
});

test("navigation localizes access reasons in Arabic", () => {
  const previousLocale = process.env.NEXT_PUBLIC_LOCALE;
  process.env.NEXT_PUBLIC_LOCALE = "ar";
  try {
    render(<Navigation sections={[{ id: "ops", label: "Operations", items: [{
      id: "denied", label: "Denied page", href: "/denied", disabled_reason: "missing_capability",
    }] }]} />);
    expect(screen.getByTestId("navigation-item-denied")).toHaveAttribute(
      "title", "ليست لديك صلاحية الوصول إلى هذه الصفحة."
    );
    expect(screen.queryByText("missing_capability")).toBeNull();
  } finally {
    if (previousLocale === undefined) delete process.env.NEXT_PUBLIC_LOCALE;
    else process.env.NEXT_PUBLIC_LOCALE = previousLocale;
  }
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
