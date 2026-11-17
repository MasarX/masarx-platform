import { screen } from "@testing-library/react";
import { renderWithIntl } from "./test-utils";
import { AuthGate } from "../../packages/ui/src/auth-gate";

jest.mock("next/navigation", () => ({
  usePathname: () => "/",
  useSearchParams: () => new URLSearchParams(),
  useRouter: () => ({ replace: jest.fn(), refresh: jest.fn() }),
}));

jest.mock("@masarx/auth/browser", () => ({
  createBrowserClient: () => ({
    auth: {
      signInWithPassword: jest.fn(),
      signInWithOtp: jest.fn(),
    },
  }),
}));

test("auth gate renders children when no error and not forced", () => {
  renderWithIntl(
    <AuthGate appLabel="Console" testId="console-auth" contextError={null}>
      <div>Child content</div>
    </AuthGate>
  );

  expect(screen.getByText("Child content")).toBeInTheDocument();
});

test("auth gate shows sign-in when forced", () => {
  renderWithIntl(
    <AuthGate appLabel="Console" testId="console-auth" forceAuth>
      <div>Child content</div>
    </AuthGate>
  );

  expect(screen.getByText("Console sign-in")).toBeInTheDocument();
  expect(screen.queryByText("Child content")).toBeNull();
});

test("auth gate shows sign-in for auth errors", () => {
  renderWithIntl(
    <AuthGate
      appLabel="Portal"
      testId="portal-auth"
      contextError={new Error("ui_me_v1 requires authenticated user")}
    >
      <div>Child content</div>
    </AuthGate>
  );

  expect(screen.getByText("Portal sign-in")).toBeInTheDocument();
  expect(screen.queryByText("Child content")).toBeNull();
});

test("auth gate shows network hint when Supabase is unreachable", () => {
  renderWithIntl(
    <AuthGate
      appLabel="Console"
      testId="console-auth"
      contextError={new Error("fetch failed")}
    >
      <div>Child content</div>
    </AuthGate>
  );

  expect(
    screen.getByText(
      "Recommended action: Confirm the Supabase URL/anon key are set for this workspace and the project is reachable."
    )
  ).toBeInTheDocument();
  expect(screen.queryByText("Child content")).toBeNull();
});
