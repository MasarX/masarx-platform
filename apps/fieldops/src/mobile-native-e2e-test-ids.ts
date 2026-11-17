export const FIELDOPS_NATIVE_E2E_TEST_IDS = {
  signInScreen: "mobile-signin-screen",
  signInEmail: "mobile-signin-email",
  signInPassword: "EXAMPLE_PASSWORD",
  signInOtp: "mobile-signin-otp",
  signInSubmit: "mobile-signin-submit",
  menuToggle: "mobile-menu-toggle",
  menuClose: "mobile-menu-close",
  openDiagnostics: "mobile-open-diagnostics",
  signOut: "mobile-sign-out",
} as const;

export function fieldOpsSignInMethodTestId(method: string): string {
  return `mobile-signin-method-${method.trim().toLowerCase()}`;
}
