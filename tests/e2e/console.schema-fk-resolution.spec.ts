import { test, expect } from "@playwright/test";
import { resolveAppConfig, filterDemoUsersForApp, enforceDemoContext } from "./utils/app-test-factory";
import { loadDemoContext } from "./utils/demo-accounts";
import { isStrictE2EEnv } from "./utils/env";
import { expectSignedIn } from "./utils/auth";
import { fetchResourceSampleRow } from "./utils/core-resource";
import { gotoEnsuringSignedIn } from "./utils/session";

const demo = loadDemoContext();
const config = resolveAppConfig("console");
const users = filterDemoUsersForApp(config, demo.users);
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

test.describe("shipment reference resolution", () => {
  test.skip(!demo.available && !isStrictE2EEnv(), demo.reason ?? "Demo accounts missing.");
  test.beforeAll(() => enforceDemoContext("console", users));

  test("shipment detail renders known client and sender references without raw identifiers", async ({ page }) => {
    const user = users.find((candidate) => candidate.scope_type === "tenant") ?? users[0];
    if (!user?.email || !demo.password) throw new Error("Seeded Console credentials are required.");
    const sample = await fetchResourceSampleRow({ resourceKey: "shipments", email: user.email, password: demo.password });
    const row = sample.item;
    const id = row?.id;
    if (!row || typeof id !== "string" || !uuid.test(id)) throw new Error("A seeded shipment is required.");
    const fields = ["client_id", "sender_id"].filter((key) => typeof row[key] === "string" && uuid.test(String(row[key])));
    expect(fields.length, "The sampled shipment must have at least one canonical client or sender reference.").toBeGreaterThan(0);

    const path = "/resources/shipments?" + new URLSearchParams({ id, detail_open: "1" });
    await gotoEnsuringSignedIn({
      page, url: config.baseUrl + path, authTestId: config.authTestId,
      email: user.email, password: demo.password, timeoutMs: 60_000,
    });
    await expectSignedIn(page, user.email, user.scope_type);
    const detail = page.getByTestId("console-resource-detail").first();
    await expect(detail).toBeVisible();

    for (const key of fields) {
      const field = detail.locator('[data-field-key="' + key + '"]');
      await expect(field).toHaveCount(1);
      const section = field.locator("xpath=ancestor::details[1]");
      if ((await section.getAttribute("open")) === null) await section.locator("summary").click();
      const display = field.locator("dd > span").first();
      await expect(display).toBeVisible();
      await expect(display).not.toHaveText(uuid);
      await expect(display).not.toHaveText("-");
    }
  });
});
