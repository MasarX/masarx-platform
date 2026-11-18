import {
  parseMobileV2NavigationPayload,
  type MobileV2NavigationContext,
} from "../../../apps/fieldops/src/mobile-v2-navigation";
import {
  MOBILE_V2_TOAST_DEFAULT_DURATION_MS,
  composeDrawer,
  resolveAppBarLeadIcon,
  resolveBottomTabs,
  resolveSyncBannerState,
  resolveToastDuration,
} from "../../../apps/fieldops/src/mobile-v2-shell-helpers";

const PAYLOAD = {
  apps: {
    mobile: {
      sections: [
        {
          id: "tools",
          label: "Tools",
          items: [
            { id: "mobile-route", label: "Route", href: "/mobile/route", capability: "tasks.read" },
            { id: "mobile-more", label: "More", href: "/mobile/more", capability: "tasks.read" },
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
              default_home: true,
            },
            {
              id: "mobile-loader-today",
              label: "Loader Home",
              href: "/mobile/loader-today",
              capability: "loader.home.read",
              roles: ["loader"],
            },
            {
              id: "mobile-rider-today",
              label: "Rider Home",
              href: "/mobile/rider-today",
              capability: "rider.home.read",
              roles: ["rider"],
            },
            {
              id: "mobile-supervisor-today",
              label: "Supervisor Home",
              href: "/mobile/supervisor-today",
              capability: "supervisor.home.read",
              roles: ["supervisor"],
            },
          ],
        },
        {
          id: "v2-network-ops",
          label: "Network",
          items: [
            { id: "mobile-pickups", label: "Pickups", href: "/mobile/pickups", capability: "pickups.read" },
            { id: "mobile-trips", label: "Trips", href: "/mobile/trips", capability: "trips.read" },
            { id: "mobile-eor", label: "End Route", href: "/mobile/eor", capability: "tasks.complete" },
            { id: "mobile-sortation", label: "Sortation", href: "/mobile/sortation", capability: "sortation.read" },
            { id: "mobile-hub-pickup", label: "Hub Pickup", href: "/mobile/hub-pickup", capability: "hub_pickup.read" },
          ],
        },
      ],
    },
  },
};

const SECTIONS = parseMobileV2NavigationPayload(PAYLOAD);

const DRIVER_CTX: MobileV2NavigationContext = {
  activeRole: "driver",
  capabilities: ["tasks.read", "tasks.complete", "pickups.read", "trips.read"],
};
const LOADER_CTX: MobileV2NavigationContext = {
  activeRole: "loader",
  capabilities: ["tasks.read", "loader.home.read", "sortation.read", "trips.read"],
};
const SUPERVISOR_CTX: MobileV2NavigationContext = {
  activeRole: "supervisor",
  capabilities: ["*"],
};

describe("resolveAppBarLeadIcon", () => {
  test("arrow-left when onBack is set (regardless of onMenu)", () => {
    expect(resolveAppBarLeadIcon({ hasOnBack: true, hasOnMenu: false })).toBe("arrow-left");
    expect(resolveAppBarLeadIcon({ hasOnBack: true, hasOnMenu: true })).toBe("arrow-left");
  });

  test("menu when onBack is absent and onMenu is set", () => {
    expect(resolveAppBarLeadIcon({ hasOnBack: false, hasOnMenu: true })).toBe("menu");
  });

  test("null when neither callback is set", () => {
    expect(resolveAppBarLeadIcon({ hasOnBack: false, hasOnMenu: false })).toBeNull();
  });
});

describe("resolveSyncBannerState", () => {
  test("hidden when queue is empty", () => {
    const state = resolveSyncBannerState({ online: true, syncing: false, queueCount: 0 });
    expect(state.visible).toBe(false);
    expect(state.label).toBe("");
  });

  test("syncing tone takes priority over offline when both true", () => {
    const state = resolveSyncBannerState({ online: false, syncing: true, queueCount: 5 });
    expect(state.visible).toBe(true);
    expect(state.kind).toBe("syncing");
    expect(state.label).toContain("Syncing 5");
  });

  test("offline tone with N pending label when offline and not syncing", () => {
    const state = resolveSyncBannerState({ online: false, syncing: false, queueCount: 3 });
    expect(state.visible).toBe(true);
    expect(state.kind).toBe("offline");
    expect(state.label).toContain("3 pending");
    expect(state.label).toContain("offline");
  });

  test("online but not syncing with queue: shows pending sync prompt", () => {
    const state = resolveSyncBannerState({ online: true, syncing: false, queueCount: 2 });
    expect(state.visible).toBe(true);
    expect(state.kind).toBe("offline");
    expect(state.label).toContain("2 pending");
    expect(state.label).toContain("sync");
  });

  test("singular vs plural label", () => {
    const single = resolveSyncBannerState({ online: false, syncing: false, queueCount: 1 });
    expect(single.label).toContain("1 pending");
    expect(single.label).not.toMatch(/^[0-9]+s/);
  });

  test("clamps negative or fractional queue counts to a non-negative integer", () => {
    expect(resolveSyncBannerState({ online: false, syncing: false, queueCount: -5 }).visible).toBe(false);
    expect(resolveSyncBannerState({ online: false, syncing: false, queueCount: 2.7 }).count).toBe(2);
  });
});

describe("resolveBottomTabs", () => {
  test("driver tabs prioritize route closeout", () => {
    const filtered = SECTIONS.map((s) => ({
      ...s,
      items: s.items.filter((i) => {
        if (i.roles !== null && !i.roles.includes("driver")) return false;
        return DRIVER_CTX.capabilities.includes(i.capability);
      }),
    })).filter((s) => s.items.length > 0);
    const sel = resolveBottomTabs({ visibleSections: filtered, activeRole: "driver" });
    const ids = sel.tabs.map((t) => t.id);
    expect(ids[0]).toBe("mobile-tasks");
    expect(ids).toContain("mobile-route");
    expect(ids).toContain("mobile-eor");
    expect(ids).toContain("mobile-more");
    expect(sel.tabs.length).toBeLessThanOrEqual(5);
  });

  test("loader tabs include loader-today and sortation", () => {
    const filtered = SECTIONS.map((s) => ({
      ...s,
      items: s.items.filter((i) => {
        if (i.roles !== null && !i.roles.includes("loader")) return false;
        return LOADER_CTX.capabilities.includes(i.capability);
      }),
    })).filter((s) => s.items.length > 0);
    const sel = resolveBottomTabs({ visibleSections: filtered, activeRole: "loader" });
    const ids = sel.tabs.map((t) => t.id);
    expect(ids).toContain("mobile-tasks");
    expect(ids).toContain("mobile-loader-today");
    expect(ids).toContain("mobile-sortation");
  });

  test("supervisor tabs include supervisor-today and hub-pickup", () => {
    const filtered = SECTIONS.map((s) => ({
      ...s,
      items: s.items.filter((i) => {
        if (i.roles !== null && !i.roles.includes("supervisor")) return false;
        return true; // supervisor wildcard cap
      }),
    })).filter((s) => s.items.length > 0);
    const sel = resolveBottomTabs({ visibleSections: filtered, activeRole: "supervisor" });
    const ids = sel.tabs.map((t) => t.id);
    expect(ids).toContain("mobile-tasks");
    expect(ids).toContain("mobile-supervisor-today");
    expect(ids).toContain("mobile-hub-pickup");
  });

  test("never duplicates an item", () => {
    const sel = resolveBottomTabs({ visibleSections: SECTIONS, activeRole: "driver" });
    const ids = sel.tabs.map((t) => t.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  test("respects custom maxTabs budget", () => {
    const sel = resolveBottomTabs({ visibleSections: SECTIONS, activeRole: "driver", maxTabs: 3 });
    expect(sel.tabs.length).toBeLessThanOrEqual(3);
  });

  test("backfills from remaining items when role preference is short", () => {
    const sel = resolveBottomTabs({
      visibleSections: SECTIONS,
      activeRole: "rider",
      maxTabs: 5,
    });
    expect(sel.tabs.length).toBeGreaterThan(0);
    expect(sel.tabs.some((t) => t.id === "mobile-tasks")).toBe(true);
  });

  test("unknown role falls back to default preference (tasks first)", () => {
    const sel = resolveBottomTabs({
      visibleSections: SECTIONS,
      activeRole: "unknown-role-xyz",
    });
    expect(sel.tabs[0]?.id).toBe("mobile-tasks");
  });
});

describe("composeDrawer", () => {
  test("driver drawer surfaces tasks as default home + filtered sections", () => {
    const result = composeDrawer({ allSections: SECTIONS, context: DRIVER_CTX });
    expect(result.defaultHome?.id).toBe("mobile-tasks");
    expect(result.sections.map((s) => s.id)).toContain("v2-home");
    const home = result.sections.find((s) => s.id === "v2-home");
    expect(home?.items.map((i) => i.id)).toEqual(["mobile-tasks"]);
  });

  test("supervisor drawer includes supervisor-today only (not other role homes)", () => {
    const result = composeDrawer({ allSections: SECTIONS, context: SUPERVISOR_CTX });
    const home = result.sections.find((s) => s.id === "v2-home");
    const ids = home?.items.map((i) => i.id) ?? [];
    expect(ids).toContain("mobile-tasks");
    expect(ids).not.toContain("mobile-loader-today");
    expect(ids).not.toContain("mobile-rider-today");
  });

  test("user with no caps gets empty drawer", () => {
    const result = composeDrawer({
      allSections: SECTIONS,
      context: { activeRole: "driver", capabilities: [] },
    });
    expect(result.defaultHome).toBeNull();
    expect(result.sections).toHaveLength(0);
  });
});

describe("resolveToastDuration", () => {
  test("default duration matches design source 2200 ms", () => {
    expect(resolveToastDuration({})).toBe(MOBILE_V2_TOAST_DEFAULT_DURATION_MS);
    expect(MOBILE_V2_TOAST_DEFAULT_DURATION_MS).toBe(2200);
  });

  test("danger toasts linger slightly longer", () => {
    expect(resolveToastDuration({ kind: "danger" })).toBeGreaterThan(
      MOBILE_V2_TOAST_DEFAULT_DURATION_MS,
    );
  });

  test("explicit positive durationMs wins", () => {
    expect(resolveToastDuration({ durationMs: 5000 })).toBe(5000);
  });

  test("non-positive durationMs falls back to default", () => {
    expect(resolveToastDuration({ durationMs: 0 })).toBe(MOBILE_V2_TOAST_DEFAULT_DURATION_MS);
    expect(resolveToastDuration({ durationMs: -500 })).toBe(MOBILE_V2_TOAST_DEFAULT_DURATION_MS);
  });
});
