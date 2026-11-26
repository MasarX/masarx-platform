import { readFileSync } from "node:fs";
import type { BrowserContext } from "@playwright/test";
import { strictConsoleSignIn } from "../../e2e/utils/strict-console-sign-in";

jest.mock("node:fs", () => ({ readFileSync: jest.fn() }));

test("drops the runner error and exposes only the fixed sign-in failure code", async () => {
  const syntheticAddress = ["fixture-user", "example.test"].join("@");
  const env = jest.replaceProperty(process, "env", {
    ...process.env,
    E2E_SWEEP_CREDENTIALS_FILE: "unused",
  });
  jest.mocked(readFileSync).mockReturnValue(JSON.stringify({
    finance_viewer: {
      email: syntheticAddress,
      password: ["synthetic", "fixture"].join("-"),
    },
  }));
  const context = {
    newPage: jest.fn().mockRejectedValue(new Error("Unexpected value " + syntheticAddress)),
  };

  try {
    await expect(strictConsoleSignIn(context as unknown as BrowserContext, "finance_viewer", "/"))
      .rejects.toHaveProperty("message", "SIGN_IN_FAILED/FORM_NOT_READY");
  } finally {
    env.restore();
  }
});
