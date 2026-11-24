import * as React from "react";
import { render } from "@testing-library/react";

const Passthrough = ({ children }: { children?: React.ReactNode }) => <div>{children}</div>;
const getPublicConfig = jest.fn();
const getUiDefaults = jest.fn();

jest.mock("@masarx/ui", () => ({
  AppShell: Passthrough,
  PageContainer: Passthrough,
  PageHeader: () => null,
  Section: Passthrough,
}));

jest.mock("@masarx/ui/client", () => ({
  AppShell: Passthrough,
  PageContainer: Passthrough,
  ErrorState: () => null,
  reportClientError: jest.fn(),
}));

jest.mock("@masarx/config", () => ({ getPublicConfig, getUiDefaults }));

import { AppGlobalErrorPage } from "../../apps/shared/app-error";
import { MissingEnvNotice } from "../../apps/shared/missing-env";

function rootWithLang(lang: string): Element | null {
  return document.querySelector(`[lang="${lang}"]`);
}

beforeEach(() => {
  getUiDefaults.mockReturnValue({
    layout: { mode: "full", maxWidth: "1200px" },
    rtlLocales: ["ar"],
  });
});

describe("error and missing-configuration documents set dir from the locale", () => {
  test.each([
    ["ar-SA", "rtl"],
    ["en-US", "ltr"],
  ])("global error document for %s is %s", (locale, dir) => {
    getPublicConfig.mockReturnValue({ appName: "TestApp", locale });
    render(<AppGlobalErrorPage error={new Error("boom")} reset={jest.fn()} />);
    expect(rootWithLang(locale)).toHaveAttribute("dir", dir);
  });

  test.each([
    ["ar", "rtl"],
    ["en", "ltr"],
  ])("missing-configuration document for %s is %s", (locale, dir) => {
    render(
      <MissingEnvNotice
        appName="TestApp"
        title="t"
        description="d"
        required="r"
        optional="o"
        errorLabel="e"
        locale={locale}
      />
    );
    expect(rootWithLang(locale)).toHaveAttribute("dir", dir);
  });
});
