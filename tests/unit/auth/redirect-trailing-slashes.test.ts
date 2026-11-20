import {
  normalizeAppBasePath,
  stripLegacyRootAppPrefix,
} from "../../../packages/auth/src/redirect";

test.each([
  ["", "/", "/"],
  ["/", "/", "/"],
  ["/app/", "/app", "/app"],
  ["/app///", "/app", "/app"],
  ["  /app//  ", "/app", "/app"],
  ["//evil", "/", "/"],
  ["https://x", "/", "/https://x"],
  ["/a b", "/", "/a b"],
] as const)("normalizes redirect input %j", (input, basePath, redirectPath) => {
  expect(normalizeAppBasePath(input)).toBe(basePath);
  expect(stripLegacyRootAppPrefix(input)).toBe(redirectPath);
});

test("preserves long runs of internal slashes in redirect paths within the CPU budget", () => {
  const input = `/app${"/".repeat(100_000)}x`;
  const start = process.cpuUsage();
  const basePath = normalizeAppBasePath(input);
  const redirectPath = stripLegacyRootAppPrefix(input);
  const { user, system } = process.cpuUsage(start);

  expect(basePath).toBe(input);
  expect(redirectPath).toBe(input);
  expect(user + system).toBeLessThan(250_000);
});
