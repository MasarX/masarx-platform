import { test, expect } from "@playwright/test";
import { createE2EDatabasePool } from "./utils/db";
import { fetchLookupCategories } from "./utils/lookup";
import { fetchResourcesWithMetadata } from "./utils/coverage-routes";
import { fetchNavigationSections, flattenNavigationItems } from "./utils/navigation";
import {
  fetchWorkflowBindings,
  fetchActiveTemplates,
} from "./utils/workflow-discovery";
import { fetchScopeLadder } from "./utils/scope-discovery";

test.describe("configuration validation", () => {
  test("every lookup category has at least 1 active value", async () => {
    const categories = await fetchLookupCategories();
    expect(
      categories.length,
      "Expected at least one lookup category in the system",
    ).toBeGreaterThan(0);

    const empty = categories.filter((c) => c.valueCount === 0);
    expect(
      empty,
      `Lookup categories with zero active values: ${empty.map((c) => c.category).join(", ")}`,
    ).toHaveLength(0);
  });

  test("every registered resource has valid table reference", async () => {
    const resources = await fetchResourcesWithMetadata();
    expect(
      resources.length,
      "Expected at least one resource in the read registry",
    ).toBeGreaterThan(0);

    for (const resource of resources) {
      expect(
        resource.key,
        `Resource entry missing a key`,
      ).toBeTruthy();

      // Each resource must expose at least one filterable column or an id column
      const hasStructure =
        resource.idColumn ||
        resource.filters.length > 0 ||
        resource.capabilities.read;
      expect(
        hasStructure,
        `Resource "${resource.key}" has no id column, filters, or read capability`,
      ).toBeTruthy();
    }
  });

  test("every navigation item has valid href", async () => {
    const apps = ["console", "portal"] as const;

    for (const app of apps) {
      const sections = await fetchNavigationSections(app);
      const items = sections.flatMap((s) =>
        flattenNavigationItems(s.items ?? []),
      );

      for (const item of items) {
        if (!item.href) continue;
        expect(
          item.href.startsWith("/"),
          `Navigation item "${item.label ?? item.id}" in ${app} has invalid href: "${item.href}" (must start with "/")`,
        ).toBe(true);
      }
    }
  });

  test("every active workflow binding references an existing template", async () => {
    const bindings = await fetchWorkflowBindings();
    const templates = await fetchActiveTemplates();

    const templateNames = new Set(templates.map((t) => t.name));

    const orphaned = bindings.filter(
      (b) => b.enabled && Boolean(b.templateName) && !templateNames.has(b.templateName ?? ""),
    );
    expect(
      orphaned,
      `Workflow bindings reference missing templates: ${orphaned.map((b) => `${b.businessAction}/${b.stage} -> ${b.templateName}`).join(", ")}`,
    ).toHaveLength(0);
  });

  test("scope ladder has a global entry and ascending ranks", async () => {
    const ladder = await fetchScopeLadder();
    expect(
      ladder.length,
      "Scope ladder must have at least one entry",
    ).toBeGreaterThan(0);

    // Must include a global scope type
    const globalEntry = ladder.find((l) => l.scopeType === "global");
    expect(
      globalEntry,
      "Scope ladder must include a 'global' scope type",
    ).toBeTruthy();

    // Ranks must be strictly ascending
    for (let i = 1; i < ladder.length; i++) {
      expect(
        ladder[i].ladderRank,
        `Scope ladder rank at index ${i} ("${ladder[i].scopeType}": ${ladder[i].ladderRank}) must be greater than index ${i - 1} ("${ladder[i - 1].scopeType}": ${ladder[i - 1].ladderRank})`,
      ).toBeGreaterThan(ladder[i - 1].ladderRank);
    }
  });

  test("schema registry has active versions", async () => {
    const { pool } = await createE2EDatabasePool("config-validation:schema-registry");
    try {
      const res = await pool.query(
        `SELECT COUNT(*)::int AS cnt
           FROM schema_registry
          WHERE is_active = true`,
      );
      const count = res.rows[0]?.cnt ?? 0;
      expect(
        count,
        "Expected at least one active entry in schema_registry",
      ).toBeGreaterThan(0);
    } finally {
      await pool.end();
    }
  });

  test("filter operators exist", async () => {
    const { pool } = await createE2EDatabasePool("config-validation:filter-operators");
    try {
      const res = await pool.query(
        `SELECT cached_value
           FROM settings
          WHERE category = 'ui_filter_operators'
            AND scope_type = 'global'
            AND scope_id IS NULL
          LIMIT 1`,
      );
      const value = res.rows[0]?.cached_value;
      expect(value, "No global ui_filter_operators settings row found").toBeTruthy();

      const operators = Array.isArray(value?.operators) ? value.operators : [];
      expect(
        operators.length,
        "ui_filter_operators must define at least one operator",
      ).toBeGreaterThan(0);
    } finally {
      await pool.end();
    }
  });

  test("pagination sizes are non-empty", async () => {
    const { pool } = await createE2EDatabasePool("config-validation:pagination");
    try {
      const res = await pool.query(
        `SELECT cached_value
           FROM settings
          WHERE category = 'ui_pagination'
            AND scope_type = 'global'
            AND scope_id IS NULL
          LIMIT 1`,
      );
      const value = res.rows[0]?.cached_value;
      expect(value, "No global ui_pagination settings row found").toBeTruthy();

      const allowedSizes = Array.isArray(value?.allowed_sizes)
        ? value.allowed_sizes
        : [];
      expect(
        allowedSizes.length,
        "ui_pagination allowed_sizes must be a non-empty array",
      ).toBeGreaterThan(0);
    } finally {
      await pool.end();
    }
  });

  test("dashboard config has valid constraints", async () => {
    const { pool } = await createE2EDatabasePool("config-validation:dashboard");
    try {
      const res = await pool.query(
        `SELECT cached_value
           FROM settings
          WHERE category = 'ui_dashboard_config'
            AND scope_type = 'global'
            AND scope_id IS NULL
          LIMIT 1`,
      );
      const value = res.rows[0]?.cached_value;
      expect(
        value,
        "No global ui_dashboard_config settings row found",
      ).toBeTruthy();

      const maxMetrics =
        typeof value?.max_metrics === "number" ? value.max_metrics : 0;
      expect(
        maxMetrics,
        "ui_dashboard_config max_metrics must be greater than 0",
      ).toBeGreaterThan(0);
    } finally {
      await pool.end();
    }
  });
});
