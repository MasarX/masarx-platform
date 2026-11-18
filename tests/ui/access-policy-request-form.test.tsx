import type * as React from "react";

let actionState: {
  status: "idle" | "error" | "success";
  message?: string;
  settingsVersionId?: string;
  domainEventId?: string;
} = { status: "idle" };

let actionPending = false;

jest.mock("next-intl", () => {
  const actual = jest.requireActual("next-intl");
  return {
    ...actual,
    useTranslations: () => (key: string) => key,
  };
});

jest.mock("react", () => {
  const actual = jest.requireActual("react") as typeof React;
  return {
    ...actual,
    useActionState: () => [actionState, jest.fn(), actionPending],
  };
});

import { fireEvent, screen } from "@testing-library/react";
import { AccessPolicyRequestForm } from "../../packages/ui/src/access-policy-request-form";
import { renderWithIntl } from "./test-utils";

describe("AccessPolicyRequestForm", () => {
  beforeEach(() => {
    actionState = { status: "idle" };
    actionPending = false;
  });

  it("requires policy changes before submit becomes available", () => {
    renderWithIntl(
      <AccessPolicyRequestForm
        action={async () => ({ status: "success" })}
        defaultPolicyJson='{"capabilities":[]}'
        defaultScopeType="tenant"
        defaultScopeId="tenant-1"
        testIdPrefix="access-policy-request"
      />
    );

    const submitButton = screen.getByTestId("access-policy-request-submit");
    expect(submitButton).toBeDisabled();
    expect(screen.getByText("actions.updateHint")).toBeInTheDocument();
    expect(screen.queryByText('{"capabilities":[]}')).not.toBeInTheDocument();
    expect(screen.getByText("editor.advancedHidden")).toBeInTheDocument();
  });

  it("shows submitting state while pending", () => {
    actionPending = true;
    renderWithIntl(
      <AccessPolicyRequestForm
        action={async () => ({ status: "success" })}
        defaultPolicyJson='{"capabilities":[{"key":"shipments.read"}]}'
        defaultScopeType="tenant"
        defaultScopeId="tenant-1"
        testIdPrefix="access-policy-request"
      />
    );

    const submitButton = screen.getByTestId("access-policy-request-submit");
    expect(submitButton).toBeDisabled();
    expect(screen.getByText("actions.submitting")).toBeInTheDocument();
  });

  it("renders request success state and identifiers", () => {
    actionState = {
      status: "success",
      settingsVersionId: "sv-1",
      domainEventId: "de-1",
    };

    renderWithIntl(
      <AccessPolicyRequestForm
        action={async () => ({ status: "success" })}
        defaultPolicyJson='{"capabilities":[]}'
        defaultScopeType="tenant"
        defaultScopeId="tenant-1"
        testIdPrefix="access-policy-request"
      />
    );

    expect(screen.getByTestId("access-policy-request-success")).toBeInTheDocument();
    expect(screen.getByText("success.settingsVersionLabel")).toBeInTheDocument();
    expect(screen.getByText("sv-1")).toBeInTheDocument();
    expect(screen.getByText("de-1")).toBeInTheDocument();
  });

  it("renders request error state", () => {
    actionState = {
      status: "error",
      message: "Policy request rejected",
    };

    renderWithIntl(
      <AccessPolicyRequestForm
        action={async () => ({ status: "error", message: "Policy request rejected" })}
        defaultPolicyJson='{"capabilities":[]}'
        defaultScopeType="tenant"
        defaultScopeId="tenant-1"
        testIdPrefix="access-policy-request"
      />
    );

    expect(screen.getByTestId("access-policy-request-error")).toBeInTheDocument();
    expect(screen.getByText("Policy request rejected")).toBeInTheDocument();
  });

  it("does not mutate policy state from unrelated edits", () => {
    const action = jest.fn(async () => ({ status: "success" as const }));
    renderWithIntl(
      <AccessPolicyRequestForm
        action={action}
        defaultPolicyJson='{"capabilities":[{"key":"shipments.read","label":"Shipments"}]}'
        defaultScopeType="tenant"
        defaultScopeId="tenant-1"
        testIdPrefix="access-policy-request"
      />
    );

    fireEvent.click(screen.getByTestId("access-policy-request-policy-toggle"));

    expect(screen.getByTestId("access-policy-request-policy-editor")).toBeInTheDocument();
  });

  it("disables submit when raw JSON is invalid", () => {
    renderWithIntl(
      <AccessPolicyRequestForm
        action={async () => ({ status: "success" })}
        defaultPolicyJson='{"capabilities":[]}'
        defaultScopeType="tenant"
        defaultScopeId="tenant-1"
        testIdPrefix="access-policy-request"
      />
    );

    fireEvent.click(screen.getByTestId("access-policy-request-policy-toggle"));

    const rawField = screen.getByTestId("access-policy-request-policy-raw");
    fireEvent.change(rawField, {
      target: { value: "{invalid-json" },
    });

    expect(screen.getByTestId("access-policy-request-policy-error")).toBeInTheDocument();
    expect(screen.getByText("errors.invalidJson")).toBeInTheDocument();
    expect(screen.getByTestId("access-policy-request-submit")).toBeDisabled();
  });

  it("prompts before navigating away when access-policy form has unsaved edits", () => {
    const confirmSpy = jest.spyOn(window, "confirm").mockReturnValue(false);

    renderWithIntl(
      <AccessPolicyRequestForm
        action={async () => ({ status: "success" })}
        defaultPolicyJson='{"capabilities":[{"key":"shipments.read"}]}'
        defaultScopeType="tenant"
        defaultScopeId="tenant-1"
        testIdPrefix="access-policy-request"
      />
    );

    fireEvent.change(screen.getByTestId("access-policy-request-scope-id"), {
      target: { value: "tenant-2" },
    });

    const externalLink = document.createElement("a");
    externalLink.href = "/console/settings";
    externalLink.textContent = "leave";
    document.body.appendChild(externalLink);

    fireEvent.click(externalLink);

    expect(confirmSpy).toHaveBeenCalledWith(
      "unsavedWarning"
    );

    externalLink.remove();
    confirmSpy.mockRestore();
  });

  it("does not prompt when access-policy form has no unsaved edits", () => {
    const confirmSpy = jest.spyOn(window, "confirm").mockReturnValue(false);

    renderWithIntl(
      <AccessPolicyRequestForm
        action={async () => ({ status: "success" })}
        defaultPolicyJson='{"capabilities":[{"key":"shipments.read"}]}'
        defaultScopeType="tenant"
        defaultScopeId="tenant-1"
        testIdPrefix="access-policy-request"
      />
    );

    const externalLink = document.createElement("a");
    externalLink.href = "/console/settings";
    externalLink.textContent = "leave";
    document.body.appendChild(externalLink);

    fireEvent.click(externalLink);

    expect(confirmSpy).not.toHaveBeenCalled();

    externalLink.remove();
    confirmSpy.mockRestore();
  });
});

test("shows a friendly locked scope and submits canonical fields", () => {
  render(
    <AccessPolicyRequestForm
      action={async () => ({ status: "idle" })}
      testIdPrefix="example-policy"
      defaultScopeType="tenant"
      defaultScopeId="00000000-0000-4000-8000-000000000151"
      defaultScopeLabel="Example Tenant"
      defaultPolicyJson="{}"
      lockScope
    />
  );
  expect(screen.getByText("Example Tenant")).toBeInTheDocument();
  const data = new FormData(screen.getByTestId("example-policy-form") as HTMLFormElement);
  expect(data.get("scope_type")).toBe("tenant");
  expect(data.get("scope_id")).toBe("00000000-0000-4000-8000-000000000151");
});
