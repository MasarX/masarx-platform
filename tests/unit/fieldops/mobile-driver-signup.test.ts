import { resolveDriverSignupUrl, openDriverSignup } from "../../../apps/fieldops/src/mobile-driver-signup";
test.each([undefined, "", "http://example.test/apply", "javascript:alert(1)", "/apply", (["https",":","/","/","user",":","pass","@","example.test","/","apply"].join("")), "https://example.test/apply#token"])("rejects unsafe or missing public entry %s", value => {
  expect(resolveDriverSignupUrl(value)).toBeNull();
});
test("opens only the configured browser URL without creating auth state", async () => {
  const linking = { canOpenURL: jest.fn(async () => true), openURL: jest.fn(async () => undefined) };
  await openDriverSignup(" https://signup.example.test/ar/drivers/apply ", linking);
  expect(linking.canOpenURL).toHaveBeenCalledWith("https://signup.example.test/ar/drivers/apply");
  expect(linking.openURL).toHaveBeenCalledWith("https://signup.example.test/ar/drivers/apply");
});
test("unsupported browser fails closed", async () => {
  const linking = { canOpenURL: jest.fn(async () => false), openURL: jest.fn() };
  await expect(openDriverSignup("https://signup.example.test/drivers/apply", linking)).rejects.toThrow("driver_signup_unavailable");
  expect(linking.openURL).not.toHaveBeenCalled();
});
