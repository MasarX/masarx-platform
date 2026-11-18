import { test, expect } from "@playwright/test";
import { createE2EDatabasePool } from "./utils/db";
import { loadDemoContext } from "./utils/demo-accounts";
import { getConsoleBasePath } from "./utils/base-paths";
import { ensureSignedIn } from "./utils/session";
import { fetchWorkflowBindings } from "./utils/workflow-discovery";
import {
  captureRuntimeErrors,
  expectNoRuntimeErrors,
} from "./utils/runtime-errors";
import { assertNoAppErrorReload } from "./utils/error-guards";

/**
 * Wave 6A: Workflow Bindings Inventory
 *
 * Discovers all active workflow bindings through the same canonical
 * bindings RPC used by the shared page, then asserts the Console UI
 * surfaces every binding. Zero hardcoded values -- all data is dynamic.
 */

const demoContext = loadDemoContext();
const consoleBasePath = getConsoleBasePath();

function pickTenantUser() {
  return (
    demoContext.users.find((u) => u.scope_type === "tenant") ??
    demoContext.users.find((u) =>
      ["platform", "super_admin"].includes(u.user_type ?? ""),
    ) ??
    demoContext.users[0] ??
    null
  );
}

async function fetchWorkflowBindingInventoryRows() {
  const { pool } = await createE2EDatabasePool("workflow-bindings-inventory");
  try {
    const result = await pool.query(
      `SELECT binding_key, label
         FROM public.workflow_business_action_inventory_v1
        ORDER BY binding_key`,
    );
    return result.rows.map((row) => ({
      bindingKey: String(row.binding_key ?? "").trim(),
      label:
        typeof row.label === "string" && row.label.trim()
          ? row.label.trim()
          : null,
    }));
  } finally {
    await pool.end();
  }
}

test.describe("workflow bindings inventory", () => {
  test("DB bindings are surfaced in the console bindings workspace", async ({
    page,
  }) => {
    test.slow();

    if (!demoContext.available) {
      throw new Error(
        demoContext.reason ?? "Demo accounts missing for strict E2E.",
      );
    }

    const user = pickTenantUser();
    if (!user?.email || !demoContext.password) {
      throw new Error("No usable demo user for workflow bindings test.");
    }

    // --- Discovery: fetch bindings from DB ---
    const dbBindings = await fetchWorkflowBindings({
      email: user.email,
      password: demoContext.password,
    });
    const inventoryRows = await fetchWorkflowBindingInventoryRows();

    expect(dbBindings.length, "A seeded binding is required for the inventory comparison").toBeGreaterThan(0);

    const capture = captureRuntimeErrors(page, { allowOpaqueLocal503: true });
    try {
      // --- Sign in ---
      await ensureSignedIn({
        page,
        basePath: consoleBasePath,
        authTestId: "console-auth-required",
        email: user.email,
        password: demoContext.password,
        scopeType: user.scope_type ?? null,
      });

      // --- Navigate to bindings workspace ---
      await page.goto(`${consoleBasePath}/workflows/bindings`, {
        waitUntil: "domcontentloaded",
        timeout: 60_000,
      });

      // Wait for either the bindings table or an error marker
      const bindingsTable = page.locator(
        '[data-testid="console-workflow-bindings-bindings-table"]',
      );
      const inventoryTable = page.locator(
        '[data-testid="console-workflow-bindings-inventory"]',
      );
      const errorMarker = page.locator(
        '[data-testid="console-workflow-bindings-error"]',
      );

      // Activate the bindings tab if not already visible
      if (!(await bindingsTable.isVisible().catch(() => false))) {
        const bindingsTab = page.getByText("Bindings", { exact: true }).last();
        if (await bindingsTab.isVisible().catch(() => false)) {
          await bindingsTab.click();
        }
      }

      await expect(
        bindingsTable.or(errorMarker).first(),
      ).toBeVisible({ timeout: 30_000 });

      if (await errorMarker.isVisible().catch(() => false)) {
        const errorText =
          (await errorMarker.textContent().catch(() => null))?.trim() ??
          "Unknown workflow bindings error.";
        throw new Error(
          `Workflow bindings workspace rendered an error state: ${errorText}`,
        );
      }

      // --- Assert each binding's business_action appears in the UI ---
      const uniqueActions = [
        ...new Set(dbBindings.map((b) => b.businessAction).filter(Boolean)),
      ];
      const tableBody = bindingsTable.locator("tbody").first();

      for (const action of uniqueActions) {
        const cellWithAction = tableBody.getByText(action, { exact: false });
        expect(
          await cellWithAction.count(),
          `Binding business action "${action}" should appear in the bindings table`,
        ).toBeGreaterThan(0);
      }

      // --- Assert binding count matches DB count ---
      const uiRows = tableBody.locator("tr");
      const uiRowCount = await uiRows.count();
      expect(
        uiRowCount,
        `UI binding row count (${uiRowCount}) should match DB binding count (${dbBindings.length})`,
      ).toBe(dbBindings.length);

      // --- Activate and assert inventory tab ---
      if (!(await inventoryTable.isVisible().catch(() => false))) {
        const inventoryTab = page
          .getByText("Business action inventory", { exact: true })
          .first();
        if (await inventoryTab.isVisible().catch(() => false)) {
          await inventoryTab.click();
        }
      }
      await expect(inventoryTable).toBeVisible();
      {
        const inventoryCards = inventoryTable.locator(":scope > div");
        const inventoryCardCount = await inventoryCards.count();
        expect(
          inventoryCardCount,
          `Inventory card count (${inventoryCardCount}) should match DB inventory count (${inventoryRows.length})`,
        ).toBe(inventoryRows.length);

        for (const item of inventoryRows) {
          expect(
            await inventoryTable.getByText(item.bindingKey, { exact: false }).count(),
            `Inventory should surface business action key "${item.bindingKey}"`,
          ).toBeGreaterThan(0);
          if (item.label) {
            expect(
              await inventoryTable.getByText(item.label, { exact: false }).count(),
              `Inventory should surface business action label "${item.label}"`,
            ).toBeGreaterThan(0);
          }
        }

        expect(
          inventoryCardCount,
          "Inventory should surface at least one business action card",
        ).toBeGreaterThan(0);
      }

      await assertNoAppErrorReload(page);
    } finally {
      capture.dispose();
    }

    await expectNoRuntimeErrors(capture, {
      label: "workflow-bindings-inventory",
    });
  });
});
