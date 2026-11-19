import {
  MOBILE_V2_TAB_FLOW_REFETCH_STALE_MS,
  resolveMobileV2ActiveTabOrDefault,
  resolveMobileV2NavigationTargetId,
  shouldRefetchMobileV2TabOnFocus,
  type MobileV2TabRoutingItem,
} from "../../../apps/fieldops/src/mobile-v2-tab-routing";

const item = (id: string, defaultHome = false): MobileV2TabRoutingItem => ({
  id,
  defaultHome,
});

describe("Mobile V2 passive tab refresh guard", () => {
  test("reuses fresh backend data for passive tab switches only", () => {
    expect(
      shouldRefetchMobileV2TabOnFocus({
        dataUpdatedAt: 1_000,
        now: 1_000 + MOBILE_V2_TAB_FLOW_REFETCH_STALE_MS - 1,
      }),
    ).toBe(false);
  });

  test("refetches when the passive tab cache is stale", () => {
    expect(
      shouldRefetchMobileV2TabOnFocus({
        dataUpdatedAt: 1_000,
        now: 1_000 + MOBILE_V2_TAB_FLOW_REFETCH_STALE_MS,
      }),
    ).toBe(true);
  });

  test("refetches when backend data predates a mutation or queued action", () => {
    expect(
      shouldRefetchMobileV2TabOnFocus({
        dataUpdatedAt: 1_000,
        lastRelevantMutationAt: 1_001,
        now: 1_002,
      }),
    ).toBe(true);
  });

  test("keeps same-context readback after mutation reconciliation", () => {
    expect(
      shouldRefetchMobileV2TabOnFocus({
        dataUpdatedAt: 2_000,
        lastRelevantMutationAt: 1_000,
        now: 2_001,
      }),
    ).toBe(false);
  });

  test("refetches when no backend readback has populated the tab", () => {
    expect(
      shouldRefetchMobileV2TabOnFocus({
        dataUpdatedAt: 0,
        now: 1_000,
      }),
    ).toBe(true);
  });
});

describe("resolveMobileV2ActiveTabOrDefault", () => {
  it("keeps visible navigation tabs active", () => {
    expect(
      resolveMobileV2ActiveTabOrDefault("mobile-route", [
        item("mobile-tasks", true),
        item("mobile-route"),
      ]),
    ).toBe("mobile-route");
  });

  it("keeps stop detail active when the Tasks root is visible", () => {
    expect(
      resolveMobileV2ActiveTabOrDefault("mobile-stop", [
        item("mobile-tasks", true),
        item("mobile-route"),
      ]),
    ).toBe("mobile-stop");
  });

  it("keeps the POD sub-flow active when a driver task root is visible", () => {
    expect(
      resolveMobileV2ActiveTabOrDefault("mobile-pod", [
        item("mobile-tasks", true),
        item("mobile-route"),
      ]),
    ).toBe("mobile-pod");
  });

  it("keeps pre-shift remediation active from the Today owner flow", () => {
    expect(
      resolveMobileV2ActiveTabOrDefault("mobile-cleaning", [
        item("mobile-today", true),
        item("mobile-tasks"),
      ]),
    ).toBe("mobile-cleaning");
  });

  it("falls back to the default home when a tab and its owner are unavailable", () => {
    expect(
      resolveMobileV2ActiveTabOrDefault("mobile-pod", [
        item("mobile-more"),
        item("mobile-outbox", true),
      ]),
    ).toBe("mobile-outbox");
  });
});

describe("resolveMobileV2NavigationTargetId", () => {
  it("normalizes legacy pre-shift drawer targets to the mounted Mobile V2 screen", () => {
    expect(
      resolveMobileV2NavigationTargetId({
        id: "pre-shift-gate",
        href: "/mobile/pre-shift",
        label: "Pre-Shift",
      }),
    ).toBe("mobile-pre-shift");
  });

  it("normalizes cleaning drawer targets to the mounted Mobile V2 screen", () => {
    expect(
      resolveMobileV2NavigationTargetId({
        id: "cleaning-check",
        href: "/mobile/cleaning",
        label: "Cleaning Check",
      }),
    ).toBe("mobile-cleaning");
  });

  it("normalizes KYC drawer targets to mounted Mobile V2 screens", () => {
    expect(
      resolveMobileV2NavigationTargetId({
        id: "kyc-docs",
        href: "/mobile/kyc-docs",
        label: "Identity Documents",
      }),
    ).toBe("mobile-kyc-id");
    expect(
      resolveMobileV2NavigationTargetId({
        id: "kyc-vehicle",
        href: "/mobile/kyc-vehicle",
        label: "Vehicle Registration",
      }),
    ).toBe("mobile-kyc-vehicle");
    expect(
      resolveMobileV2NavigationTargetId({
        id: "kyc-vehicle-photos",
        href: "/mobile/kyc-vehicle-photos",
        label: "Vehicle Photos",
      }),
    ).toBe("mobile-kyc-vehicle-photos");
  });

  it("normalizes settlement drawer targets to the mounted Mobile V2 screen", () => {
    expect(
      resolveMobileV2NavigationTargetId({
        id: "settlements",
        href: "/mobile/settlements",
        label: "Settlements",
      }),
    ).toBe("mobile-settlements");
  });
});
