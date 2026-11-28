import { readFileSync } from "node:fs";
import type { BrowserContext, Request } from "@playwright/test";
import { getConsoleBaseUrl } from "../../e2e/utils/base-urls";
import {
  CONSOLE_SIGNED_IN_SHELL,
  strictConsoleSignIn,
} from "../../e2e/utils/strict-console-sign-in";

jest.mock("node:fs", () => ({ readFileSync: jest.fn() }));

jest.mock("../../e2e/utils/base-urls", () => ({
  getConsoleBaseUrl: () => ["https:", "", "console.example.test"].join("/"),
}));

const syntheticAddress = ["fixture-user", "example.test"].join("@");

function useSyntheticCredentials() {
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
  return env;
}

test("drops the runner error and exposes only the fixed sign-in failure code", async () => {
  const env = useSyntheticCredentials();
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

test.each([0, 2])("reports an invalid password grant count (%i)", async (requestCount) => {
  const env = useSyntheticCredentials();
  const request = {
    method: () => "POST",
    url: () => new URL("/auth/v1/token?grant_type=password", getConsoleBaseUrl()).href,
  };
  type RequestListener = (request: Pick<Request, "method" | "url">) => void;
  let onRequest: RequestListener | undefined;
  const locator = {
    and: jest.fn().mockReturnThis(),
    locator: jest.fn().mockReturnThis(),
    waitFor: jest.fn().mockResolvedValue(undefined),
    count: jest.fn().mockResolvedValue(0),
    evaluate: jest.fn().mockResolvedValue(true),
    click: jest.fn(async () => {
      for (let index = 0; index < requestCount; index += 1) onRequest?.(request);
    }),
  };
  const page = {
    on: jest.fn((_event: string, listener: RequestListener) => { onRequest = listener; }),
    off: jest.fn(),
    goto: jest.fn().mockResolvedValue(undefined),
    getByTestId: () => locator,
    locator: () => locator,
    waitForResponse: requestCount === 0
      ? jest.fn().mockRejectedValue(new Error("Response timed out"))
      : jest.fn().mockResolvedValue({ ok: () => true }),
  };
  const context = {
    newPage: jest.fn().mockResolvedValue(page),
    cookies: jest.fn().mockResolvedValue([{
      name: "fixture-session",
      value: JSON.stringify({
        access_token: ["synthetic", "session"].join("-"),
        user: { email: syntheticAddress },
      }),
    }]),
  };

  try {
    await expect(strictConsoleSignIn(context as unknown as BrowserContext, "finance_viewer", "/"))
      .rejects.toHaveProperty("message", "SIGN_IN_FAILED/REQUEST_COUNT");
  } finally {
    env.restore();
  }
});

function mockSubmittedSignIn({
  responseStatus = 200,
  responseMissing = false,
  shellReady = true,
  sessionEmail = syntheticAddress,
} = {}) {
  const request = {
    method: () => "POST",
    url: () => new URL("/auth/v1/token?grant_type=password", getConsoleBaseUrl()).href,
  };
  type RequestListener = (request: Pick<Request, "method" | "url">) => void;
  let onRequest: RequestListener | undefined;
  const locator = {
    and: jest.fn().mockReturnThis(),
    locator: jest.fn().mockReturnThis(),
    waitFor: jest.fn().mockResolvedValue(undefined),
    count: jest.fn().mockResolvedValue(0),
    evaluate: jest.fn().mockResolvedValue(true),
    click: jest.fn(async () => { onRequest?.(request); }),
  };
  const shell = {
    waitFor: shellReady
      ? jest.fn().mockResolvedValue(undefined)
      : jest.fn().mockRejectedValue(new Error("Shell never became visible")),
  };
  const page = {
    on: jest.fn((_event: string, listener: RequestListener) => { onRequest = listener; }),
    off: jest.fn(),
    goto: jest.fn().mockResolvedValue(undefined),
    getByTestId: (id: string) => id === CONSOLE_SIGNED_IN_SHELL ? shell : locator,
    locator: () => locator,
    waitForResponse: responseMissing
      ? jest.fn().mockRejectedValue(new Error("Response timed out"))
      : jest.fn().mockResolvedValue({
        ok: () => responseStatus === 200,
        status: () => responseStatus,
      }),
  };
  const context = {
    newPage: jest.fn().mockResolvedValue(page),
    cookies: jest.fn().mockResolvedValue([{
      name: "fixture-session",
      value: JSON.stringify({
        access_token: ["synthetic", "session"].join("-"),
        user: { email: sessionEmail },
      }),
    }]),
  };
  return { page, context: context as unknown as BrowserContext };
}

test("returns the signed-in page after one password grant", async () => {
  const env = useSyntheticCredentials();
  const { context, page } = mockSubmittedSignIn();

  try {
    await expect(strictConsoleSignIn(context, "finance_viewer", "/")).resolves.toBe(page);
  } finally {
    env.restore();
  }
});

test.each([
  { options: { responseStatus: 401 }, message: "SIGN_IN_FAILED/REJECTED_401" },
  { options: { responseMissing: true }, message: "SIGN_IN_FAILED/NO_RESPONSE" },
  { options: { shellReady: false }, message: "SIGN_IN_FAILED/SHELL_NOT_READY" },
  {
    options: { sessionEmail: ["other-user", "example.test"].join("@") },
    message: "SIGN_IN_FAILED/IDENTITY_MISMATCH",
  },
])("reports $message after one password grant", async ({ options, message }) => {
  const env = useSyntheticCredentials();
  const { context } = mockSubmittedSignIn(options);

  try {
    await expect(strictConsoleSignIn(context, "finance_viewer", "/"))
      .rejects.toThrow(new Error(message));
  } finally {
    env.restore();
  }
});
