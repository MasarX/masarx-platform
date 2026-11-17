import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { NextIntlClientProvider } from "next-intl";
// Exercise the real controls without initializing unrelated server pages from the UI barrel.
jest.mock("@masarx/ui", () => ({
  Button: jest.requireActual("../../packages/ui/src/button").Button,
  Input: jest.requireActual("../../packages/ui/src/input").Input,
  Select: jest.requireActual("../../packages/ui/src/select").Select,
}));
import { TenantUserInviteForm, type InviteOptions } from "../../apps/console/app/resources/users/invite-form";
import en from "../../packages/config/messages/en.json";
import ar from "../../packages/config/messages/ar.json";

const options: InviteOptions = {
  user_types: [{ value: "account_manager", label: "Account Manager", scope_type: "tenant" },
    { value: "client_admin", label: "Client Admin", scope_type: "client" },
    { value: "sender_admin", label: "Sender Admin", scope_type: "sender" }],
  roles: [{ id: "reader-role", name: "Reader" }], clients: [{ id: "client-1", name: "Client One" }], senders: [],
};
const refresh = jest.fn();
jest.mock("next/navigation", () => ({ useRouter: () => ({ refresh }) }));

const endpoint = "/api/tenant-user-invite";
const originalFetch = global.fetch;
const needsRandomUUID = typeof crypto.randomUUID !== "function";
// JSDOM20 omits this secure-context browser API; use Node's real UUID implementation.
beforeAll(() => {
  if (needsRandomUUID) Object.defineProperty(crypto, "randomUUID", {
    configurable: true, value: jest.requireActual("node:crypto").randomUUID,
  });
});
afterAll(() => { if (needsRandomUUID) Reflect.deleteProperty(crypto, "randomUUID"); });
const show = (locale = "en", targetUserId?: string, formOptions = options) => render(
  <NextIntlClientProvider locale={locale} messages={locale === "ar" ? ar : en}>
    <TenantUserInviteForm endpoint={endpoint} options={targetUserId ? undefined : formOptions} targetUserId={targetUserId} />
  </NextIntlClientProvider>,
);
beforeEach(() => { global.fetch = jest.fn(); refresh.mockReset(); });
afterEach(() => { global.fetch = originalFetch; });
function fillInvite() {
  fireEvent.change(screen.getByLabelText("Email"), { target: { value: "synthetic@example.test" } });
  fireEvent.change(screen.getByLabelText("Full name"), { target: { value: "Example Person" } });
  fireEvent.change(screen.getByLabelText("User type"), { target: { value: "account_manager" } });
  fireEvent.change(screen.getByLabelText("Tenant role"), { target: { value: "reader-role" } });
}
function recordedResponse(extra: Record<string, unknown> = {}) {
  return { ok: true, json: async () => ({ ok: true, code: "invite_request_recorded",
    request_id: JSON.parse((global.fetch as jest.Mock).mock.calls.at(-1)[1].body).request_id, ...extra }) };
}

test("uses visible required labels and separate user type, role and scoped tenant choices", () => {
  show();
  expect(screen.getByLabelText("Email")).toBeRequired();
  expect(screen.getByLabelText("Full name")).toBeRequired();
  expect(screen.getByLabelText("User type")).toBeRequired();
  expect(screen.getByLabelText("Tenant role")).toBeRequired();
  expect(screen.queryByLabelText("Client or sender")).not.toBeInTheDocument();
  fireEvent.change(screen.getByLabelText("User type"), { target: { value: "client_admin" } });
  expect(screen.getByLabelText("Client or sender")).toBeRequired();
  expect(screen.getByRole("option", { name: "Client One" })).toBeInTheDocument();
});

test.each(["client_admin", "sender_admin"])("%s with no scope choices explains recovery without locking or sending an invalid request", async (userType) => {
  const fetchMock = global.fetch as jest.Mock;
  fetchMock.mockResolvedValue(recordedResponse());
  show("en", undefined, { ...options, clients: [], senders: [] });
  fillInvite();
  fireEvent.change(screen.getByLabelText("User type"), { target: { value: userType } });
  expect(screen.queryByLabelText("Client or sender")).not.toBeInTheDocument();
  expect(screen.getByRole("status")).toHaveTextContent(en.ui.tenantUsers.noScopeOptions);
  expect(screen.getByRole("status")).toHaveAttribute("aria-live", "polite");
  fireEvent.submit(screen.getByTestId("tenant-user-invite"));
  expect(fetchMock).not.toHaveBeenCalled();
  expect(screen.getByRole("status")).not.toHaveTextContent("Request:");
  expect(screen.getByLabelText("Email")).toBeEnabled();
  expect(screen.getByLabelText("Email")).toHaveValue("synthetic@example.test");
  expect(screen.getByRole("button", { name: "Invite user" })).toBeEnabled();
  fireEvent.change(screen.getByLabelText("User type"), { target: { value: "account_manager" } });
  expect(screen.queryByText(en.ui.tenantUsers.noScopeOptions)).not.toBeInTheDocument();
  fireEvent.submit(screen.getByTestId("tenant-user-invite"));
  await screen.findByText(en.ui.tenantUsers.sent);
  expect(JSON.parse(fetchMock.mock.calls[0][1].body)).toEqual(expect.objectContaining({
    user_type: "account_manager", access_scope_type: "tenant", access_scope_id: null,
  }));
});

test.each([
  ["client_admin", "client", "client-1"],
  ["sender_admin", "sender", "sender-1"],
])("%s sends the selected available scope", async (userType, scopeType, scopeId) => {
  const fetchMock = global.fetch as jest.Mock;
  fetchMock.mockResolvedValue(recordedResponse());
  show("en", undefined, { ...options, senders: [{ id: "sender-1", name: "Sender One" }] });
  fillInvite();
  fireEvent.change(screen.getByLabelText("User type"), { target: { value: userType } });
  fireEvent.change(screen.getByLabelText("Client or sender"), { target: { value: scopeId } });
  fireEvent.submit(screen.getByTestId("tenant-user-invite"));
  await screen.findByText(en.ui.tenantUsers.sent);
  expect(JSON.parse(fetchMock.mock.calls[0][1].body)).toEqual(expect.objectContaining({
    user_type: userType, access_scope_type: scopeType, access_scope_id: scopeId,
  }));
});

test("a response-lost scoped request remains retryable with the same intent when choices disappear", async () => {
  const fetchMock = global.fetch as jest.Mock;
  fetchMock.mockRejectedValueOnce(new Error("response lost")).mockResolvedValueOnce(recordedResponse());
  const view = show();
  fillInvite();
  fireEvent.change(screen.getByLabelText("User type"), { target: { value: "client_admin" } });
  fireEvent.change(screen.getByLabelText("Client or sender"), { target: { value: "client-1" } });
  fireEvent.submit(screen.getByTestId("tenant-user-invite"));
  await screen.findByText(en.ui.tenantUsers.unknown);
  view.rerender(<NextIntlClientProvider locale="en" messages={en}>
    <TenantUserInviteForm endpoint={endpoint} options={{ ...options, clients: [] }} />
  </NextIntlClientProvider>);
  expect(screen.queryByLabelText("Client or sender")).not.toBeInTheDocument();
  expect(screen.queryByText(en.ui.tenantUsers.noScopeOptions)).not.toBeInTheDocument();
  expect(screen.getByLabelText("Email")).toBeDisabled();
  fireEvent.submit(screen.getByTestId("tenant-user-invite"));
  await screen.findByText(en.ui.tenantUsers.sent);
  expect(fetchMock).toHaveBeenCalledTimes(2);
  expect(fetchMock.mock.calls[1][1].body).toBe(fetchMock.mock.calls[0][1].body);
  expect(JSON.parse(fetchMock.mock.calls[1][1].body)).toEqual(expect.objectContaining({
    access_scope_type: "client", access_scope_id: "client-1",
  }));
});

test("Arabic empty-scope recovery is translated and does not send an invitation", () => {
  show("ar");
  fireEvent.change(screen.getByLabelText(ar.ui.tenantUsers.userType), { target: { value: "sender_admin" } });
  expect(screen.queryByLabelText(ar.ui.tenantUsers.scope)).not.toBeInTheDocument();
  expect(screen.getByRole("status")).toHaveTextContent(ar.ui.tenantUsers.noScopeOptions);
  fireEvent.submit(screen.getByTestId("tenant-user-invite"));
  expect(global.fetch).not.toHaveBeenCalled();
});

test("does not show optimistic membership success; retry retains exact immutable intent", async () => {
  const fetchMock = global.fetch as jest.Mock;
  fetchMock.mockRejectedValueOnce(new Error("response lost")).mockResolvedValueOnce(recordedResponse());
  show(); fillInvite();
  fireEvent.submit(screen.getByTestId("tenant-user-invite"));
  expect(screen.queryByText(en.ui.tenantUsers.applied)).not.toBeInTheDocument();
  await screen.findByText(en.ui.tenantUsers.unknown);
  expect(screen.getByLabelText("Email")).toBeDisabled();
  fireEvent.submit(screen.getByTestId("tenant-user-invite"));
  await screen.findByText(en.ui.tenantUsers.sent);
  expect(fetchMock.mock.calls[0][1].body).toBe(fetchMock.mock.calls[1][1].body);
  const body = JSON.parse(fetchMock.mock.calls[0][1].body);
  expect(body).toEqual(expect.objectContaining({ action: "invite", access_scope_type: "tenant",
    email: "synthetic@example.test", role_id: "reader-role", user_type: "account_manager" }));
  expect(body).not.toHaveProperty("organization_id");
  expect(body).not.toHaveProperty("actor_user_id");
  expect(body).not.toHaveProperty("invite_redirect_to");
});

test("explicit resend sends no user type, role or scope and uses the same neutral acknowledgement", async () => {
  const fetchMock = global.fetch as jest.Mock;
  fetchMock.mockResolvedValue(recordedResponse());
  show("en", "existing-user");
  expect(screen.queryByLabelText("Tenant role")).not.toBeInTheDocument();
  fireEvent.submit(screen.getByTestId("tenant-user-resend"));
  await screen.findByText(en.ui.tenantUsers.sent);
  expect(JSON.parse(fetchMock.mock.calls[0][1].body)).toEqual({
    request_id: expect.any(String), action: "resend", target_user_id: "existing-user",
  });
});

test("Arabic controls and status are translated", async () => {
  (global.fetch as jest.Mock).mockResolvedValue({ ok: false, json: async () => ({ code: "invite_partial_membership_pending" }) });
  show("ar", "existing-user");
  expect(screen.getByRole("button", { name: ar.ui.tenantUsers.resend })).toBeInTheDocument();
  fireEvent.submit(screen.getByTestId("tenant-user-resend"));
  await waitFor(() => expect(screen.getByRole("status")).toHaveTextContent(ar.ui.tenantUsers.failed));
});

test.each(["ready", "accepted", "failed", "unknown"])("never reveals private provider state %s in the acknowledgement", async (state) => {
  (global.fetch as jest.Mock).mockResolvedValue(recordedResponse({
    provider_state: state, membership_state: "applied", auth_user_id: "private-global-id",
  }));
  show(); fillInvite();
  fireEvent.submit(screen.getByTestId("tenant-user-invite"));
  await screen.findByText(en.ui.tenantUsers.sent);
  expect(screen.getByRole("status")).not.toHaveTextContent("private-global-id");
  expect(screen.queryByText(en.ui.tenantUsers.applied)).not.toBeInTheDocument();
  expect(screen.queryByText(en.ui.tenantUsers.appliedUnknown)).not.toBeInTheDocument();
});

test("a mismatched response cannot acknowledge another invitation", async () => {
  (global.fetch as jest.Mock).mockResolvedValue(recordedResponse({ request_id: "another-request" }));
  show(); fillInvite();
  fireEvent.submit(screen.getByTestId("tenant-user-invite"));
  await screen.findByText(en.ui.tenantUsers.unknown);
  expect(screen.queryByText(en.ui.tenantUsers.sent)).not.toBeInTheDocument();
});

test("Arabic successful requests announce the same neutral localized status", async () => {
  (global.fetch as jest.Mock).mockResolvedValue(recordedResponse());
  show("ar", "existing-user");
  fireEvent.submit(screen.getByTestId("tenant-user-resend"));
  await screen.findByText(ar.ui.tenantUsers.sent);
});


test("refreshes the authorized server directory only for a matching recorded invite", async () => {
  (global.fetch as jest.Mock).mockResolvedValueOnce(recordedResponse({ request_id: "wrong-request" }))
    .mockImplementationOnce(async () => recordedResponse());
  show(); fillInvite();
  fireEvent.submit(screen.getByTestId("tenant-user-invite"));
  await screen.findByText(en.ui.tenantUsers.unknown);
  expect(refresh).not.toHaveBeenCalled();
  fireEvent.submit(screen.getByTestId("tenant-user-invite"));
  await screen.findByText(en.ui.tenantUsers.sent);
  expect(refresh).toHaveBeenCalledTimes(1);
  expect(screen.queryByText(en.ui.tenantUsers.applied)).not.toBeInTheDocument();
});
