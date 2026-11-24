import { expect } from "@playwright/test";
import { measureSpeed } from "./measure-speed";

const screens = [
  { screen: "Dashboard", route: "/", ready: [".dash-grid .dash-widget"] },
  { screen: "Shipments", route: "/operate/shipments", ready: [".dt-toolbar", "thead"] },
  { screen: "Dispatch", route: "/operate/dispatch", ready: [".three-pane .pane__header"] },
  { screen: "Exceptions", route: "/operate/exceptions", ready: [".dt-toolbar", "thead"] },
  { screen: "Pickups", route: "/operate/pickups", ready: [".dt-toolbar", "thead"] },
  { screen: "Tracking map", route: "/operate/tracking-map", ready: [".map-canvas", ".section-eyebrow"] },
  { screen: "COD", route: "/finance/cod", ready: [".kpi-strip", "thead"] },
];

for (const { screen, route, ready } of screens) {
  measureSpeed(`Console V2 ${screen}`, route, async page => {
    await expect(page.locator(".topbar")).toBeVisible();
    for (const selector of ready) {
      await expect(page.getByRole("main").locator(selector).first()).toBeVisible();
    }
  });
}
