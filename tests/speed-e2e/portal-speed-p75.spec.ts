import { expect } from "@playwright/test";
import { measureSpeed } from "./measure-speed";

measureSpeed("portal-speed-p75", ["/tracking"], async page => {
  const input = page.getByRole("main").getByTestId("portal-tracking-input").filter({ visible: true });
  await expect(input).toBeEditable();
});
