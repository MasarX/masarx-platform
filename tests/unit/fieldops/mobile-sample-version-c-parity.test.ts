import * as fs from "node:fs";
import * as path from "node:path";
import * as vm from "node:vm";

import {
  parseMobileRouteFromHref,
  resolveMobileResourceSurface,
} from "../../../apps/fieldops/src/mobile-shell-navigation";
import {
  normalizeMobileAddressPolicy,
  normalizeMobileCommunicationPolicy,
  normalizeMobileDiagnosticsPolicy,
  normalizeMobileMapPolicy,
  normalizeMobileVisibilityPolicy,
} from "../../../apps/fieldops/src/mobile-shell-policy";

type SampleModuleEntry = {
  key?: string;
};

type SampleConfig = {
  settingsRows?: Array<{
    category?: string;
    value?: unknown;
  }>;
  shell?: {
    modulesByRole?: Record<string, SampleModuleEntry[]>;
  };
};

function loadSampleConfig(): SampleConfig {
  const sourcePath = path.join(
    process.cwd(),
    "docs",
    "product",
    "examples",
    "mobile-field-ops-ui",
    "configs.js"
  );
  const source = fs.readFileSync(sourcePath, "utf8");
  const sandbox: { globalThis: Record<string, unknown> } = { globalThis: {} };
  vm.createContext(sandbox);
  vm.runInContext(source, sandbox);
  const configs = sandbox.globalThis.MX_FIELDOPS_SAMPLE_CONFIGS as Record<string, unknown> | undefined;
  if (!configs || typeof configs !== "object") {
    throw new Error("Sample configs script did not expose MX_FIELDOPS_SAMPLE_CONFIGS.");
  }
  return (configs.versionC as SampleConfig | undefined) ?? {};
}

function toHrefForModule(key: string): string {
  const mobileScreens = new Set([
    "outbox",
    "scan",
    "location",
    "diagnostics",
    "more",
    "route",
    "settlements",
  ]);
  if (mobileScreens.has(key)) return `/mobile/${key}`;
  return `/resources/${key}`;
}

describe("mobile version C sample parity contract", () => {
  const sample = loadSampleConfig();

  test("supports module navigation keys used by sample version C", () => {
    const modulesByRole = sample.shell?.modulesByRole ?? {};
    const keys = Array.from(
      new Set(
        Object.values(modulesByRole)
          .flatMap((entries) => entries)
          .map((entry) => String(entry?.key ?? "").trim().toLowerCase())
          .filter(Boolean)
      )
    );

    expect(keys).toEqual(
      expect.arrayContaining(["tasks", "route", "scan", "settlements", "more", "inventory", "baskets"])
    );

    for (const key of keys) {
      const parsed = parseMobileRouteFromHref(toHrefForModule(key));
      expect(parsed).not.toBeNull();
      if (key === "route") {
        expect(resolveMobileResourceSurface(parsed!)).toEqual({ kind: "route", resource: "tasks" });
      } else if (key === "settlements") {
        expect(resolveMobileResourceSurface(parsed!)).toEqual({
          kind: "settlements",
          resource: "settlements",
        });
      }
    }
  });

  test("normalizers accept sample version C policy payload shapes", () => {
    const rows = sample.settingsRows ?? [];
    const byCategory = new Map<string, unknown>();
    for (const row of rows) {
      const category = String(row?.category ?? "").trim();
      if (!category || byCategory.has(category)) continue;
      byCategory.set(category, row?.value ?? null);
    }

    const visibility = normalizeMobileVisibilityPolicy(byCategory.get("mobile_visibility_policy"));
    expect(visibility.allowedVisibility.length).toBeGreaterThan(0);

    const map = normalizeMobileMapPolicy(byCategory.get("map_policy"));
    expect(map.routeViews).toEqual(expect.arrayContaining(["list", "orders_map"]));

    const communication = normalizeMobileCommunicationPolicy(byCategory.get("communication_policy"));
    expect(communication.templates.length).toBeGreaterThan(0);

    const address = normalizeMobileAddressPolicy(byCategory.get("address_policy"));
    expect(address.fields.length).toBeGreaterThan(0);

    const diagnostics = normalizeMobileDiagnosticsPolicy(byCategory.get("mobile_diagnostics_policy"));
    expect(diagnostics.enabled).toBe(true);
  });
});
