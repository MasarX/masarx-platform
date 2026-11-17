import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { renderWithIntl } from "./test-utils";
import { AuthSignIn } from "../../packages/ui/src/auth-sign-in";

let pathname = "/portal/resources/shipments";
let searchParams = new URLSearchParams();
const replace = jest.fn();
const refresh = jest.fn();
const signInWithPassword = jest.fn().mockResolvedValue({ error: null });
const signInWithOtp = jest.fn().mockResolvedValue({ error: null });

jest.mock("next/navigation", () => ({
  usePathname: () => pathname,
  useSearchParams: () => searchParams,
  useRouter: () => ({ replace, refresh })
}));

jest.mock("@masarx/auth/browser", () => ({
  createBrowserClient: () => ({
    auth: {
      signInWithPassword,
      signInWithOtp
    }
  })
}));

beforeEach(() => {
  replace.mockClear();
  refresh.mockClear();
  signInWithPassword.mockClear();
  signInWithOtp.mockClear();
  pathname = "/portal/resources/shipments";
  searchParams = new URLSearchParams();
});

test("auth sign-in strips app base path from return path", async () => {
  const user = userEvent.setup();
  renderWithIntl(
    <AuthSignIn appLabel="Portal" methods={["password"]} appBasePath="/portal" />
  );

  await user.type(screen.getByLabelText(/email/i), "owkgyjyzpisqttolugutsngo@example.invalid");
  await user.type(screen.getByLabelText(/password/i), "password123");
  await user.click(screen.getByRole("button"));

  await waitFor(() => {
    expect(signInWithPassword).toHaveBeenCalledWith({
      email: "owkgyjyzpisqttolugutsngo@example.invalid",
      password: "password123"
    });
    expect(replace).toHaveBeenCalledWith("/resources/shipments");
  });
});

test("auth sign-in removes auth query params from return path", async () => {
  searchParams = new URLSearchParams(
    "foo=bar&error=invalid&code=123&next=/portal/other"
  );
  const user = userEvent.setup();
  renderWithIntl(
    <AuthSignIn appLabel="Portal" methods={["password"]} appBasePath="/portal" />
  );

  await user.type(screen.getByLabelText(/email/i), "owkgyjyzpisqttolugutsngo@example.invalid");
  await user.type(screen.getByLabelText(/password/i), "password123");
  await user.click(screen.getByRole("button"));

  await waitFor(() => {
    expect(replace).toHaveBeenCalledWith("/resources/shipments?foo=bar");
  });
});

test("auth sign-in uses stripped return path in magic link redirect", async () => {
  const user = userEvent.setup();
  renderWithIntl(
    <AuthSignIn appLabel="Portal" methods={["magic_link"]} appBasePath="/portal" />
  );

  await user.type(screen.getByLabelText(/email/i), "owkgyjyzpisqttolugutsngo@example.invalid");
  await user.click(screen.getByRole("button"));

  await waitFor(() => {
    expect(signInWithOtp).toHaveBeenCalled();
  });

  const [{ options }] = signInWithOtp.mock.calls.map(([payload]) => payload);
  const redirectTo = options?.emailRedirectTo ?? "";
  const redirectUrl = new URL(redirectTo);
  expect(options?.shouldCreateUser).toBe(false);
  expect(redirectUrl.searchParams.get("next")).toBe("/resources/shipments");
  expect(redirectUrl.searchParams.get("request_id")).toBeTruthy();
});

test("auth sign-in keeps full return path when appBasePath is unsafe", async () => {
  const user = userEvent.setup();
  renderWithIntl(
    <AuthSignIn
      appLabel="Portal"
      methods={["password"]}
      appBasePath="javascript:alert(1)"
    />
  );

  await user.type(screen.getByLabelText(/email/i), "owkgyjyzpisqttolugutsngo@example.invalid");
  await user.type(screen.getByLabelText(/password/i), "password123");
  await user.click(screen.getByRole("button"));

  await waitFor(() => {
    expect(signInWithPassword).toHaveBeenCalledWith({
      email: "owkgyjyzpisqttolugutsngo@example.invalid",
      password: "password123"
    });
    expect(replace).toHaveBeenCalledWith("/resources/shipments");
  });
});

test("auth sign-in blocks duplicate submits during in-flight request", async () => {
  let resolveSignIn: (value: { error: null }) => void = () => {};
  signInWithPassword.mockImplementationOnce(
    () =>
      new Promise<{ error: null }>((resolve) => {
        resolveSignIn = resolve;
      })
  );

  const user = userEvent.setup();
  renderWithIntl(
    <AuthSignIn appLabel="Portal" methods={["password"]} appBasePath="/portal" />
  );

  const submitButton = screen.getByRole("button");
  await user.type(screen.getByLabelText(/email/i), "owkgyjyzpisqttolugutsngo@example.invalid");
  await user.type(screen.getByLabelText(/password/i), "password123");
  await user.click(submitButton);

  await waitFor(() => {
    expect(submitButton).toBeDisabled();
  });
  await user.click(submitButton);

  expect(signInWithPassword).toHaveBeenCalledTimes(1);

  resolveSignIn({ error: null });
  await waitFor(() => {
    expect(submitButton).not.toBeDisabled();
  });
});

test("auth sign-in resets loading state when auth call throws", async () => {
  signInWithPassword.mockRejectedValueOnce(new Error("network unavailable"));
  const user = userEvent.setup();
  renderWithIntl(
    <AuthSignIn appLabel="Portal" methods={["password"]} appBasePath="/portal" />
  );

  await user.type(screen.getByLabelText(/email/i), "owkgyjyzpisqttolugutsngo@example.invalid");
  await user.type(screen.getByLabelText(/password/i), "password123");
  await user.click(screen.getByRole("button"));

  await waitFor(() => {
    expect(signInWithPassword).toHaveBeenCalledTimes(1);
  });
  expect(screen.getByRole("button")).toHaveTextContent(/sign in/i);
  expect(screen.getByRole("button")).toBeEnabled();
});
