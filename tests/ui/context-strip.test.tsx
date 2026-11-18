import React from "react";
import { fireEvent, render, screen } from "@testing-library/react";
import { renderToString } from "react-dom/server";
import { ContextStrip } from "../../packages/ui/src/context-strip";
import { setUiReporter } from "../../packages/ui/src/reporting";

jest.mock("../../packages/ui/src/i18n", () => ({
  createUiTranslator:
    () =>
    (key: string, values?: Record<string, unknown>) => {
      if (key === "labels.signedIn") return "Signed in";
      if (key === "labels.org") return "Org";
      if (key === "labels.scope") return "Scope";
      if (key === "labels.capabilities") return "Capabilities";
      if (key === "labels.settings") return "Settings";
      if (key === "copyAria") return `Copy ${String(values?.label ?? "")}`;
      if (key === "actions.copy") return "Copy";
      if (key === "actions.copied") return "Copied";
      if (key === "actions.copyFailed") return "Copy failed";
      if (key === "actions.details") return "Details";
      if (key === "actions.close") return "Close";
      if (key === "scopeSwitcher.label") return "Change scope";
      if (key === "scopeSwitcher.aria") return "Change scope";
      if (key === "scopeSwitcher.placeholder") return "Select scope";
      if (key === "scopeSwitcher.request") return "Request scope access";
      if (key === "scopeSwitcher.errors.missingHref") {
        return "Scope change is not configured.";
      }
      if (key === "details.title") return "Context details";
      if (key === "details.description") return "Resolved scope and settings identifiers.";
      if (key === "details.userId") return "User id";
      if (key === "details.orgId") return "Org id";
      if (key === "details.scopeType") return "Scope type";
      if (key === "details.scopeId") return "Scope id";
      if (key === "details.settingsResolutionId") return "Settings resolution id";
      if (key === "signOut") return "Sign out";
      return key;
    },
}));

const toastSpy = jest.fn();
const reporter = jest.fn();

jest.mock("../../packages/ui/src/use-toast", () => ({
  useToast: () => ({ toast: toastSpy }),
}));

jest.mock("../../packages/ui/src/read-registry-client", () => ({
  useReadRegistry: () => ({ data: null }),
}));

const scopeOptions = [
  {
    scope_type: "tenant",
    scope_id: "tenant-1",
    scope_label: "Tenant One",
    href: "/console/scope/tenant-1",
  },
  {
    scope_type: "client",
    scope_id: "client-1",
    scope_label: "Client One",
    href: "/console/scope/client-1",
  },
];

beforeEach(() => {
  toastSpy.mockClear();
  reporter.mockClear();
  setUiReporter(reporter);
});

afterEach(() => {
  setUiReporter(null);
});

test("server render does not inject request ids when they are not provided", () => {
  const html = renderToString(
    <ContextStrip
      userLabel="user@example.com"
      signOutHref="/auth/sign-out"
      scopeRequestHref="/access-policy/request"
    />
  );

  expect(html).toContain('href="/auth/sign-out"');
  expect(html).toContain('href="/access-policy/request"');
  expect(html).not.toContain("request_id=");
});

test("scope switcher navigates to scope href", () => {
  const assignSpy = jest.fn();

  render(
    <ContextStrip
      userLabel="user@example.com"
      orgLabel="Logistics"
      scopeLabel="tenant Tenant One"
      scopeType="tenant"
      scopeId="tenant-1"
      scopeOptions={scopeOptions}
      onScopeChange={assignSpy}
    />
  );

  const select = screen.getByLabelText("Change scope");
  fireEvent.change(select, { target: { value: "client::client-1" } });

  expect(assignSpy).toHaveBeenCalledWith("/console/scope/client-1");
});

test("scope switcher can render inside details modal", () => {
  const assignSpy = jest.fn();

  render(
    <ContextStrip
      userLabel="user@example.com"
      orgLabel="Logistics"
      scopeLabel="tenant Tenant One"
      scopeType="tenant"
      scopeId="tenant-1"
      scopeOptions={scopeOptions}
      scopeSwitcherMode="details"
      onScopeChange={assignSpy}
    />
  );

  expect(screen.queryByLabelText("Change scope")).toBeNull();

  fireEvent.click(screen.getByRole("button", { name: "Details" }));

  const select = screen.getByLabelText("Change scope");
  fireEvent.change(select, { target: { value: "client::client-1" } });

  expect(assignSpy).toHaveBeenCalledWith("/console/scope/client-1");
});

test("scope switcher blocks unsafe scope URLs", () => {
  const assignSpy = jest.fn();

  render(
    <ContextStrip
      userLabel="user@example.com"
      scopeType="tenant"
      scopeId="tenant-1"
      scopeOptions={[
        {
          scope_type: "tenant",
          scope_id: "tenant-1",
          scope_label: "Tenant One",
          href: "/console/scope/tenant-1",
        },
        {
          scope_type: "client",
          scope_id: "client-2",
          scope_label: "Client Two",
          href: "javascript:alert(1)",
        },
      ]}
      onScopeChange={assignSpy}
    />
  );

  const select = screen.getByLabelText("Change scope");
  fireEvent.change(select, { target: { value: "client::client-2" } });

  expect(assignSpy).not.toHaveBeenCalled();
  expect(toastSpy).toHaveBeenCalledWith(
    expect.objectContaining({ tone: "error" })
  );
});

test("scope request link renders without options", () => {
  render(
    <ContextStrip
      scopeLabel="tenant Tenant One"
      scopeRequestHref="/console/access-policy/request"
    />
  );

  const link = screen.getByRole("link", { name: "Request scope access" });
  expect(link).toHaveAttribute(
    "href",
    expect.stringContaining("/console/access-policy/request")
  );
});

test("scope request link includes request id and reports telemetry", () => {
  const requestId = "req-scope-123";
  render(
    <ContextStrip
      scopeLabel="tenant Tenant One"
      scopeRequestHref="/console/access-policy/request"
      scopeRequestId={requestId}
    />
  );

  const link = screen.getByRole("link", { name: "Request scope access" });
  const href = new URL(link.getAttribute("href") ?? "#", "http://localhost");
  expect(href.searchParams.get("request_id")).toBe(requestId);
  fireEvent.click(link);

  expect(reporter).toHaveBeenCalledWith(
    expect.objectContaining({
      type: "ui.context_strip.scope_request.start",
      context: "ContextStrip",
      name: "scope_request.click",
      digest: requestId,
      requestId,
      meta: expect.objectContaining({
        scopeRequestHref: "/console/access-policy/request",
        requestId,
      }),
    })
  );
});

test("scope request link blocks unsafe destination", () => {
  render(
    <ContextStrip
      scopeLabel="tenant Tenant One"
      scopeRequestHref="javascript:alert(1)"
    />
  );

  const link = screen.getByRole("link", { name: "Request scope access" });
  expect(link).toHaveAttribute("href", "#");
  fireEvent.click(link);
  expect(toastSpy).toHaveBeenCalledWith(
    expect.objectContaining({ tone: "error" })
  );
});

test("sign out link blocks unsafe destination", () => {
  render(
    <ContextStrip
      userLabel="user@example.com"
      signOutHref="javascript:alert(1)"
    />
  );

  const signOut = screen.getByRole("link", { name: "Sign out" });
  expect(signOut).toHaveAttribute("href", "#");
  fireEvent.click(signOut);
  expect(toastSpy).toHaveBeenCalledWith(
    expect.objectContaining({ tone: "error" })
  );
});

test("sign out link appends request id and reports telemetry", () => {
  const requestId = "req-signout-123";
  render(
    <ContextStrip
      userLabel="user@example.com"
      signOutHref="/auth/sign-out"
      signOutRequestId={requestId}
    />
  );

  const signOut = screen.getByRole("link", { name: "Sign out" });
  const href = new URL(signOut.getAttribute("href") ?? "#", "http://localhost");
  expect(href.searchParams.get("request_id")).toBe(requestId);
  fireEvent.click(signOut);

  expect(reporter).toHaveBeenCalledWith(
    expect.objectContaining({
      type: "ui.context_strip.sign_out.start",
      context: "ContextStrip",
      name: "sign_out.click",
      digest: requestId,
      requestId,
      meta: expect.objectContaining({
        signOutHref: "/auth/sign-out",
        requestId,
      }),
    })
  );
});

test("copy controls provide an accessible label", () => {
  render(<ContextStrip settingsResolutionId="settings-1" />);

  expect(screen.getByRole("button", { name: "Copy Settings" })).toBeInTheDocument();
});

test("formats settings resolution as a readable reference", () => {
  render(<ContextStrip settingsResolutionId="e5e9f2ab-303a-4e1d-9b4b-7326a4f3e25c" />);

  const settingsValue = screen.getByText("REF-E5E9E25C");
  expect(settingsValue).toHaveAttribute(
    "title",
    "e5e9f2ab-303a-4e1d-9b4b-7326a4f3e25c"
  );
});

test("does not crash when toggling from empty to populated", () => {
  const { rerender } = render(<ContextStrip />);

  expect(screen.queryByText("user@example.com")).toBeNull();

  rerender(<ContextStrip userLabel="user@example.com" />);

  expect(screen.getByText("user@example.com")).toBeInTheDocument();
});

test("scope switcher uses a readable reference instead of a raw scope uuid when the label is missing", () => {
  render(
    <ContextStrip
      userLabel="operator@example.invalid"
      scopeType="tenant"
      scopeId="550e8400-e29b-41d4-a716-446655440001"
      scopeOptions={[
        {
          scope_type: "tenant",
          scope_id: "550e8400-e29b-41d4-a716-446655440001",
          scope_label: null,
          href: "/console/scope/tenant-1",
        },
      ]}
    />
  );

  const option = screen.getByRole("option", { name: "Tenant: REF-550E0001" });
  expect(option).toBeInTheDocument();
  expect(option).not.toHaveTextContent("550e8400-e29b-41d4-a716-446655440001");
});
