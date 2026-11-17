import type { NavigationSection } from "../../packages/ui/src/navigation";
import {
  buildDashboardSections,
  collectResourceKeys,
  extractResourceKeyFromHref,
} from "../../packages/ui/src/dashboard-utils";

const navigationSections: NavigationSection[] = [
  {
    id: "ops",
    label: "Operations",
    items: [
      {
        id: "shipments",
        label: "Shipments",
        href: "/console/resources/shipments",
      },
      {
        id: "nested",
        label: "Nested",
        items: [
          {
            id: "labels",
            label: "Labels",
            href: "/console/resources/labels?view=all",
          },
          {
            id: "no-link",
            label: "No Link",
            resource: "hidden_resource",
          },
        ],
      },
    ],
  },
  {
    id: "observability",
    label: "Observability",
    items: [
      {
        id: "events",
        label: "Events",
        href: "/console/resources/domain_events",
      },
    ],
  },
];

test("extractResourceKeyFromHref extracts registry keys from resource urls", () => {
  expect(extractResourceKeyFromHref("/console/resources/shipments")).toBe(
    "shipments"
  );
  expect(
    extractResourceKeyFromHref("/console/console/resources/labels?view=all")
  ).toBe("labels");
  expect(extractResourceKeyFromHref(null)).toBeNull();
});

test("buildDashboardSections flattens navigation items and respects limits", () => {
  const sections = buildDashboardSections(navigationSections, {
    maxItemsPerSection: 2,
    maxSections: 1,
  });

  expect(sections).toHaveLength(1);
  expect(sections[0].items.map((item) => item.id)).toEqual([
    "shipments",
    "labels",
  ]);
});

test("collectResourceKeys de-duplicates resource keys", () => {
  const sections = buildDashboardSections(navigationSections, {
    maxItemsPerSection: 5,
    maxSections: 2,
  });
  const keys = collectResourceKeys(sections);

  expect(keys).toEqual(["shipments", "labels", "domain_events"]);
});
