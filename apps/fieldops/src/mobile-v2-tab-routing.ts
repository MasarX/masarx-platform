export interface MobileV2TabRoutingItem {
  readonly id: string;
  readonly defaultHome?: boolean;
}

export interface MobileV2NavigationTargetInput {
  readonly id: string;
  readonly href?: string;
  readonly label?: string;
}

export const MOBILE_V2_TAB_FLOW_REFETCH_STALE_MS = 15_000;

export function shouldRefetchMobileV2TabOnFocus(input: {
  readonly dataUpdatedAt: number;
  readonly lastRelevantMutationAt?: number;
  readonly now: number;
  readonly staleMs?: number;
}): boolean {
  const staleMs = Math.max(0, input.staleMs ?? MOBILE_V2_TAB_FLOW_REFETCH_STALE_MS);
  if (!Number.isFinite(input.dataUpdatedAt) || input.dataUpdatedAt <= 0) return true;
  const lastRelevantMutationAt = input.lastRelevantMutationAt ?? 0;
  if (
    Number.isFinite(lastRelevantMutationAt) &&
    lastRelevantMutationAt > 0 &&
    input.dataUpdatedAt <= lastRelevantMutationAt
  ) {
    return true;
  }
  if (!Number.isFinite(input.now)) return true;
  return input.now - input.dataUpdatedAt >= staleMs;
}

export function resolveMobileV2NavigationTargetId(item: MobileV2NavigationTargetInput): string {
  const id = item.id.trim();
  const href = item.href?.trim() ?? "";
  const label = item.label?.trim().toLowerCase() ?? "";
  if (
    id === "mobile-pre-shift" ||
    id === "pre-shift" ||
    id === "pre-shift-gate" ||
    href === "/mobile/pre-shift" ||
    label === "pre-shift"
  ) {
    return "mobile-pre-shift";
  }
  if (
    id === "mobile-cleaning" ||
    id === "cleaning" ||
    id === "cleaning-check" ||
    href === "/mobile/cleaning" ||
    label === "cleaning check"
  ) {
    return "mobile-cleaning";
  }
  if (
    id === "mobile-kyc-id" ||
    id === "kyc-docs" ||
    id === "kyc-id" ||
    href === "/mobile/kyc-docs" ||
    href === "/mobile/kyc-id" ||
    label === "identity & documents" ||
    label === "identity documents"
  ) {
    return "mobile-kyc-id";
  }
  if (
    id === "mobile-kyc-vehicle" ||
    id === "kyc-vehicle" ||
    href === "/mobile/kyc-vehicle" ||
    label === "vehicle registration"
  ) {
    return "mobile-kyc-vehicle";
  }
  if (
    id === "mobile-kyc-vehicle-photos" ||
    id === "kyc-vehicle-photos" ||
    href === "/mobile/kyc-vehicle-photos" ||
    label === "vehicle photos"
  ) {
    return "mobile-kyc-vehicle-photos";
  }
  if (
    id === "mobile-settlements" ||
    id === "settlements" ||
    id === "settlement-ledger" ||
    href === "/mobile/settlements" ||
    label === "settlements"
  ) {
    return "mobile-settlements";
  }
  return id;
}

const DETAIL_TAB_ROOTS: Readonly<Record<string, ReadonlyArray<string>>> = Object.freeze({
  "mobile-stop": Object.freeze(["mobile-tasks", "mobile-route", "mobile-lookup", "mobile-today"]),
  "mobile-pod": Object.freeze(["mobile-tasks", "mobile-route"]),
  "mobile-map": Object.freeze(["mobile-route"]),
  "mobile-scan": Object.freeze(["mobile-tasks", "mobile-pickups", "mobile-returns", "mobile-hub-pickup"]),
  "mobile-loader-scan": Object.freeze(["mobile-loader-today"]),
  "mobile-pickup-detail": Object.freeze(["mobile-pickups"]),
  "mobile-trip-detail": Object.freeze(["mobile-trips"]),
  "mobile-trip-nav": Object.freeze(["mobile-trips"]),
  "mobile-pre-shift": Object.freeze(["mobile-today", "mobile-tasks"]),
  "mobile-cleaning": Object.freeze(["mobile-pre-shift", "mobile-today", "mobile-tasks"]),
  "mobile-kyc-id": Object.freeze(["mobile-pre-shift", "mobile-today", "mobile-tasks", "mobile-more"]),
  "mobile-kyc-vehicle": Object.freeze(["mobile-kyc-id", "mobile-pre-shift", "mobile-today", "mobile-tasks", "mobile-more"]),
  "mobile-kyc-vehicle-photos": Object.freeze(["mobile-kyc-vehicle", "mobile-pre-shift", "mobile-today", "mobile-tasks", "mobile-more"]),
});

export function resolveMobileV2ActiveTabOrDefault(
  activeTabId: string,
  visibleNavigationItems: ReadonlyArray<MobileV2TabRoutingItem>,
): string {
  if (visibleNavigationItems.length === 0) return activeTabId;

  const visibleIds = new Set(visibleNavigationItems.map((item) => item.id));
  if (visibleIds.has(activeTabId)) return activeTabId;

  const ownerIds = DETAIL_TAB_ROOTS[activeTabId] ?? [];
  if (ownerIds.some((ownerId) => visibleIds.has(ownerId))) {
    return activeTabId;
  }

  return (visibleNavigationItems.find((item) => item.defaultHome) ?? visibleNavigationItems[0]!).id;
}
