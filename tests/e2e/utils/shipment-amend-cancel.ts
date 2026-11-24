import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { expect, type Page } from "@playwright/test";
import { Pool } from "pg";
import { getConsoleBasePath, getConsoleOrigin, getPortalBasePath, getPortalOrigin } from "./base-paths";
import { loadDemoContext, pickConsoleUser } from "./demo-accounts";
import { getDatabaseUrl, getSupabaseUrl } from "./env";
import { assertE2EMutationsAllowed } from "./mutations";
import { ensureSignedIn } from "./session";

type Surface = "console" | "portal";
type Operation = "modify" | "cancel";
type Fixtures = {
  shipments: {
    cancel_allowed: { id: string };
    cancel_window_blocked: { id: string };
  };
};

export async function exerciseShipmentChange(page: Page, surface: Surface, operation: Operation) {
  assertE2EMutationsAllowed({ label: "shipment-amend-cancel" });
  const databaseUrl = getDatabaseUrl();
  const appOrigin = surface === "portal" ? getPortalOrigin() : getConsoleOrigin();
  for (const url of [databaseUrl, getSupabaseUrl(), appOrigin]) {
    if (!["localhost", "127.0.0.1", "[::1]"].includes(new URL(url).hostname)) {
      throw new Error("Shipment browser fixtures require loopback app, Auth, and database targets.");
    }
  }
  const demo = loadDemoContext();
  const account = surface === "portal"
    ? demo.users.find((user) => user.scope_type === "tenant")
    : pickConsoleUser(demo);
  if (!account || !demo.password) throw new Error("Synthetic shipment test account is unavailable.");

  // The setup script prints a generated shipment manifest. Keep stdout and stderr off the CI log.
  let fixtures: Fixtures;
  try {
    fixtures = JSON.parse(execFileSync(process.execPath, ["scripts/qa/provision-shipment-amend-cancel-fixtures.js"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    })) as Fixtures;
  } catch {
    throw new Error("Synthetic shipment fixture provisioning failed.");
  }

  const basePath = surface === "portal" ? getPortalBasePath() : getConsoleBasePath();
  const prefix = `${surface}-shipment-amend-cancel`;
  await ensureSignedIn({
    page,
    basePath,
    authTestId: `${surface}-auth-required`,
    email: account.email,
    password: demo.password,
    scopeType: account.scope_type,
  });

  const { cancel_allowed: allowed, cancel_window_blocked: blocked } = fixtures.shipments;
  const workspace = `${basePath}/operations/shipment-amend-cancel?shipment_id=`;
  if (operation === "cancel") {
    await page.goto(workspace + blocked.id);
    const blockedForm = page.getByTestId(`${prefix}-cancel-form`);
    await expect(blockedForm).toContainText(/cancel is limited to the first \d+ hours/i);
    await expect(blockedForm.getByTestId(`${prefix}-cancel-submit`)).toBeDisabled();
  }

  await page.goto(workspace + allowed.id);
  await expect(page.getByTestId(`${prefix}-panel`)).toBeVisible();
  const marker = `Shipment browser test ${randomUUID()}`;
  if (operation === "modify") {
    await page.getByTestId(`${prefix}-modify-special-instructions`).fill(marker);
  } else {
    await page.getByTestId(`${prefix}-cancel-reason`).fill(marker);
  }
  const submit = page.getByTestId(`${prefix}-${operation}-submit`);
  await expect(submit).toBeEnabled();
  await submit.click();
  await expect(page.getByTestId(`${prefix}-success`)).toContainText(
    operation === "modify" ? "Shipment modify completed." : "Shipment soft-cancel completed.",
  );

  const pool = new Pool({ connectionString: databaseUrl, application_name: "e2e:shipment-amend-cancel" });
  try {
    const shipment = await pool.query(
      "SELECT status, special_instructions FROM public.shipments WHERE id = $1::uuid",
      [allowed.id],
    );
    if (operation === "modify") {
      expect(shipment.rows).toEqual([{ status: "pending", special_instructions: marker }]);
    } else {
      expect(shipment.rows[0]?.status).toBe("cancelled");
      const blockedShipment = await pool.query("SELECT status FROM public.shipments WHERE id = $1::uuid", [blocked.id]);
      expect(blockedShipment.rows).toEqual([{ status: "pending" }]);
    }
    const audit = await pool.query(
      `SELECT performed_by_system, action_data #>> '{audit_actor,source}' AS source,
              action_data #>> '{audit_actor,surface}' AS surface
         FROM public.shipment_actions
        WHERE shipment_id = $1::uuid AND action_type = $2`,
      [allowed.id, operation === "cancel" ? "delete" : "modify"],
    );
    const actor = `${surface}.shipment_amend_cancel`;
    expect(audit.rows).toEqual([{ performed_by_system: actor, source: actor, surface }]);
  } finally {
    await pool.end();
  }
}
