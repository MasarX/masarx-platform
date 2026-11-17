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
