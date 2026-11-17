jest.mock("../e2e/utils/auth", () => ({
  signInWithPassword: jest.fn(),
  expectSignedIn: jest.fn(),
}));

import { signInWithPassword } from "../e2e/utils/auth";
import { signInIfAuthRequired } from "../e2e/utils/session";

type MockLocator = {
  first: () => MockLocator;
  isVisible: jest.Mock<Promise<boolean>, []>;
  waitFor: jest.Mock<Promise<void>, [{ state: string; timeout: number }]>;
};

function createLocator(options: {
  visible?: boolean;
  waitForResolves?: boolean;
} = {}): MockLocator {
  const locator: MockLocator = {
    first: () => locator,
    isVisible: jest.fn(async () => Boolean(options.visible)),
    waitFor: jest.fn(async () => {
      if (!options.waitForResolves) {
        throw new Error("not visible");
      }
    }),
  };
  return locator;
}

function createPage(locators: Record<string, MockLocator>) {
  return {
    locator: jest.fn((selector: string) => {
      const entry = locators[selector];
      if (!entry) {
        throw new Error(`Unexpected selector: ${selector}`);
      }
      return entry;
    }),
  } as any;
}

describe("signInIfAuthRequired", () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it("waits for a delayed auth gate before signing in", async () => {
    const contextLocator = createLocator({ visible: false, waitForResolves: false });
    const authLocator = createLocator({ visible: false, waitForResolves: true });
    const page = createPage({
      '[data-testid="console-context-unavailable"]': contextLocator,
      '[data-testid="console-auth-required"]': authLocator,
    });

    const result = await signInIfAuthRequired({
      page,
      authTestId: "console-auth-required",
      email: "user@example.com",
      password: "secret",
      timeoutMs: 15000,
    });

    expect(result).toBe(true);
    expect(authLocator.waitFor).toHaveBeenCalledWith({ state: "visible", timeout: 15000 });
    expect(signInWithPassword).toHaveBeenCalledWith(page, "user@example.com", "secret");
  });

  it("returns false when auth is not required", async () => {
    const contextLocator = createLocator({ visible: false, waitForResolves: false });
    const authLocator = createLocator({ visible: false, waitForResolves: false });
    const page = createPage({
      '[data-testid="portal-context-unavailable"]': contextLocator,
      '[data-testid="portal-auth-required"]': authLocator,
    });

    const result = await signInIfAuthRequired({
      page,
      authTestId: "portal-auth-required",
      email: "user@example.com",
      password: "secret",
      timeoutMs: 15000,
    });

    expect(result).toBe(false);
    expect(signInWithPassword).not.toHaveBeenCalled();
  });
});
