import { expect } from "@playwright/test";
import { measureSpeed } from "./measure-speed";

measureSpeed("Portal tracking", "/tracking", async page => {
  await expect(page.getByTestId("portal-tracking-input")).toBeEditable();
});
