import * as fs from "node:fs";
import * as path from "node:path";

const REPO_ROOT = path.resolve(__dirname, "../..");
const APP_DEFINITIONS = [
  { appName: "console", appDir: path.join(REPO_ROOT, "apps/console/app") },
  { appName: "portal", appDir: path.join(REPO_ROOT, "apps/portal/app") },
];

const MATRIX_DOC_PATH = path.join(
  REPO_ROOT,
  "docs/product/ux/console-portal-page-matrix.md"
);
const MATRIX_ROUTE_LINE_MARKER = "|";
const MATRIX_CONSOLE_PREFIX = "/console";
const MATRIX_PORTAL_PREFIX = "/portal";
const MATRIX_CONSOLE_SECTION = "## Console route matrix";
const MATRIX_PORTAL_SECTION = "## Portal route matrix";
const ROUTE_FILE_NAMES = new Set(["page.tsx", "route.ts"]);
const LANDING_HTML_PATH = path.join(REPO_ROOT, "docs/marketing/landing-v2/index.html");
const MATRIX_ROUTE_ALIASES = new Map<string, string>([
  ["/console/labels/designer", "/console/platform/labels"],
]);

const normalizeRoutePath = (route: string) =>
  route.trim().replace(/\/+$/, "") || "/";

const normalizeDynamicSegment = (segment: string) => {
  const optionalCatchAllMatch = segment.match(/^\[\[\.\.\.(.+)\]\]$/);
  if (optionalCatchAllMatch?.[1]) {
    return `:${optionalCatchAllMatch[1]}*`;
  }

  const catchAllMatch = segment.match(/^\[\.\.\.(.+)\]$/);
  if (catchAllMatch?.[1]) {
    return `:${catchAllMatch[1]}*`;
  }

  const dynamicMatch = segment.match(/^\[(.+)\]$/);
  if (dynamicMatch?.[1]) {
    return `:${dynamicMatch[1]}`;
  }

  return segment;
};

const toPublicRoute = (
  relativePath: string,
  appName: string,
  isRouteFile: boolean
) => {
  const withoutExt = relativePath
    .replace(/\\/g, "/")
    .replace(/(^|\/)(page|route)\.tsx?$/, "");
  const rawSegments = withoutExt.split("/").filter(Boolean);

  const routeSegments = rawSegments
    .filter((segment) => !/^\(.*\)$/.test(segment))
    .map(normalizeDynamicSegment);

  const baseRoute = `/${appName}${
    routeSegments.length > 0 ? `/${routeSegments.join("/")}` : ""
  }`;
  if (isRouteFile) {
    return normalizeRoutePath(baseRoute);
  }

  return normalizeRoutePath(baseRoute || `/${appName}`);
};

const collectAppRoutes = ({
  appName,
  appDir,
}: (typeof APP_DEFINITIONS)[number]) => {
  const routeFiles: string[] = [];

  const walk = (dir: string) => {
    const entries = fs.readdirSync(dir, { withFileTypes: true });

    for (const entry of entries) {
      if (entry.name.startsWith(".")) {
        continue;
      }

      const entryPath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(entryPath);
        continue;
      }

      if (!ROUTE_FILE_NAMES.has(entry.name)) {
        continue;
      }

      if (!entry.name.endsWith(".tsx") && !entry.name.endsWith(".ts")) {
        continue;
      }

      const relativePath = path.relative(appDir, entryPath);
      const route = toPublicRoute(relativePath, appName, entry.name === "route.ts");
      routeFiles.push(route);
    }
  };

  walk(appDir);
  return routeFiles;
};

const collectLandingMatrixAnchors = () => {
  const rawDoc = fs.readFileSync(MATRIX_DOC_PATH, "utf8");
  const sectionMarker = "Primary sections";
  const anchorLine = rawDoc
    .split(/\r?\n/)
    .find((line) => line.startsWith("| Primary sections"));

  if (!anchorLine) {
    return [];
  }

  const anchorMatches = Array.from(
    anchorLine.matchAll(/#([a-zA-Z0-9_-]+)/g),
    (match) => match[1]
  );
  const inMatrixSection =
    sectionMarker && rawDoc.includes(sectionMarker) && anchorLine.includes("`");

  if (!inMatrixSection) {
    return [];
  }

  return anchorMatches;
};

const collectLandingHtmlAnchors = () => {
  const rawHtml = fs.readFileSync(LANDING_HTML_PATH, "utf8");
  const matches = rawHtml.match(/id=\"([^\"]+)\"/g) ?? [];
  return matches.map((entry) => entry.replace(/id=\"|\"/g, ""));
};

const collectMatrixRoutes = () => {
  const rawDoc = fs.readFileSync(MATRIX_DOC_PATH, "utf8");
  const routes = new Set<string>();
  let activePrefix = "";
  let inTable = false;

  for (const line of rawDoc.split(/\r?\n/)) {
    if (line.startsWith("## ")) {
      if (line === MATRIX_CONSOLE_SECTION) {
        activePrefix = MATRIX_CONSOLE_PREFIX;
      } else if (line === MATRIX_PORTAL_SECTION) {
        activePrefix = MATRIX_PORTAL_PREFIX;
      } else {
        activePrefix = "";
      }
      inTable = false;
      continue;
    }

    if (!line.startsWith(MATRIX_ROUTE_LINE_MARKER)) {
      continue;
    }
    if (line.includes("---")) {
      inTable = true;
      continue;
    }
    if (!inTable) {
      continue;
    }

    const cells = line.split("|").map((cell) => cell.trim());
    if (cells.length < 3) {
      continue;
    }

    const routeCell = cells[2];
    if (!routeCell.startsWith("`")) {
      continue;
    }

    const routeMatch = routeCell.match(/`([^`]+)`/);
    if (!routeMatch?.[1]) {
      continue;
    }

    if (!activePrefix) continue;
    const routeValue = normalizeRoutePath(routeMatch[1].split("?")[0]);
    const routeWithPrefix =
      routeValue === "/"
        ? activePrefix
        : normalizeRoutePath(`${activePrefix}${routeValue}`);
    routes.add(routeWithPrefix);
  }

  return routes;
};

describe("frontend route inventory and phase-0 matrix parity", () => {
  test("all implemented console and portal routes are present in the matrix document", () => {
    const matrixRoutes = collectMatrixRoutes();
    const implementedRoutes = APP_DEFINITIONS.flatMap((appDef) =>
      collectAppRoutes(appDef)
    );

    const missingRoutes = Array.from(new Set(implementedRoutes)).filter((route) => {
      const canonicalRoute = MATRIX_ROUTE_ALIASES.get(route);
      return !matrixRoutes.has(route) && !(canonicalRoute && matrixRoutes.has(canonicalRoute));
    });

    expect(missingRoutes).toEqual([]);
  });

  test("matrix surface routes exist in app route files", () => {
    const matrixRoutes = collectMatrixRoutes();
    const implementedRoutes = new Set(
      APP_DEFINITIONS.flatMap((appDef) =>
        collectAppRoutes(appDef)
      )
    );
    const missingAppRoutes = Array.from(matrixRoutes).filter((route) => {
      if (implementedRoutes.has(route)) {
        return false;
      }
      return !Array.from(MATRIX_ROUTE_ALIASES.entries()).some(
        ([aliasRoute, canonicalRoute]) =>
          canonicalRoute === route && implementedRoutes.has(aliasRoute)
      );
    });

    expect(missingAppRoutes).toEqual([]);
  });

  test("landing section anchors in matrix map to landing markup IDs", () => {
    const matrixAnchors = collectLandingMatrixAnchors();
    const landingAnchors = new Set(collectLandingHtmlAnchors());
    const missingLandingAnchors = matrixAnchors.filter(
      (anchor) => !landingAnchors.has(anchor)
    );

    expect(missingLandingAnchors).toEqual([]);
  });
});
