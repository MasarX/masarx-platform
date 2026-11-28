import * as fs from "fs";
import * as path from "path";
import { test, type Locator, type Page } from "@playwright/test";
import { isTruthy } from "./env";

const deterministicCss = `
  *,
  *::before,
  *::after {
    animation-duration: 0s !important;
    animation-delay: 0s !important;
    transition-duration: 0s !important;
    transition-delay: 0s !important;
    scroll-behavior: auto !important;
    caret-color: transparent !important;
  }
`;

function assertContained(parent: string, candidate: string) {
  const relative = path.relative(parent, candidate);
  if (
    !relative ||
    relative === ".." ||
    relative.startsWith(`..${path.sep}`) ||
    path.isAbsolute(relative)
  ) {
    throw new Error("e2e_evidence_path_outside_root");
  }
  return candidate;
}

function ensureDirectoryWithoutSymlinks(directory: string) {
  let current = path.parse(directory).root;
  const segments = path.relative(current, directory).split(path.sep).filter(Boolean);

  for (const segment of segments) {
    current = path.join(current, segment);
    try {
      fs.mkdirSync(current, { mode: 0o700 });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    }
    const stats = fs.lstatSync(current);
    if (stats.isSymbolicLink() || !stats.isDirectory()) {
      throw new Error("e2e_evidence_directory_parent_invalid");
    }
  }
}

async function stabilizePage(page: Page) {
  try {
    await page.addStyleTag({ content: deterministicCss });
  } catch {
    // Ignore style injection failures (e.g., navigation races).
  }
}

export function isCaptureEnabled() {
  return isTruthy(process.env.E2E_CAPTURE_UI);
}

export function resolveEvidenceDir(group: string) {
  const outputRoot = process.env.PLAYWRIGHT_TEST_OUTPUT_DIR?.trim();
  const evidenceRoot = outputRoot
    ? path.resolve(outputRoot, "screenshots")
    : path.join(
        process.cwd(),
        "docs",
        "ops",
        "evidence",
        new Date().toISOString().slice(0, 10),
      );
  return assertContained(evidenceRoot, path.resolve(evidenceRoot, group));
}

export function resolveEvidencePath(group: string, ...segments: string[]) {
  const evidenceDir = resolveEvidenceDir(group);
  const filePath = assertContained(
    evidenceDir,
    path.resolve(evidenceDir, ...segments),
  );
  ensureDirectoryWithoutSymlinks(path.dirname(filePath));
  try {
    if (fs.lstatSync(filePath).isSymbolicLink()) {
      throw new Error("e2e_evidence_output_symlink");
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  return filePath;
}

export async function captureFullPage(page: Page, filePath: string) {
  await stabilizePage(page);
  await page.screenshot({ path: filePath, fullPage: true });
}

export async function captureViewport(page: Page, filePath: string) {
  await stabilizePage(page);
  await page.screenshot({ path: filePath });
}

export async function focusWithTab(page: Page, locator: Locator, maxTabs = 60) {
  for (let attempt = 0; attempt < maxTabs; attempt += 1) {
    const isFocused = await locator.evaluate(
      (element) => element === document.activeElement
    );
    if (isFocused) return true;
    await page.keyboard.press("Tab");
  }
  return false;
}

const sweepRoles = new Set(Object.keys(require("../../../config/dev/sweep-roles.json")));

const routeKeys = new Map([
  ["/", "dashboard"],
  ["/operations/pickups/waves", "pickup-waves"],
  ["/operations/pickups/requests", "pickup-requests"],
  ["/operations/routes", "dispatch"],
]);

type RouteEvidenceOptions = {
  role: string;
  route: string;
  ledgerState?: "rows" | "empty";
};

type ViewportMeasurement = {
  viewportWidth: number;
  viewportHeight: number;
  x: number;
  y: number;
  width: number;
  height: number;
  ratio: number;
};

type EvidenceFailure = "BAD_ARGUMENT" | "NOT_IN_VIEW" | "MASK_MISSING" | "CAPTURE_FAILED";

class EvidenceError extends Error {
  constructor(code: EvidenceFailure) {
    super("EVIDENCE_FAILED/" + code);
  }
}

export function validateRouteEvidenceOptions(options: unknown): RouteEvidenceOptions {
  if (typeof options !== "object" || options === null) {
    throw new EvidenceError("BAD_ARGUMENT");
  }
  const { role, route, ledgerState } = options as Partial<Record<keyof RouteEvidenceOptions, unknown>>;
  const routeKey = typeof route === "string" ? routeKeys.get(route) : undefined;
  if (typeof role !== "string" || !sweepRoles.has(role) || !routeKey) {
    throw new EvidenceError("BAD_ARGUMENT");
  }
  if (routeKey === "pickup-waves" || routeKey === "pickup-requests") {
    if (ledgerState !== "rows" && ledgerState !== "empty") {
      throw new EvidenceError("BAD_ARGUMENT");
    }
    return { role, route: routeKey, ledgerState };
  }
  if ("ledgerState" in options) {
    throw new EvidenceError("BAD_ARGUMENT");
  }
  return { role, route: routeKey };
}

export function buildRouteEvidenceEntry(
  { role, route, ledgerState }: RouteEvidenceOptions,
  variant: string,
) {
  const fileVariant = encodeURIComponent(variant).replaceAll("*", "%2A");
  return {
    role,
    route,
    variant,
    ...(ledgerState === undefined ? {} : { ledgerState }),
    outcome: "CAPTURED",
    image: [role, route, fileVariant].join("-") + ".png",
  };
}

export function isFullyInView(box: ViewportMeasurement) {
  return (
    box.ratio === 1 &&
    box.width > 0 &&
    box.height > 0 &&
    box.x >= 0 &&
    box.y >= 0 &&
    box.x + box.width <= box.viewportWidth &&
    box.y + box.height <= box.viewportHeight
  );
}

function measureViewport(elements: Element[]) {
  const readMeasurement = (entry?: IntersectionObserverEntry): ViewportMeasurement => {
    const rect = entry?.boundingClientRect;
    return {
      viewportWidth: window.innerWidth,
      viewportHeight: window.innerHeight,
      x: rect?.x ?? 0,
      y: rect?.y ?? 0,
      width: rect?.width ?? 0,
      height: rect?.height ?? 0,
      ratio: entry?.intersectionRatio ?? 0,
    };
  };

  const [element] = elements;
  if (elements.length !== 1 || !element) return readMeasurement();

  element.scrollIntoView({ behavior: "instant", block: "nearest", inline: "nearest" });
  return new Promise<ViewportMeasurement>((resolve) => {
    // The observer's first sample includes clipping by all scrolling ancestors.
    const observer = new IntersectionObserver(([entry]) => {
      observer.disconnect();
      resolve(readMeasurement(entry));
    });
    observer.observe(element);
  });
}

export async function captureRouteEvidence(
  page: Page,
  assertedLocator: Locator,
  options: RouteEvidenceOptions,
) {
  try {
    const args = validateRouteEvidenceOptions(options);
    const info = test.info();
    const entry = buildRouteEvidenceEntry(args, info.project.name);
    const box = await assertedLocator.evaluateAll(measureViewport);
    if (!isFullyInView(box)) {
      console.log([box.viewportWidth, box.viewportHeight, box.x, box.y, box.width, box.height, box.ratio].join(" "));
      throw new EvidenceError("NOT_IN_VIEW");
    }

    const requiredMasks = ["context-identity"];
    if (args.route === "dashboard") requiredMasks.push("dashboard-identity");
    if (args.ledgerState === "rows") requiredMasks.push("record-id");
    const counts = await Promise.all(
      requiredMasks.map((name) => page.locator('[data-evidence-mask="' + name + '"]').count()),
    );
    if (counts.includes(0)) {
      throw new EvidenceError("MASK_MISSING");
    }

    const imagePath = info.outputPath(entry.image);
    await page.screenshot({
      path: imagePath,
      type: "png",
      fullPage: false,
      animations: "disabled",
      mask: [page.locator("[data-evidence-mask]")],
    });
    await info.attach("route-evidence-image", { path: imagePath, contentType: "image/png" });
    await info.attach("route-evidence-record", {
      body: JSON.stringify(entry),
      contentType: "application/json",
    });
  } catch (error) {
    throw error instanceof EvidenceError ? error : new EvidenceError("CAPTURE_FAILED");
  }
}
