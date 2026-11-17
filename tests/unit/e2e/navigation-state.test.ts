import { runInNewContext } from "node:vm";
import type { Page } from "@playwright/test";
import {
  readNavigationStateSnapshots,
  waitForCollapsedSectionPersisted,
} from "../../e2e/utils/navigation-state";

const email = "primary@example.test";
const userId = "4d1fbd36-6b6e-4c35-acc4-5e3ad9043830";
const storageKey = `masarx:navigation:v2:console:${userId}`;
const collapseKey = "dashboard.health";
let stored: Record<string, string>;

function evaluate(fn: { toString(): string }, arg: unknown) {
  return runInNewContext(`(${fn.toString()})(arg)`, {
    arg,
    window: { localStorage: { ...stored, getItem: (key: string) => stored[key] ?? null } },
  });
}

function createPage(user: { id?: string; email: string } = { id: userId, email }) {
  const waitForFunction = jest.fn(async () => undefined);
  const page = {
    context: () => ({
      cookies: async () => [{
        name: "sb-test-auth-token",
        value: JSON.stringify({ access_token: "test-token", user }),
      }],
    }),
    waitForFunction,
    evaluate: async (fn: { toString(): string }, arg: unknown) => evaluate(fn, arg),
  } as unknown as Page;
  return { page, waitForFunction };
}

beforeEach(() => { stored = {}; });

test("only the expected authenticated user's exact key can satisfy persistence", async () => {
  const { page, waitForFunction } = createPage();
  const collapsed = JSON.stringify({ collapsedSections: [collapseKey] });
  stored["masarx:navigation:v2:console:other-user"] = collapsed;
  stored["masarx:navigation:v2:console:anonymous"] = collapsed;
  stored[`masarx:navigation:v2:portal:${userId}`] = collapsed;

  await waitForCollapsedSectionPersisted({ page, appKey: "console", email, collapseKey });

  const [check, arg, options] = waitForFunction.mock.calls[0] as unknown as [
    (arg: { storageKey: string; collapseKey: string }) => boolean,
    { storageKey: string; collapseKey: string },
    { timeout: number },
  ];
  expect(arg).toEqual({ storageKey, collapseKey });
  expect(options).toEqual({ timeout: 10_000 });
  expect(evaluate(check, arg)).toBe(false);
  stored[storageKey] = "invalid-json";
  expect(evaluate(check, arg)).toBe(false);
  stored[storageKey] = JSON.stringify({ collapsedSections: [] });
  expect(evaluate(check, arg)).toBe(false);
  stored[storageKey] = JSON.stringify({ collapsedSections: "dashboard.health" });
  expect(evaluate(check, arg)).toBe(false);
  stored[storageKey] = collapsed;
  expect(evaluate(check, arg)).toBe(true);
});

test.each([
  { id: "other-user", email: "other@example.test" },
  { email },
])("rejects an absent expected user ID before polling (%p)", async (user) => {
  const { page, waitForFunction } = createPage(user);
  await expect(waitForCollapsedSectionPersisted({
    page, appKey: "console", email, collapseKey,
  })).rejects.toThrow("Expected authenticated navigation preference user is missing.");
  expect(waitForFunction).not.toHaveBeenCalled();
});

test("snapshot reads preserve all app users and malformed stored values", async () => {
  const { page } = createPage();
  const otherKey = "masarx:navigation:v2:console:other-user";
  stored[storageKey] = JSON.stringify({ collapsedSections: [collapseKey] });
  stored[otherKey] = "invalid-json";
  stored["masarx:navigation:v2:console:empty"] = "";
  stored[`masarx:navigation:v2:portal:${userId}`] = "{}";
  expect(await readNavigationStateSnapshots({ page, appKey: "console" })).toEqual([
    { key: storageKey, value: { collapsedSections: [collapseKey] } },
    { key: otherKey, value: "invalid-json" },
  ]);
});
