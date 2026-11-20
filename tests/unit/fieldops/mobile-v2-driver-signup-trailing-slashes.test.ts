import { resolveMobileV2DriverSignupEndpoints } from "../../../apps/fieldops/src/mobile-v2-driver-signup";

test.each([
  ["", ""],
  ["/", ""],
  ["/app/", ""],
  ["/app///", ""],
  ["  /app//  ", ""],
  ["//evil", ""],
  ["https://x", "https://x"],
  ["/a b", ""],
  ["  https://x/app///  ", "https://x/app"],
  ["https://x/app///?q=///", "https://x/app///?q="],
] as const)("normalizes signup endpoint %j", (signupEndpoint, expected) => {
  expect(resolveMobileV2DriverSignupEndpoints({ supabaseUrl: "", signupEndpoint }).signupEndpoint).toBe(expected);
});

test("preserves a long run of internal slashes in signup endpoints within the CPU budget", () => {
  const signupEndpoint = `https://x/app${"/".repeat(100_000)}x`;
  const start = process.cpuUsage();
  const result = resolveMobileV2DriverSignupEndpoints({ supabaseUrl: "", signupEndpoint });
  const { user, system } = process.cpuUsage(start);

  expect(result.signupEndpoint).toBe(signupEndpoint);
  expect(user + system).toBeLessThan(250_000);
});
