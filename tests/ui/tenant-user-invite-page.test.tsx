/** @jest-environment node */
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

const getVerifiedAccessToken = jest.fn();
const rpc = jest.fn();
const inviteForm = jest.fn();
jest.mock("@masarx/auth", () => ({ getVerifiedAccessToken }));
jest.mock("next-intl/server", () => ({ getTranslations: async () => (key: string) => key }), { virtual: true });
jest.mock("../../apps/console/app/app-context", () => ({
  withConsoleConfig: (render: (context: { appBasePath: string }) => unknown) =>
    () => render({ appBasePath: "/console" }),
}));
jest.mock("../../apps/console/app/resources/users/invite-form", () => ({ TenantUserInviteForm: inviteForm }));
import Page from "../../apps/console/app/resources/users/invite/page";

const options = {
  user_types: [{ value: "account_manager", label: "Account manager", scope_type: "tenant" }],
  roles: [{ id: "reader-role", name: "Reader" }], clients: [], senders: [],
};
beforeEach(() => {
  jest.resetAllMocks();
  getVerifiedAccessToken.mockResolvedValue({ client: { rpc }, user: { id: "verified-user" }, error: null });
  rpc.mockResolvedValue({ data: options, error: null });
  inviteForm.mockImplementation(() => createElement("form", { "data-testid": "tenant-user-invite" }));
});

test("marks verified options ready and preserves the configured endpoint and form", async () => {
  const html = renderToStaticMarkup(await Page({}));
  expect(html).toContain('data-testid="console-tenant-user-invite-ready"');
  expect(html).toContain('data-testid="tenant-user-invite"');
  expect(getVerifiedAccessToken).toHaveBeenCalledWith({ allowCookieSet: false });
  expect(rpc).toHaveBeenCalledWith("tenant_user_invite_options_v1");
  expect(inviteForm.mock.calls[0][0]).toEqual({ endpoint: "/console/api/tenant-user-invite", options });
});

test.each(["user_types", "roles"])("shows a recoverable empty state instead of empty %s choices", async (key) => {
  rpc.mockResolvedValue({ data: { ...options, [key]: [] }, error: null });
  const html = renderToStaticMarkup(await Page({}));
  expect(html).toContain('data-testid="console-tenant-user-invite-blocked"');
  expect(html).toContain('role="alert">noOptions');
  expect(html).toContain('href="/console/resources/users"');
  expect(inviteForm).not.toHaveBeenCalled();
});

test.each([
  { user: null, error: null },
  { user: { id: "unverified-user" }, error: new Error("verification failed") },
])("requires verified authentication before loading options: %p", async (identity) => {
  getVerifiedAccessToken.mockResolvedValue({ client: { rpc }, ...identity });
  const html = renderToStaticMarkup(await Page({}));
  expect(html).toContain('data-testid="console-tenant-user-invite-auth-required"');
  expect(rpc).not.toHaveBeenCalled();
  expect(inviteForm).not.toHaveBeenCalled();
});

test.each([
  [{ data: null, error: { code: "42501" } }, "blocked"],
  [{ data: null, error: { code: "XX000" } }, "error"],
  [{ data: null, error: null }, "error"],
])("does not disguise unavailable options as ready: %p (case %#)", async (result, state) => {
  rpc.mockResolvedValue(result);
  const html = renderToStaticMarkup(await Page({}));
  expect(html).toContain(`data-testid="console-tenant-user-invite-${state}"`);
  expect(html).toContain('role="alert"');
  expect(inviteForm).not.toHaveBeenCalled();
});
