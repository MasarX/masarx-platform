import fs from "fs";
import path from "path";
import { resolveSafeAppBasePath } from "../../../packages/ui/src/url-guard";
import { createE2EDatabasePool } from "./db";
import {
  fetchResourceSampleField,
  fetchResourceSampleId,
} from "./core-resource";
import {
  extractResourceRoutes,
  fetchNavigationSections,
  flattenNavigationItems,
} from "./navigation";
import { fetchUserContext } from "./role-matrix";

type AppName = "console" | "portal";

const ROUTE_PARAM_DEFAULTS: Record<string, string> = {
  correlation_id: "00000000-0000-0000-0000-000000000000",
  event_id: "00000000-0000-0000-0000-000000000000",
  run_id: "00000000-0000-0000-0000-000000000000",
  template_id: "00000000-0000-0000-0000-000000000000",
};

const STATE_SUFFIXES = [
  "ready",
  "error",
  "auth-required",
  "blocked",
  "not-found",
];

type CoverageBuildOptions = {
  email?: string;
  password?: string;
};

type CoverageParamResolver = {
  type: "id" | "field";
  resourceKey: string;
  fieldCandidates?: string[];
};

const FOCUSED_DYNAMIC_TEMPLATES: Record<AppName, Set<string>> = {
  console: new Set([
    "/integrations/plugins/:plugin_id",
    "/integrations/plugins/:plugin_id/versions/:version",
    "/observability/domain-events/:event_id",
    "/observability/trace/:correlation_id",
    "/observability/workflow-runs/:run_id",
    "/workflows/queue/:task_id",
    "/workflows/runs/:run_id",
    "/workflows/templates/:template_id",
  ]),
  portal: new Set([
    "/observability/trace/:correlation_id",
    "/workflows/queue/:task_id",
    "/workflows/runs/:run_id",
    "/workflows/templates/:template_id",
  ]),
};

const PARAM_RESOLVERS: Record<string, CoverageParamResolver> = {
  plugin_id: { type: "id", resourceKey: "integration_plugins" },
  version: {
    type: "field",
    resourceKey: "integration_plugin_versions",
    fieldCandidates: ["version_no", "version", "id"],
  },
  event_id: { type: "id", resourceKey: "domain_events" },
  correlation_id: {
    type: "field",
    resourceKey: "workflow_runs",
    fieldCandidates: ["correlation_id", "triggered_by_request_id", "request_id"],
  },
  run_id: { type: "id", resourceKey: "workflow_runs" },
  task_id: { type: "id", resourceKey: "manual_review_tasks" },
  template_id: { type: "id", resourceKey: "workflow_templates" },
};

const cache = new Map<string, string[]>();
let readRegistryCache: string[] | null = null;

function normalizeBasePath(basePath: string) {
  return resolveSafeAppBasePath(basePath) ?? "";
}

function normalizeRoute(app: AppName, route: string, basePath: string) {
  if (!route) return route;
  const normalizedBase = normalizeBasePath(basePath);
  let normalizedRoute = route.startsWith("/") ? route : `/${route}`;
  if (!normalizedBase) {
    const appPrefix = `/${app}`;
    if (
      normalizedRoute === appPrefix ||
      normalizedRoute.startsWith(`${appPrefix}/`)
    ) {
      normalizedRoute = normalizedRoute.slice(appPrefix.length) || "/";
    }
    return normalizedRoute;
  }
  const doublePrefix = `${normalizedBase}${normalizedBase}`;
  if (normalizedRoute.startsWith(doublePrefix)) {
    return normalizedRoute.replace(doublePrefix, normalizedBase);
  }
  return normalizedRoute;
}

function listPageFiles(app: AppName) {
  const appDir = path.join(process.cwd(), "apps", app, "app");
  if (!fs.existsSync(appDir)) return [];
  const out: string[] = [];
  const stack = [appDir];
  while (stack.length) {
    const current = stack.pop();
    if (!current) continue;
    const entries = fs.readdirSync(current, { withFileTypes: true });
    for (const entry of entries) {
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) {
        stack.push(full);
        continue;
      }
      if (entry.isFile() && entry.name === "page.tsx") {
        out.push(full);
      }
    }
  }
  return out;
}

function isRouteGroup(segment: string) {
  return segment.startsWith("(") && segment.endsWith(")");
}

function toRouteTemplate(app: AppName, filePath: string) {
  const appDir = path.join(process.cwd(), "apps", app, "app");
  const rel = path.relative(appDir, filePath);
  const segments = rel.split(path.sep).filter(Boolean);
  const routeSegments: string[] = [];
  for (const segment of segments) {
    if (segment === "page.tsx") continue;
    if (isRouteGroup(segment)) continue;
    if (segment.startsWith("[") && segment.endsWith("]")) {
      routeSegments.push(`:${segment.slice(1, -1)}`);
      continue;
    }
    routeSegments.push(segment);
  }
  if (routeSegments.length === 0) return "/";
  return `/${routeSegments.join("/")}`;
}

function extractResourceKeys(registry: unknown): string[] {
  if (!registry || typeof registry !== "object") return [];
  const raw = registry as { resources?: unknown };
  const resources = raw.resources;
  if (Array.isArray(resources)) {
    return resources
      .map((entry) => {
        if (!entry || typeof entry !== "object") return "";
        const obj = entry as Record<string, unknown>;
        return String(obj.key || obj.resource_key || obj.id || "").trim();
      })
      .filter(Boolean);
  }
  if (resources && typeof resources === "object") {
    return Object.keys(resources);
  }
  return [];
}

async function fetchReadRegistryResources() {
  if (readRegistryCache) return readRegistryCache;
  const { pool } = await createE2EDatabasePool("coverage-routes:read-registry");
  try {
    const res = await pool.query("SELECT ui_read_registry_v1() AS registry");
    const registry = res.rows[0]?.registry;
    const keys = extractResourceKeys(registry);
    readRegistryCache = keys;
    return keys;
  } finally {
    await pool.end();
  }
}

function getCacheKey(app: AppName, basePath: string, options: CoverageBuildOptions) {
  return JSON.stringify({
    app,
    basePath: normalizeBasePath(basePath),
    email: options.email?.trim().toLowerCase() ?? "",
  });
}

async function resolveParamValue(
  param: string,
  options: CoverageBuildOptions
): Promise<string | null> {
  const resolver = PARAM_RESOLVERS[param];
  if (!resolver) {
    return ROUTE_PARAM_DEFAULTS[param] ?? null;
  }
  if (!options.email || !options.password) {
    return ROUTE_PARAM_DEFAULTS[param] ?? null;
  }

  if (resolver.type === "id") {
    const sample = await fetchResourceSampleId({
      resourceKey: resolver.resourceKey,
      email: options.email,
      password: options.password,
    });
    return sample.id;
  }

  const sample = await fetchResourceSampleField({
    resourceKey: resolver.resourceKey,
    fieldCandidates: resolver.fieldCandidates ?? [],
    email: options.email,
    password: options.password,
  });
  return sample.value;
}

async function expandTemplate(
  template: string,
  resources: string[],
  options: CoverageBuildOptions
) {
  const segments = template.split("/").filter(Boolean);
  let routes = [""];
  for (const segment of segments) {
    if (segment.startsWith(":")) {
      const param = segment.slice(1);
      const values =
        param === "resource"
          ? resources
          : (() => {
              const resolved = options.email && options.password
                ? null
                : ROUTE_PARAM_DEFAULTS[param] ?? "sample";
              return resolved ? [resolved] : [];
            })();
      let paramValues = values;
      if (param !== "resource" && options.email && options.password) {
        const resolvedValue = await resolveParamValue(param, options);
        paramValues = resolvedValue ? [resolvedValue] : [];
      }
      if (paramValues.length === 0) {
        return [];
      }
      routes = routes.flatMap((base) =>
        paramValues.map((value) => `${base}/${encodeURIComponent(value)}`)
      );
      continue;
    }
    routes = routes.map((base) => `${base}/${segment}`);
  }
  return routes.map((route) => (route === "" ? "/" : route));
}

export function buildPageStateSelector(prefix: string) {
  const selector = STATE_SUFFIXES.map(
    (suffix) => `[data-testid^="${prefix}-"][data-testid$="-${suffix}"]`
  ).join(", ");
  return selector;
}

export async function buildCoverageRoutes(
  app: AppName,
  basePath: string,
  options: CoverageBuildOptions = {}
) {
  const cacheKey = getCacheKey(app, basePath, options);
  if (cache.has(cacheKey)) return cache.get(cacheKey) ?? [];
  const pageFiles = listPageFiles(app);
  const templates = pageFiles
    .map((file) => toRouteTemplate(app, file))
    .filter((template) =>
      options.email && options.password
        ? !FOCUSED_DYNAMIC_TEMPLATES[app].has(template)
        : true
    );

  let resources = await fetchReadRegistryResources();
  let navSections = await fetchNavigationSections(app);
  if (options.email && options.password) {
    const context = await fetchUserContext({
      app,
      email: options.email,
      password: options.password,
    });
    const userResources = Array.isArray(context.readRegistry?.resources)
      ? context.readRegistry.resources
          .map((entry) => entry?.key?.trim() ?? "")
          .filter(Boolean)
      : [];
    const userSections = Array.isArray(context.navigation.sections)
      ? (context.navigation.sections as Parameters<typeof extractResourceRoutes>[0])
      : [];
    resources = userResources;
    navSections = userSections as Awaited<ReturnType<typeof fetchNavigationSections>>;
  }
  const navResources = extractResourceRoutes(navSections)
    .map((route) => route.resource)
    .filter((value): value is string => Boolean(value));
  const resourceKeys = Array.from(new Set([...resources, ...navResources]));
  const expanded = (
    await Promise.all(
      templates.map((template) => expandTemplate(template, resourceKeys, options))
    )
  ).flat();
  const navRoutes = navSections
    .flatMap((section) => flattenNavigationItems(section.items ?? []))
    .map((item) => item.href)
    .filter((href): href is string =>
      typeof href === "string" && /^\/(?!\/)/.test(href) &&
      !href.includes("\\") && !/[\x00-\x1f\x7f]/.test(href)
    );

  const normalized = new Set<string>();
  const normalizedBase = normalizeBasePath(basePath);
  for (const route of [...expanded, ...navRoutes]) {
    const normalizedRoute = normalizeRoute(app, route, normalizedBase);
    const withLeadingSlash = normalizedRoute.startsWith("/")
      ? normalizedRoute
      : `/${normalizedRoute}`;
    const full = normalizedBase && withLeadingSlash.startsWith(normalizedBase)
      ? withLeadingSlash
      : `${normalizedBase}${withLeadingSlash}`;
    normalized.add(full || normalizedBase || "/");
  }

  const routes = Array.from(normalized).sort();
  cache.set(cacheKey, routes);
  return routes;
}

export type ResourceFilter = {
  key: string | null;
  column: string | null;
  op: string | null;
};

export type ResourceWithMetadata = {
  key: string;
  label: string | null;
  idColumn: string | null;
  filters: ResourceFilter[];
  download: unknown;
  importConfig: unknown;
  capabilities: {
    read: string | null;
    write: string | null;
  };
};

let resourceMetadataCache: ResourceWithMetadata[] | null = null;

function normalizeResourceEntry(entry: unknown): ResourceWithMetadata | null {
  if (!entry || typeof entry !== "object") return null;
  const obj = entry as Record<string, unknown>;
  const key = String(obj.key || obj.resource_key || obj.id || "").trim();
  if (!key) return null;

  const rawFilters = Array.isArray(obj.filters) ? obj.filters : [];
  const filters: ResourceFilter[] = rawFilters
    .filter((f): f is Record<string, unknown> => Boolean(f && typeof f === "object"))
    .map((f) => ({
      key: typeof f.key === "string" ? f.key : null,
      column: typeof f.column === "string" ? f.column : null,
      op: typeof f.op === "string" ? f.op : null,
    }));

  return {
    key,
    label: typeof obj.label === "string" ? obj.label : null,
    idColumn: typeof obj.id_column === "string" ? obj.id_column : null,
    filters,
    download: obj.download ?? null,
    importConfig: obj.import ?? obj.import_config ?? null,
    capabilities: {
      read: typeof obj.capability_read === "string" ? obj.capability_read : null,
      write: typeof obj.capability_write === "string" ? obj.capability_write : null,
    },
  };
}

/**
 * Fetch all resources from the read registry with full metadata.
 * Unlike `fetchReadRegistryResources` (which returns only keys), this
 * exposes filters, import config, download config, and capability info.
 * Cached per-process.
 */
export async function fetchResourcesWithMetadata(): Promise<ResourceWithMetadata[]> {
  if (resourceMetadataCache) return resourceMetadataCache;

  const { pool } = await createE2EDatabasePool("coverage-routes:resource-metadata");
  try {
    const res = await pool.query("SELECT ui_read_registry_v1() AS registry");
    const registry = res.rows[0]?.registry;
    if (!registry || typeof registry !== "object") {
      resourceMetadataCache = [];
      return [];
    }
    const raw = registry as { resources?: unknown };
    const resources = Array.isArray(raw.resources) ? raw.resources : [];
    const entries = resources
      .map(normalizeResourceEntry)
      .filter((entry): entry is ResourceWithMetadata => entry !== null);
    resourceMetadataCache = entries;
    return entries;
  } finally {
    await pool.end();
  }
}
