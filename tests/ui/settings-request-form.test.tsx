import { fireEvent, screen } from "@testing-library/react";
import { SettingsRequestForm } from "../../packages/ui/src/settings-request-form";
import { renderWithIntl } from "./test-utils";

let state = { status: "idle" as const, message: undefined as string | undefined };
let isPending = false;

jest.mock("next-intl", () => {
  const actual = jest.requireActual("next-intl");
  return {
    ...actual,
    useTranslations: () => (key: string) => key,
  };
});

jest.mock("react", () => {
  const actual = jest.requireActual("react");
  return {
    ...actual,
    useActionState: () => [state, jest.fn(), isPending],
  };
});

describe("SettingsRequestForm", () => {
  beforeEach(() => {
    state = { status: "idle" as const, message: undefined };
    isPending = false;
  });

  it("prompts before navigation when settings request form has unsaved edits", () => {
    const confirmSpy = jest.spyOn(window, "confirm").mockReturnValue(false);

    renderWithIntl(
      <SettingsRequestForm
        action={async () => ({ status: "success" })}
        categories={[
          {
            category: "ui_table_views",
            description: "Manage table metadata",
            requestCapability: "settings.request.write",
            allowedScopes: ["global"],
          },
        ]}
        selectedCategory="ui_table_views"
        selectedScopeType="global"
        selectedScopeId=""
        defaultSettingsJson='{"resources":{}}'
        previewResolutionId="res-1"
        previewScopeType="global"
        previewScopeId=""
        previewSettingsVersionId="sv-1"
        previewError={null}
        testIdPrefix="settings-request"
        previewHref="/portal/settings/request"
      />
    );

    fireEvent.change(screen.getByTestId("settings-request-request-reason"), {
      target: { value: "urgent review" },
    });

    const externalLink = document.createElement("a");
    externalLink.href = "/portal/settings";
    externalLink.textContent = "leave";
    document.body.appendChild(externalLink);

    fireEvent.click(externalLink);

    expect(confirmSpy).toHaveBeenCalledWith(
      "unsavedWarning"
    );

    externalLink.remove();
    confirmSpy.mockRestore();
  });

  it("does not prompt when settings request form is clean", () => {
    const confirmSpy = jest.spyOn(window, "confirm").mockReturnValue(false);

    renderWithIntl(
      <SettingsRequestForm
        action={async () => ({ status: "success" })}
        categories={[
          {
            category: "ui_table_views",
            description: "Manage table metadata",
            requestCapability: "settings.request.write",
            allowedScopes: ["global"],
          },
        ]}
        selectedCategory="ui_table_views"
        selectedScopeType="global"
        selectedScopeId=""
        defaultSettingsJson='{"resources":{}}'
        previewResolutionId="res-1"
        previewScopeType="global"
        previewScopeId=""
        previewSettingsVersionId="sv-1"
        previewError={null}
        testIdPrefix="settings-request"
        previewHref="/portal/settings/request"
      />
    );

    const externalLink = document.createElement("a");
    externalLink.href = "/portal/settings";
    externalLink.textContent = "leave";
    document.body.appendChild(externalLink);

    fireEvent.click(externalLink);

    expect(confirmSpy).not.toHaveBeenCalled();

    externalLink.remove();
    confirmSpy.mockRestore();
  });
});


describe("label provider credential handling", () => {
  beforeEach(() => { state = { status: "idle" as const, message: undefined }; isPending = false; });
it("provider form masks and clears secret after successful submission", () => {
  const props = { action: async () => ({ status: "success" as const }), categories: [{ category: "label_provider", allowedScopes: ["tenant"] }],
    selectedCategory: "label_provider", selectedScopeType: "tenant", selectedScopeId: "tenant",
    defaultSettingsJson: "", providerConfigured: false, testIdPrefix: "provider", previewHref: "/settings/request" };
  const view = renderWithIntl(<SettingsRequestForm {...props} />);
  const secret = screen.getByLabelText("provider.secret");
  expect(secret).toHaveAttribute("type", "password"); expect(secret).toHaveValue("");
  expect(screen.queryByTestId("provider-request-json")).not.toBeInTheDocument();
  fireEvent.change(secret, { target: { value: "entered-sentinel" } });
  state = { status: "success" as never, message: undefined };
  view.rerender(<SettingsRequestForm {...props} />);
  expect(secret).toHaveValue("");
});

it.each(["category", "scope-type", "scope-id"])("clears entered provider credentials when %s changes", (selection) => {
  state = { status: "idle" as const, message: undefined };
  const props = { action: async () => ({ status: "success" as const }),
    categories: [{ category: "label_provider", allowedScopes: ["tenant", "global"] }, { category: "other", allowedScopes: ["tenant"] }],
    selectedCategory: "label_provider", selectedScopeType: "tenant", selectedScopeId: "tenant",
    defaultSettingsJson: "", providerConfigured: false, testIdPrefix: "clear-provider", previewHref: "/settings/request" };
  renderWithIntl(<SettingsRequestForm {...props} />);
  const secret = screen.getByLabelText("provider.secret");
  const url = screen.getByLabelText("provider.url");
  fireEvent.change(secret, { target: { value: "entered-sentinel" } });
  fireEvent.change(url, { target: { value: "https://renderer.example.test" } });
  fireEvent.change(screen.getByTestId("clear-provider-preview-" + selection), {
    target: { value: selection === "category" ? "other" : selection === "scope-type" ? "global" : "another-tenant" },
  });
  expect(secret).toHaveValue(""); expect(url).toHaveValue("");
});
});
