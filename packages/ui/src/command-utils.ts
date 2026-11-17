import type { UiCommandDefinition } from "@masarx/api";
import {
  normalizeAppHref,
  normalizeBasePath,
  stripBasePath,
} from "./navigation-paths";
import { resolveSafeAppBasePath } from "./url-guard";

type CommandHrefLike = {
  href?: unknown;
};

type CommandRouteTarget = {
  path?: unknown;
  params?: unknown;
};

type CommandRouteTargets = Record<string, CommandRouteTarget | null> | null | undefined;

const normalizeCommandHref = (rawHref: string, basePath: string) => {
  const trimmed = rawHref.trim();
  if (!trimmed) return null;
  if (/^https?:\/\//i.test(trimmed)) return null;
  const safeBase = resolveSafeAppBasePath(basePath);
  const normalizedBase = safeBase === null ? "" : normalizeBasePath(safeBase);
  let path = trimmed.startsWith("/") ? trimmed : `/${trimmed}`;
  if (safeBase !== null && normalizedBase && !path.startsWith(normalizedBase)) {
    path = `${normalizedBase}${path}`;
  }
  const normalized = normalizeAppHref(path, safeBase ?? undefined);
  return normalized || path;
};

function appendParams(path: string, params: Record<string, unknown>) {
  const [base, rawQuery] = path.split("?");
  const search = new URLSearchParams(rawQuery ?? "");
  Object.entries(params).forEach(([key, value]) => {
    if (value === undefined || value === null) return;
    const str = String(value).trim();
    if (!str) return;
    search.set(key, str);
  });
  const query = search.toString();
  return query ? `${base}?${query}` : base;
}

function resolveRouteTarget(
  command: UiCommandDefinition,
  appBasePath: string,
  appKey?: string | null
) {
  const targets = (command as { route_targets?: CommandRouteTargets }).route_targets;
  if (!targets || typeof targets !== "object") return null;
  const resolvedKey = typeof appKey === "string" ? appKey.trim().toLowerCase() : "";
  if (!resolvedKey) return null;
  const target = targets[resolvedKey];
  if (!target || typeof target !== "object") return null;
  const rawPath = typeof target.path === "string" ? target.path : null;
  if (!rawPath) return null;
  const path = normalizeCommandHref(rawPath, appBasePath);
  if (!path) return null;
  const params =
    target.params && typeof target.params === "object"
      ? (target.params as Record<string, unknown>)
      : null;
  return params ? appendParams(path, params) : path;
}

export function resolveCommandHref(
  command: UiCommandDefinition,
  appBasePath: string,
  appKey?: string | null
) {
  const routeHref = resolveRouteTarget(command, appBasePath, appKey);
  if (routeHref) return routeHref;
  const candidate = (command as CommandHrefLike).href;
  if (typeof candidate !== "string") return null;
  return normalizeCommandHref(candidate, appBasePath);
}

export function resolveCommandHrefForRouter(
  command: UiCommandDefinition,
  appBasePath: string,
  appKey?: string | null
) {
  const href = resolveCommandHref(command, appBasePath, appKey);
  const safeBase = resolveSafeAppBasePath(appBasePath);
  return href ? stripBasePath(href, safeBase ?? undefined) : null;
}
