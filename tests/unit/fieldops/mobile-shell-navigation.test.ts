import {
  findFirstEnabledNavItem,
  findNavItemById,
  parseMobileRouteFromHref,
  resolveInitialSelectedNavItemId,
  resolveMobileResourceSurface,
} from "../../../apps/fieldops/src/mobile-shell-navigation";

describe("mobile shell navigation helpers", () => {
  test("parses resource routes", () => {
    expect(parseMobileRouteFromHref("/resources/tasks")).toEqual({
      kind: "resource",
      resource: "tasks",
    });
  });

  test("parses native mobile screen routes", () => {
    expect(parseMobileRouteFromHref("/mobile/route")).toEqual({
      kind: "screen",
      screen: "route",
    });
    expect(parseMobileRouteFromHref("/mobile/settlements")).toEqual({
      kind: "screen",
      screen: "settlements",
    });
    expect(parseMobileRouteFromHref("/mobile/tasks")).toEqual({
      kind: "screen",
      screen: "tasks",
    });
    expect(parseMobileRouteFromHref("/scan")).toEqual({
      kind: "screen",
      screen: "scan",
    });
  });

  test("parses mobile scheme routes", () => {
    expect(parseMobileRouteFromHref("mobile:scan")).toEqual({
      kind: "screen",
      screen: "scan",
    });
  });

  test("returns null on unsupported href values", () => {
    expect(parseMobileRouteFromHref("/mobile/unknown")).toBeNull();
    expect(parseMobileRouteFromHref("")).toBeNull();
  });

  test("parses prefixed and absolute mobile paths", () => {
    expect(parseMobileRouteFromHref("/app/mobile/route")).toEqual({
      kind: "screen",
      screen: "route",
    });
    expect(parseMobileRouteFromHref("/app/resources/tasks/")).toEqual({
      kind: "resource",
      resource: "tasks",
    });
    expect(parseMobileRouteFromHref("https://example.test/app/mobile/scan?x=1")).toEqual({
      kind: "screen",
      screen: "scan",
    });
  });

  test("resolves route and settlements to resource surfaces", () => {
    expect(
      resolveMobileResourceSurface({
        kind: "screen",
        screen: "route",
      })
    ).toEqual({
      kind: "route",
      resource: "tasks",
    });

    expect(
      resolveMobileResourceSurface({
        kind: "screen",
        screen: "settlements",
      })
    ).toEqual({
      kind: "settlements",
      resource: "settlements",
    });
  });

  test("keeps direct resource surfaces and ignores non-resource screens", () => {
    expect(
      resolveMobileResourceSurface({
        kind: "resource",
        resource: "tasks",
      })
    ).toEqual({
      kind: "resource",
      resource: "tasks",
    });

    expect(
      resolveMobileResourceSurface({
        kind: "screen",
        screen: "outbox",
      })
    ).toBeNull();
    expect(
      resolveMobileResourceSurface({
        kind: "screen",
        screen: "tasks",
      })
    ).toEqual({
      kind: "resource",
      resource: "tasks",
    });
  });

  test("finds first enabled item across nested sections", () => {
    const first = findFirstEnabledNavItem([
      {
        id: "group",
        label: "Group",
        href: null,
        resource: null,
        disabled_reason: null,
        badge: null,
        items: [
          {
            id: "disabled",
            label: "Disabled",
            href: "/mobile/scan",
            resource: null,
            disabled_reason: "policy",
            badge: null,
            items: [],
          },
          {
            id: "nested-scan",
            label: "Scan",
            href: "/mobile/scan",
            resource: null,
            disabled_reason: null,
            badge: null,
            items: [],
          },
        ],
      },
    ]);

    expect(first?.id).toBe("nested-scan");
  });

  test("resolves selected id with stale-id fallback", () => {
    const sections = [
      {
        id: "tasks",
        label: "Tasks",
        items: [
          {
            id: "mobile-tasks",
            label: "Tasks",
            href: null,
            resource: "tasks",
            disabled_reason: null,
            badge: null,
            items: [],
          },
        ],
      },
      {
        id: "tools",
        label: "Tools",
        items: [
          {
            id: "mobile-scan",
            label: "Scan",
            href: "/mobile/scan",
            resource: null,
            disabled_reason: null,
            badge: null,
            items: [],
          },
          {
            id: "mobile-more",
            label: "More",
            href: "/mobile/more",
            resource: null,
            disabled_reason: null,
            badge: null,
            items: [],
          },
        ],
      },
    ];

    expect(resolveInitialSelectedNavItemId(sections, "mobile-more")).toBe("mobile-more");
    expect(resolveInitialSelectedNavItemId(sections, "stale-item")).toBe("mobile-tasks");
    expect(resolveInitialSelectedNavItemId(sections, null)).toBe("mobile-tasks");
    expect(resolveInitialSelectedNavItemId(sections, null, "/scan")).toBe("mobile-scan");
    expect(resolveInitialSelectedNavItemId(sections, "stale-item", "/scan")).toBe("mobile-scan");
    expect(resolveInitialSelectedNavItemId(sections, "mobile-more", "/scan")).toBe("mobile-more");
  });

  test("finds nav item by id across nested levels", () => {
    const item = findNavItemById(
      [
        {
          id: "outer",
          label: "Outer",
          href: null,
          resource: null,
          disabled_reason: null,
          badge: null,
          items: [
            {
              id: "inner-route",
              label: "Route",
              href: "/mobile/route",
              resource: null,
              disabled_reason: null,
              badge: null,
              items: [],
            },
          ],
        },
      ],
      "inner-route"
    );
    expect(item?.label).toBe("Route");
  });
});
