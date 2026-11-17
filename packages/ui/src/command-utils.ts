import { matchesResourceCategory, type UiCommandDefinition, type UiReadRegistry } from "@masarx/api";
import { commandResourceReadAllowed } from "./dashboard-utils";
import {
  normalizeAppHref,
  normalizeBasePath,
  stripBasePath,
} from "./navigation-paths";
import { resolveBaseOrigin, resolveSafeAppBasePath, resolveSafeHref } from "./url-guard";

type CommandHrefLike = {
  href?: unknown;
};

type CommandRouteTarget = {
  path?: unknown;
  params?: unknown;
};

type CommandRouteTargets = Record<string, CommandRouteTarget | null> | null | undefined;

const normalizeCommandHref = (rawHref: string, basePath: string) => {
  const safePath = resolveSafeHref("", rawHref);
  if (!safePath) return null;
  const trimmed = rawHref.trim();
  if (!trimmed) return null;
  if (/^[a-z][a-z0-9+.-]*:/i.test(trimmed)) return null;
  const safeBase = resolveSafeAppBasePath(basePath);
  const normalizedBase = safeBase === null ? "" : normalizeBasePath(safeBase);
  let path = safePath;
  if (safeBase !== null && normalizedBase &&
      path !== normalizedBase && !path.startsWith(`${normalizedBase}/`) &&
      !path.startsWith(`${normalizedBase}?`) && !path.startsWith(`${normalizedBase}#`)) {
    path = `${normalizedBase}${path}`;
  }
  const normalized = normalizeAppHref(path, safeBase ?? undefined);
  return resolveSafeHref("", normalized || path);
};

function appendParams(path: string, params: Record<string, unknown>) {
  const url = new URL(path, resolveBaseOrigin());
  Object.entries(params).forEach(([key, value]) => {
    if (value === undefined || value === null) return;
    const str = String(value).trim();
    if (str) url.searchParams.set(key, str);
  });
  return `${url.pathname}${url.search}${url.hash}`;
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
  if (command.route_targets != null) return null;
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

export function formatCommandBackendReference(command: UiCommandDefinition) {
  return [
    command.workflow_key?.trim() ? `workflow:${command.workflow_key.trim()}` : null,
    command.binding_key?.trim()
      ? `binding:${command.binding_key.trim()}${command.stage_key?.trim() ? `/${command.stage_key.trim()}` : ""}`
      : null,
    command.execution?.rpc?.trim() ? `rpc:${command.execution.rpc.trim()}` : null,
  ].filter(Boolean).join(" | ");
}

export function resolveCommandReadState(
  command: UiCommandDefinition,
  registry: UiReadRegistry | null | undefined,
  capabilities: Set<string>,
): "allowed" | "denied" | "unavailable" {
  const category = command.schema_category?.trim();
  if (!category) return "allowed";
  if (!Array.isArray(registry?.resources)) return "unavailable";
  const resourceCommand = /^resource[:/.]/i.test(category) ||
    registry.resources.some((resource) => matchesResourceCategory(category, resource.key));
  if (!resourceCommand) return "allowed";
  return commandResourceReadAllowed(command, registry, capabilities) ? "allowed" : "denied";
}
