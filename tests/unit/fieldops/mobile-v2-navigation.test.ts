import {
  collectMobileV2Capabilities,
  filterMobileV2Navigation,
  findMobileV2DefaultHome,
  findMobileV2ItemById,
  flattenMobileV2Navigation,
  hasMobileV2Capability,
  isMobileV2ItemVisible,
  parseMobileV2NavigationItem,
  parseMobileV2NavigationPayload,
  parseMobileV2NavigationSection,
  type MobileV2NavigationContext,
} from "../../../apps/fieldops/src/mobile-v2-navigation";

const FULL_PAYLOAD = {
  apps: {
    mobile: {
      sections: [
        {
          id: "tools",
          label: "Tools",
          items: [
            {
              id: "mobile-outbox",
              label: "Outbox",
              href: "/mobile/outbox",
              capability: "tasks.read",
            },
            {
              id: "mobile-scan",
              label: "Scan",
              href: "/mobile/scan",
              capability: "scan_events.write",
            },
          ],
        },
        {
          id: "v2-home",
          label: "Home",
          items: [
            {
              id: "mobile-tasks",
              label: "Tasks",
              href: "/mobile/tasks",
              capability: "tasks.read",
              icon: "list",
              default_home: true,
            },
            {
              id: "mobile-loader-today",
              label: "Loader Home",
              href: "/mobile/loader-today",
              capability: "loader.home.read",
              icon: "package",
              roles: ["loader"],
            },
            {
              id: "mobile-rider-today",
              label: "Rider Home",
              href: "/mobile/rider-today",
              capability: "rider.home.read",
              icon: "bike",
              roles: ["rider"],
            },
          ],
        },
        {
          id: "v2-network-ops",
          label: "Network",
          items: [
            {
              id: "mobile-pickups",
              label: "Pickups",
              href: "/mobile/pickups",
              capability: "pickups.read",
              icon: "box",
            },
            {
              id: "mobile-trips",
              label: "Trips",
              href: "/mobile/trips",
              capability: "trips.read",
              icon: "truck",
            },
          ],
        },
      ],
    },
  },
};

const DRIVER_CTX: MobileV2NavigationContext = {
  activeRole: "driver",
  capabilities: ["tasks.read", "scan_events.write", "pickups.read", "trips.read"],
};
const LOADER_CTX: MobileV2NavigationContext = {
  activeRole: "loader",
  capabilities: ["tasks.read", "loader.home.read"],
};
const SUPERVISOR_CTX: MobileV2NavigationContext = {
  activeRole: "supervisor",
  capabilities: ["*"],
};

describe("parseMobileV2NavigationItem", () => {
  test("parses a complete item", () => {
    const out = parseMobileV2NavigationItem({
      id: "mobile-tasks",
      label: "Tasks",
      href: "/mobile/tasks",
      capability: "tasks.read",
      icon: "list",
      default_home: true,
    });
    expect(out).not.toBeNull();
    expect(out?.id).toBe("mobile-tasks");
    expect(out?.icon).toBe("list");
    expect(out?.defaultHome).toBe(true);
    expect(out?.roles).toBeNull();
    expect(out?.disabledReason).toBeNull();
  });

  test("preserves backend disabled_reason for capability-denied rows", () => {
    const out = parseMobileV2NavigationItem({
      id: "mobile-wallet",
      label: "Wallet",
      href: "/mobile/wallet",
      capability: "wallet.read",
      disabled_reason: { reason: "missing_capability", capability: "wallet.read" },
    });
    expect(out?.disabledReason).toEqual({
      reason: "missing_capability",
      capability: "wallet.read",
    });
  });

  test("parses an item with roles array", () => {
    const out = parseMobileV2NavigationItem({
      id: "mobile-loader-today",
      label: "Loader Home",
      href: "/mobile/loader-today",
      capability: "loader.home.read",
      roles: ["loader"],
    });
    expect(out?.roles).toEqual(["loader"]);
  });

  test("returns null when required field is missing", () => {
    expect(
      parseMobileV2NavigationItem({ id: "x", label: "Y", capability: "c" }),
    ).toBeNull();
    expect(
      parseMobileV2NavigationItem({ label: "Y", href: "/h", capability: "c" }),
    ).toBeNull();
  });

  test("rejects empty / whitespace strings as missing", () => {
    expect(
      parseMobileV2NavigationItem({ id: " ", label: "Y", href: "/h", capability: "c" }),
    ).toBeNull();
  });

  test("unknown icon names degrade to null (not throw)", () => {
    const out = parseMobileV2NavigationItem({
      id: "x",
      label: "Y",
      href: "/h",
      capability: "c",
      icon: "imaginary-icon",
    });
    expect(out?.icon).toBeNull();
  });

  test("non-record input returns null", () => {
    expect(parseMobileV2NavigationItem(null)).toBeNull();
    expect(parseMobileV2NavigationItem("string")).toBeNull();
    expect(parseMobileV2NavigationItem(["array"])).toBeNull();
    expect(parseMobileV2NavigationItem(42)).toBeNull();
  });

  test("default_home defaults to false when not present or non-boolean", () => {
    const out = parseMobileV2NavigationItem({
      id: "x",
      label: "Y",
      href: "/h",
      capability: "c",
      default_home: "true",
    });
    expect(out?.defaultHome).toBe(false);
  });

  test("roles array filters out empty / non-string entries; empty result becomes null", () => {
    const out = parseMobileV2NavigationItem({
      id: "x",
      label: "Y",
      href: "/h",
      capability: "c",
      roles: ["", null, "loader", 5],
    });
    expect(out?.roles).toEqual(["loader"]);
    const noneValid = parseMobileV2NavigationItem({
      id: "x",
      label: "Y",
      href: "/h",
      capability: "c",
      roles: ["", null],
    });
    expect(noneValid?.roles).toBeNull();
  });
});

describe("parseMobileV2NavigationSection", () => {
  test("parses a section with valid items", () => {
    const out = parseMobileV2NavigationSection({
      id: "tools",
      label: "Tools",
      items: [
        { id: "a", label: "A", href: "/a", capability: "c1" },
        { id: "b", label: "B", href: "/b", capability: "c2" },
      ],
    });
    expect(out?.id).toBe("tools");
    expect(out?.items).toHaveLength(2);
  });

  test("filters out malformed items but keeps valid ones", () => {
    const out = parseMobileV2NavigationSection({
      id: "tools",
      label: "Tools",
      items: [
        { id: "a", label: "A", href: "/a", capability: "c1" },
        { id: "b" }, // malformed — missing fields
        null,
      ],
    });
    expect(out?.items).toHaveLength(1);
  });

  test("returns null when section id or label missing", () => {
    expect(parseMobileV2NavigationSection({ items: [] })).toBeNull();
    expect(parseMobileV2NavigationSection({ id: "x" })).toBeNull();
  });
});

describe("parseMobileV2NavigationPayload", () => {
  test("parses the full payload shape", () => {
    const sections = parseMobileV2NavigationPayload(FULL_PAYLOAD);
    expect(sections.map((s) => s.id)).toEqual(["tools", "v2-home", "v2-network-ops"]);
    expect(sections[0]?.items).toHaveLength(2);
  });

  test("parses the backend-gated ui_navigation_v1 envelope shape", () => {
    const sections = parseMobileV2NavigationPayload({
      app: "mobile",
      sections: [
        {
          id: "v2-network-ops",
          label: "Network",
          items: [
            {
              id: "mobile-wallet",
              label: "Wallet",
              href: "/mobile/wallet",
              capability: "wallet.read",
              disabled_reason: "missing_capability",
            },
          ],
        },
      ],
    });
    expect(sections).toHaveLength(1);
    expect(sections[0]?.items[0]?.disabledReason).toBe("missing_capability");
  });

  test("returns empty array when payload is malformed at root", () => {
    expect(parseMobileV2NavigationPayload(null)).toEqual([]);
    expect(parseMobileV2NavigationPayload({})).toEqual([]);
    expect(parseMobileV2NavigationPayload({ apps: null })).toEqual([]);
    expect(parseMobileV2NavigationPayload({ apps: { mobile: null } })).toEqual([]);
    expect(parseMobileV2NavigationPayload({ apps: { mobile: { sections: "oops" } } })).toEqual([]);
  });

  test("filters out malformed sections at any level", () => {
    const sections = parseMobileV2NavigationPayload({
      apps: {
        mobile: {
          sections: [
            { id: "ok", label: "OK", items: [{ id: "x", label: "X", href: "/x", capability: "c" }] },
            null,
            { id: "no-label" },
            "string-instead-of-section",
          ],
        },
      },
    });
    expect(sections).toHaveLength(1);
    expect(sections[0]?.id).toBe("ok");
  });
});

describe("isMobileV2ItemVisible", () => {
  const sections = parseMobileV2NavigationPayload(FULL_PAYLOAD);
  const tasks = findMobileV2ItemById(sections, "mobile-tasks");
  const loaderHome = findMobileV2ItemById(sections, "mobile-loader-today");
  const riderHome = findMobileV2ItemById(sections, "mobile-rider-today");
  const pickups = findMobileV2ItemById(sections, "mobile-pickups");

  test("driver sees tasks (no roles filter, has cap)", () => {
    expect(isMobileV2ItemVisible(tasks!, DRIVER_CTX)).toBe(true);
  });

  test("driver does NOT see loader-today (roles filter excludes driver)", () => {
    // driver lacks loader.home.read cap AND is not in roles
    expect(isMobileV2ItemVisible(loaderHome!, DRIVER_CTX)).toBe(false);
  });

  test("loader sees loader-today (role match + cap match)", () => {
    expect(isMobileV2ItemVisible(loaderHome!, LOADER_CTX)).toBe(true);
  });

  test("loader does NOT see rider-today (role mismatch even when cap matched)", () => {
    const ctx: MobileV2NavigationContext = {
      activeRole: "loader",
      capabilities: ["tasks.read", "rider.home.read", "loader.home.read"],
    };
    expect(isMobileV2ItemVisible(riderHome!, ctx)).toBe(false);
  });

  test("supervisor with wildcard cap '*' sees every item that doesn't role-filter them out", () => {
    expect(isMobileV2ItemVisible(tasks!, SUPERVISOR_CTX)).toBe(true);
    expect(isMobileV2ItemVisible(pickups!, SUPERVISOR_CTX)).toBe(true);
    expect(isMobileV2ItemVisible(loaderHome!, SUPERVISOR_CTX)).toBe(false);
  });

  test("user without the required cap is denied even if role would match", () => {
    const noCap: MobileV2NavigationContext = {
      activeRole: "driver",
      capabilities: [],
    };
    expect(isMobileV2ItemVisible(tasks!, noCap)).toBe(false);
  });

  test("backend-disabled items remain hidden even when the capability is otherwise present", () => {
    const disabledWallet = parseMobileV2NavigationItem({
      id: "mobile-wallet",
      label: "Wallet",
      href: "/mobile/wallet",
      capability: "wallet.read",
      disabled_reason: { reason: "missing_capability", capability: "wallet.read" },
    });
    expect(
      isMobileV2ItemVisible(disabledWallet!, {
        activeRole: "driver",
        capabilities: ["wallet.read"],
      }),
    ).toBe(false);
  });
});

describe("filterMobileV2Navigation", () => {
  const sections = parseMobileV2NavigationPayload(FULL_PAYLOAD);

  test("driver gets v2-home (tasks only) + tools + network-ops", () => {
    const filtered = filterMobileV2Navigation(sections, DRIVER_CTX);
    const ids = filtered.map((s) => s.id);
    expect(ids).toContain("v2-home");
    expect(ids).toContain("tools");
    expect(ids).toContain("v2-network-ops");
    const home = filtered.find((s) => s.id === "v2-home");
    expect(home?.items.map((i) => i.id)).toEqual(["mobile-tasks"]);
  });

  test("loader gets v2-home with tasks + loader-today (no rider-today)", () => {
    const filtered = filterMobileV2Navigation(sections, LOADER_CTX);
    const home = filtered.find((s) => s.id === "v2-home");
    const ids = home?.items.map((i) => i.id) ?? [];
    expect(ids).toContain("mobile-tasks");
    expect(ids).toContain("mobile-loader-today");
    expect(ids).not.toContain("mobile-rider-today");
  });

  test("supervisor (wildcard) sees everything except role-filtered homes for other roles", () => {
    const filtered = filterMobileV2Navigation(sections, SUPERVISOR_CTX);
    const home = filtered.find((s) => s.id === "v2-home");
    expect(home?.items.map((i) => i.id)).toEqual(["mobile-tasks"]);
    // network ops fully visible
    expect(filtered.find((s) => s.id === "v2-network-ops")?.items).toHaveLength(2);
  });

  test("sections with zero visible items are dropped", () => {
    const noCap: MobileV2NavigationContext = {
      activeRole: "driver",
      capabilities: [],
    };
    const filtered = filterMobileV2Navigation(sections, noCap);
    expect(filtered).toHaveLength(0);
  });
});

describe("findMobileV2DefaultHome", () => {
  const sections = parseMobileV2NavigationPayload(FULL_PAYLOAD);

  test("returns mobile-tasks for any role with tasks.read", () => {
    expect(findMobileV2DefaultHome(sections, DRIVER_CTX)?.id).toBe("mobile-tasks");
    expect(findMobileV2DefaultHome(sections, LOADER_CTX)?.id).toBe("mobile-tasks");
    expect(findMobileV2DefaultHome(sections, SUPERVISOR_CTX)?.id).toBe("mobile-tasks");
  });

  test("returns null when user has no cap for the default item", () => {
    const noCap: MobileV2NavigationContext = { activeRole: "driver", capabilities: [] };
    expect(findMobileV2DefaultHome(sections, noCap)).toBeNull();
  });

  test("returns null when payload has no default_home items", () => {
    const sectionsNoDefault = parseMobileV2NavigationPayload({
      apps: {
        mobile: {
          sections: [
            {
              id: "tools",
              label: "Tools",
              items: [{ id: "x", label: "X", href: "/x", capability: "c" }],
            },
          ],
        },
      },
    });
    const ctx: MobileV2NavigationContext = { activeRole: "driver", capabilities: ["c"] };
    expect(findMobileV2DefaultHome(sectionsNoDefault, ctx)).toBeNull();
  });
});

describe("flattenMobileV2Navigation / findMobileV2ItemById", () => {
  const sections = parseMobileV2NavigationPayload(FULL_PAYLOAD);

  test("flatten returns every item across sections", () => {
    expect(flattenMobileV2Navigation(sections).map((i) => i.id)).toEqual([
      "mobile-outbox",
      "mobile-scan",
      "mobile-tasks",
      "mobile-loader-today",
      "mobile-rider-today",
      "mobile-pickups",
      "mobile-trips",
    ]);
  });

  test("findMobileV2ItemById hits and misses cleanly", () => {
    expect(findMobileV2ItemById(sections, "mobile-tasks")?.href).toBe("/mobile/tasks");
    expect(findMobileV2ItemById(sections, "mobile-not-real")).toBeNull();
  });
});

describe("collectMobileV2Capabilities", () => {
  const sections = parseMobileV2NavigationPayload(FULL_PAYLOAD);

  test("unions the distinct capability keys across the resolved payload", () => {
    const caps = collectMobileV2Capabilities(sections);
    // The fixture payload carries tasks.read (×2 — deduped),
    // scan_events.write, loader.home.read, rider.home.read, plus the
    // pickups/trips caps.
    expect(caps).toEqual(
      expect.arrayContaining([
        "tasks.read",
        "scan_events.write",
        "loader.home.read",
        "rider.home.read",
      ]),
    );
    // Deduped — tasks.read appears once even though two items use it.
    expect(caps.filter((c) => c === "tasks.read")).toHaveLength(1);
  });

  test("an empty payload yields an empty capability set", () => {
    expect(collectMobileV2Capabilities([])).toEqual([]);
  });

  test("does not report capabilities from backend-denied rows", () => {
    const sections = parseMobileV2NavigationPayload({
      app: "mobile",
      sections: [
        {
          id: "v2-network-ops",
          label: "Network",
          items: [
            { id: "mobile-tasks", label: "Tasks", href: "/mobile/tasks", capability: "tasks.read" },
            {
              id: "mobile-cash-drop",
              label: "Cash Drop",
              href: "/mobile/cash-drop",
              capability: "cash_drop.write",
              disabled_reason: "missing_capability",
            },
            {
              id: "mobile-wallet",
              label: "Wallet",
              href: "/mobile/wallet",
              capability: "wallet.read",
              disabled_reason: { reason: "missing_capability", capability: "wallet.read" },
            },
          ],
        },
      ],
    });
    expect(collectMobileV2Capabilities(sections)).toEqual(["tasks.read"]);
  });

  test("can be recomputed after active-role filtering so More does not display inactive-role capabilities", () => {
    const filtered = filterMobileV2Navigation(sections, DRIVER_CTX);
    const caps = collectMobileV2Capabilities(filtered);
    expect(caps).toEqual(
      expect.arrayContaining(["tasks.read", "scan_events.write", "pickups.read", "trips.read"]),
    );
    expect(caps).not.toContain("loader.home.read");
    expect(caps).not.toContain("rider.home.read");
  });
});

describe("hasMobileV2Capability", () => {
  test("honors explicit capabilities and wildcard grants", () => {
    expect(hasMobileV2Capability(["tasks.read"], "tasks.read")).toBe(true);
    expect(hasMobileV2Capability(["*"], "wallet.read")).toBe(true);
  });

  test("returns false for capabilities hidden by backend-denied navigation rows", () => {
    const sections = parseMobileV2NavigationPayload({
      app: "mobile",
      sections: [
        {
          id: "v2-network-ops",
          label: "Network",
          items: [
            { id: "mobile-tasks", label: "Tasks", href: "/mobile/tasks", capability: "tasks.read" },
            {
              id: "mobile-wallet",
              label: "Wallet",
              href: "/mobile/wallet",
              capability: "wallet.read",
              disabled_reason: "missing_capability",
            },
          ],
        },
      ],
    });
    const visible = filterMobileV2Navigation(sections, {
      activeRole: "driver",
      capabilities: collectMobileV2Capabilities(sections),
    });
    const visibleCapabilities = collectMobileV2Capabilities(visible);

    expect(hasMobileV2Capability(visibleCapabilities, "tasks.read")).toBe(true);
    expect(hasMobileV2Capability(visibleCapabilities, "wallet.read")).toBe(false);
  });
});
