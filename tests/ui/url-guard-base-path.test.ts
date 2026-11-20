import { resolveSafeAppBasePath } from "../../packages/ui/src/url-guard";

test.each([
  ["", ""],
  ["/", ""],
  ["/app/", "/app"],
  ["/app///", "/app"],
  ["  /app//  ", "/app"],
  ["//evil", null],
  ["https://x", null],
  ["/a b", null],
] as const)("resolves app base path %j to %j", (input, expected) => {
  expect(resolveSafeAppBasePath(input)).toBe(expected);
});

test("rejects a long run of non-trailing slashes within a small CPU budget", () => {
  const input = `${"/".repeat(100_000)}x`;
  const start = process.cpuUsage();
  const result = resolveSafeAppBasePath(input);
  const { user, system } = process.cpuUsage(start);

  expect(result).toBeNull();
  expect(user + system).toBeLessThan(250_000);
});
