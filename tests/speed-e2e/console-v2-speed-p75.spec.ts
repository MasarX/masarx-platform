import { expect } from "@playwright/test";
import { measureSpeed } from "./measure-speed";

const usableSelectors: Record<string, string[]> = {
  "/": [".dash-grid .dash-widget"],
  "/operate/shipments": [".dt-toolbar", "thead"],
  "/operate/dispatch": [".three-pane .pane__header"],
  "/operate/exceptions": [".dt-toolbar", "thead"],
  "/operate/pickups": [".dt-toolbar", "thead"],
  "/operate/tracking-map": [".map-canvas", ".section-eyebrow"],
  "/finance/cod": [".kpi-strip", "thead"],
};

measureSpeed("console-v2-speed-p75", Object.keys(usableSelectors), async (page, route) => {
  await expect(page.locator(".topbar")).toBeVisible();
  for (const selector of usableSelectors[route]) {
    await expect(page.getByRole("main").locator(selector).first()).toBeVisible();
  }
});
