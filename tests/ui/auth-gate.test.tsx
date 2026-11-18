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
    <AuthGate appLabel="Console" testIdPrefix="console-auth" contextError={null}>
      <div>Child content</div>
    </AuthGate>
  );

  expect(screen.getByText("Child content")).toBeInTheDocument();
});

test("auth gate shows sign-in when forced", () => {
  renderWithIntl(
    <AuthGate appLabel="Console" testIdPrefix="console-auth" forceAuth>
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
      testIdPrefix="portal-auth"
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
      testIdPrefix="console-auth"
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

test("auth gate preserves auth classification when the technical message is hidden", () => {
  renderWithIntl(
    <AuthGate appLabel="Console" testIdPrefix="console-auth" contextError={new Error("Backend ui_me_v1 requires authenticated user; token=synthetic-short")}>
      <div>Child content</div>
    </AuthGate>
  );
  expect(screen.getByText("Console sign-in")).toBeInTheDocument();
  expect(screen.queryByText(/synthetic-short|Backend ui_me_v1/)).not.toBeInTheDocument();
});

test("auth gate preserves context hints without rendering technical diagnostics", () => {
  renderWithIntl(
    <AuthGate appLabel="Console" testIdPrefix="console-auth" contextError={new Error("Backend ui_read_registry_v1 raw response unavailable; client_secret=synthetic-short")}>
      <div>Child content</div>
    </AuthGate>
  );
  expect(screen.getByTestId("console-auth-context-unavailable")).toBeInTheDocument();
  expect(screen.queryByText(/synthetic-short|ui_read_registry_v1|raw response/)).not.toBeInTheDocument();
  expect(screen.queryByText("Child content")).not.toBeInTheDocument();
});
