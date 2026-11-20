import type { UiNavigation, UiNavigationItem } from "@masarx/api";

/** Pure stack capability preserved from F414; no native gesture wiring is implied. */
export type NavigationStackFrame = {
  key: string;
  title?: string | null;
  params?: Record<string, unknown> | null;
  transient?: boolean;
};
export type NavigationState = { stack: NavigationStackFrame[]; canGoBack: boolean };
export type NavigationAction =
  | { type: "PUSH" | "REPLACE"; frame: NavigationStackFrame }
  | { type: "POP" }
  | { type: "RESET"; stack: NavigationStackFrame[] };

function copyNavigationFrame(frame: NavigationStackFrame): NavigationStackFrame {
  return {
    key: frame.key,
    title: frame.title ?? null,
    params: frame.params ? { ...frame.params } : null,
    transient: frame.transient === true,
  };
}

export function createNavigationState(frame: NavigationStackFrame): NavigationState {
  return { stack: [{ ...copyNavigationFrame(frame), transient: false }], canGoBack: false };
}

export function navigationReducer(
  state: NavigationState,
  action: NavigationAction
): NavigationState {
  let stack = state.stack.map(copyNavigationFrame);
  switch (action.type) {
    case "PUSH":
      stack.push(copyNavigationFrame(action.frame));
      break;
    case "POP":
      if (stack.length > 1) stack.pop();
      break;
    case "RESET":
      if (Array.isArray(action.stack) && action.stack.length > 0) {
        stack = action.stack.map(copyNavigationFrame);
        stack[0].transient = false;
      }
      break;
    case "REPLACE":
      stack[Math.max(0, stack.length - 1)] = copyNavigationFrame(action.frame);
      break;
  }
  return { stack, canGoBack: stack.length > 1 };
}

export function peekActiveFrame(state: NavigationState): NavigationStackFrame | null {
  return state.stack[state.stack.length - 1] ?? null;
}

export type GestureProgress = {
  dx: number;
  dy: number;
  velocityX: number;
  velocityY: number;
};
export type InterpretSwipeOptions = {
  containerWidth: number;
  edgeThresholdPct?: number;
  velocityThreshold?: number;
};
export type GestureOutcome = "commit_back" | "cancel" | "open_drawer" | "none";

/** Horizontal intent only: thresholds are configurable; callers own dispatch and animation. */
export function interpretSwipeGesture(
  progress: GestureProgress,
  options: InterpretSwipeOptions
): GestureOutcome {
  const width = Number.isFinite(options.containerWidth) ? Math.max(0, options.containerWidth) : 0;
  const percent = typeof options.edgeThresholdPct === "number" && Number.isFinite(options.edgeThresholdPct)
    ? Math.max(0, Math.min(1, options.edgeThresholdPct)) : 0.35;
  const velocityThreshold = typeof options.velocityThreshold === "number" && Number.isFinite(options.velocityThreshold)
    ? Math.max(0, options.velocityThreshold) : 0.5;
  const dx = Number.isFinite(progress.dx) ? progress.dx : 0;
  const dy = Number.isFinite(progress.dy) ? progress.dy : 0;
  const vx = Number.isFinite(progress.velocityX) ? progress.velocityX : 0;
  if (width <= 0 || Math.abs(dx) <= Math.abs(dy)) return "none";
  if (dx > 0) return dx > width * percent && vx > 0 ? "commit_back" : "cancel";
  return Math.abs(dx) > width * percent && vx < -velocityThreshold ? "open_drawer" : "none";
}

export type MobileScreenId =
  | "tasks"
  | "outbox"
  | "scan"
  | "location"
  | "diagnostics"
  | "more"
  | "route"
  | "settlements";

export type MobileRoute =
  | { kind: "home" }
  | { kind: "resource"; resource: string }
  | { kind: "screen"; screen: MobileScreenId }
  | { kind: "unknown"; href: string };

export type MobileResourceSurface =
  | { kind: "resource"; resource: string }
  | { kind: "route"; resource: "tasks" }
  | { kind: "settlements"; resource: "settlements" };

export function findFirstEnabledNavItem(
  items: UiNavigationItem[] | null | undefined
): UiNavigationItem | null {
  if (!Array.isArray(items)) return null;
  for (const item of items) {
    if (item.disabled_reason) continue;
    const route = resolveNavigationRouteFromItem(item);
    if (route.kind !== "home" && route.kind !== "unknown") return item;
    const nested = findFirstEnabledNavItem(item.items);
    if (nested) return nested;
  }
  return null;
}

export function findNavItemById(
  items: UiNavigationItem[] | null | undefined,
  id: string | null
): UiNavigationItem | null {
  if (!id || !Array.isArray(items)) return null;
  for (const item of items) {
    if (item.id === id) return item;
    const nested = findNavItemById(item.items, id);
    if (nested) return nested;
  }
  return null;
}

export function resolveInitialSelectedNavItemId(
  sections: UiNavigation["sections"] | null | undefined,
  selectedId: string | null,
  preferredHref?: string | null
): string | null {
  if (!Array.isArray(sections) || sections.length === 0) return null;

  if (selectedId) {
    for (const section of sections) {
      const existing = findNavItemById(section.items, selectedId);
      if (existing) return selectedId;
    }
  }

  const preferredId = resolveNavItemIdByHref(sections, preferredHref);
  if (preferredId) return preferredId;

  for (const section of sections) {
    const candidate = findFirstEnabledNavItem(section.items);
    if (candidate?.id) return candidate.id;
  }

  return null;
}

export function resolveNavItemIdByHref(
  sections: UiNavigation["sections"] | null | undefined,
  href: string | null | undefined,
): string | null {
  if (!Array.isArray(sections) || typeof href !== "string" || !href.trim()) return null;
  const route = parseMobileRouteFromHref(href);
  if (!route) return null;
  for (const section of sections) {
    const item = findFirstEnabledNavItemByRoute(section.items, route);
    if (item?.id) return item.id;
  }
  return null;
}

function isMobileScreenId(value: string): value is MobileScreenId {
  return (
    value === "tasks" ||
    value === "outbox" ||
    value === "scan" ||
    value === "location" ||
    value === "diagnostics" ||
    value === "more" ||
    value === "route" ||
    value === "settlements"
  );
}

function parsePathToMobileRoute(path: string): MobileRoute | null {
  const normalizedPath = path.startsWith("/") ? path : `/${path}`;

  const resourceMatch = normalizedPath.match(/(?:^|\/)resources\/([^/]+)\/?$/i);
  if (resourceMatch) {
    const resource = decodeURIComponent(resourceMatch[1] ?? "").trim();
    return resource ? { kind: "resource", resource } : null;
  }

  const mobileMatch = normalizedPath.match(/(?:^|\/)mobile\/([^/]+)\/?$/i);
  if (mobileMatch) {
    const screen = decodeURIComponent(mobileMatch[1] ?? "").trim().toLowerCase();
    if (!isMobileScreenId(screen)) return null;
    return { kind: "screen", screen };
  }

  const directScreenMatch = normalizedPath.match(
    /(?:^|\/)(tasks|outbox|scan|location|diagnostics|more|route|settlements)\/?$/i
  );
  if (!directScreenMatch) return null;

  const screen = decodeURIComponent(directScreenMatch[1] ?? "").trim().toLowerCase();
  if (!isMobileScreenId(screen)) return null;
  return { kind: "screen", screen };
}

function findFirstEnabledNavItemByRoute(
  items: UiNavigationItem[] | null | undefined,
  route: MobileRoute
): UiNavigationItem | null {
  if (!Array.isArray(items)) return null;
  for (const item of items) {
    if (!item.disabled_reason) {
      const itemRoute = resolveNavigationRouteFromItem(item);
      if (routesMatch(itemRoute, route)) return item;
    }
    const nested = findFirstEnabledNavItemByRoute(item.items, route);
    if (nested) return nested;
  }
  return null;
}

function routesMatch(left: MobileRoute, right: MobileRoute) {
  if (left.kind !== right.kind) return false;
  if (left.kind === "screen" && right.kind === "screen") {
    return left.screen === right.screen;
  }
  if (left.kind === "resource" && right.kind === "resource") {
    return left.resource.trim().toLowerCase() === right.resource.trim().toLowerCase();
  }
  return false;
}

function resolveNavigationRouteFromItem(item: UiNavigationItem | null): MobileRoute {
  if (!item) return { kind: "home" };
  const resource =
    typeof item.resource === "string" && item.resource.trim()
      ? item.resource.trim()
      : null;
  if (resource) return { kind: "resource", resource };
  const href = typeof item.href === "string" && item.href.trim() ? item.href.trim() : null;
  if (!href) return { kind: "home" };
  return parseMobileRouteFromHref(href) ?? { kind: "unknown", href };
}

export function parseMobileRouteFromHref(href: string): MobileRoute | null {
  const trimmed = href.trim();
  if (!trimmed) return null;

  const [noHash] = trimmed.split("#");
  const [maybePath] = noHash.split("?");
  if (maybePath) {
    const parsedPath = parsePathToMobileRoute(maybePath);
    if (parsedPath) return parsedPath;
  }

  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed)) {
    try {
      const url = new URL(trimmed);
      const parsedPath = parsePathToMobileRoute(url.pathname || "/");
      if (parsedPath) return parsedPath;
    } catch {
      // Ignore malformed URLs and continue to other route formats.
    }
  }

  const schemeMatch = trimmed.match(/^mobile:([^/]+)$/i);
  if (!schemeMatch) return null;
  const screen = decodeURIComponent(schemeMatch[1] ?? "").trim().toLowerCase();
  if (!isMobileScreenId(screen)) return null;
  return { kind: "screen", screen };
}

export function resolveMobileResourceSurface(
  route: MobileRoute
): MobileResourceSurface | null {
  if (route.kind === "resource") {
    return { kind: "resource", resource: route.resource };
  }
  if (route.kind === "screen" && route.screen === "tasks") {
    return { kind: "resource", resource: "tasks" };
  }
  if (route.kind === "screen" && route.screen === "route") {
    return { kind: "route", resource: "tasks" };
  }
  if (route.kind === "screen" && route.screen === "settlements") {
    return { kind: "settlements", resource: "settlements" };
  }
  return null;
}
