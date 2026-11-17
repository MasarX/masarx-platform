import {
  createNavigationState,
  navigationReducer,
  peekActiveFrame,
  interpretSwipeGesture,
  type NavigationAction,
  type GestureOutcome,
  type InterpretSwipeOptions,
  findFirstEnabledNavItem,
  findNavItemById,
  parseMobileRouteFromHref,
  resolveInitialSelectedNavItemId,
  resolveMobileResourceSurface,
} from "../../../apps/fieldops/src/mobile-shell-navigation";

describe("preserved pure stack and swipe capability", () => {
  test("seeds, pushes, replaces, pops and protects the root without mutating inputs", () => {
    const params = { filter: "open" };
    const initial = { key: "tasks", params, transient: true };
    const root = createNavigationState(initial);
    params.filter = "closed";
    expect(root).toEqual({
      stack: [{ key: "tasks", title: null, params: { filter: "open" }, transient: false }],
      canGoBack: false,
    });
    const pushed = navigationReducer(root, { type: "PUSH", frame: { key: "detail", transient: true } });
    expect(pushed.canGoBack).toBe(true);
    expect(peekActiveFrame(pushed)?.transient).toBe(true);
    const replaced = navigationReducer(pushed, { type: "REPLACE", frame: { key: "replacement" } });
    expect(replaced.stack.map(frame => frame.key)).toEqual(["tasks", "replacement"]);
    expect(pushed.stack.map(frame => frame.key)).toEqual(["tasks", "detail"]);
    const popped = navigationReducer(replaced, { type: "POP" });
    const protectedRoot = navigationReducer(popped, { type: "POP" });
    expect(protectedRoot).toEqual(root);
    expect(protectedRoot).not.toBe(popped);
    expect(protectedRoot.stack[0]).not.toBe(root.stack[0]);
    expect(protectedRoot.stack[0].params).not.toBe(root.stack[0].params);
  });

  test("reset copies frames, clears root transience and refuses an empty replacement stack", () => {
    const root = createNavigationState({ key: "tasks" });
    const frames = [{ key: "route", transient: true, params: { id: "r1" } }, { key: "stop" }];
    const reset = navigationReducer(root, { type: "RESET", stack: frames });
    expect(reset.stack.map(frame => frame.key)).toEqual(["route", "stop"]);
    expect(reset.stack[0].transient).toBe(false);
    expect(reset.stack[0].params).not.toBe(frames[0].params);
    expect(frames[0].transient).toBe(true);
    expect(reset.canGoBack).toBe(true);
    expect(navigationReducer(reset, { type: "RESET", stack: [] })).toEqual(reset);
    const unknown = navigationReducer(reset, { type: "UNKNOWN" } as unknown as NavigationAction);
    expect(unknown).toEqual(reset);
    expect(unknown).not.toBe(reset);
    expect(peekActiveFrame({ stack: [], canGoBack: false })).toBeNull();
    expect(navigationReducer({ stack: [], canGoBack: false }, {
      type: "REPLACE", frame: { key: "seed" },
    }).stack[0].key).toBe("seed");
  });

  test.each([
    [200, 0, 1, {}, "commit_back"],
    [140, 0, 1, {}, "cancel"],
    [40, 0, 1, {}, "cancel"],
    [200, 0, 0, {}, "cancel"],
    [200, 0, -1, {}, "cancel"],
    [200, 0, Number.NaN, {}, "cancel"],
    [-200, 0, -1, {}, "open_drawer"],
    [-140, 0, -1, {}, "none"],
    [-200, 0, -0.5, {}, "none"],
    [-200, 0, -0.6, { velocityThreshold: 1 }, "none"],
    [-200, 0, -0.3, { velocityThreshold: 0.2 }, "open_drawer"],
    [-200, 0, -0.1, { velocityThreshold: -1 }, "open_drawer"],
    [-200, 0, -0.3, { velocityThreshold: Number.NaN }, "none"],
    [200, 201, 1, {}, "none"],
    [200, -200, 1, {}, "none"],
    [0, 0, 0, {}, "none"],
    [Number.NaN, 0, 1, {}, "none"],
    [Number.POSITIVE_INFINITY, 0, 1, {}, "none"],
    [200, Number.NaN, 1, {}, "commit_back"],
    [200, 0, 1, { containerWidth: 0 }, "none"],
    [200, 0, 1, { containerWidth: -1 }, "none"],
    [200, 0, 1, { containerWidth: Number.NaN }, "none"],
    [200, 0, 1, { containerWidth: Number.POSITIVE_INFINITY }, "none"],
    [200, 0, 1, { edgeThresholdPct: 0.7 }, "cancel"],
    [10, 0, 1, { edgeThresholdPct: -1 }, "commit_back"],
    [400, 0, 1, { edgeThresholdPct: 2 }, "cancel"],
    [200, 0, 1, { edgeThresholdPct: Number.NaN }, "commit_back"],
  ] as Array<[number, number, number, Partial<InterpretSwipeOptions>, GestureOutcome]>)(
    "interprets dx=%s dy=%s vx=%s options=%j as %s",
    (dx, dy, velocityX, options, outcome) => {
      expect(interpretSwipeGesture(
        { dx, dy, velocityX, velocityY: 999 },
        { containerWidth: 400, ...options }
      )).toBe(outcome);
    }
  );
});

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
