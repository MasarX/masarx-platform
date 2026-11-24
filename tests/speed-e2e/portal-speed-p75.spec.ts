import { expect } from "@playwright/test";
import { measureSpeed } from "./measure-speed";

measureSpeed("Portal tracking", "/tracking", async page => {
  const input = page.getByRole("main").getByTestId("portal-tracking-input").filter({ visible: true });
  await expect(input).toBeEditable();
});
