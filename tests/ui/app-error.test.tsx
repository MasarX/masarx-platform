import * as React from "react";
import { render, screen, waitFor } from "@testing-library/react";

const reportClientError = jest.fn();

const AppShell = jest.fn(
  ({
    children,
    appName,
    layout,
    layoutMaxWidth,
  }: {
    children: React.ReactNode;
    appName: string;
    layout: string;
    layoutMaxWidth: string;
  }) => (
    <div
      data-testid="app-shell"
      data-app-name={appName}
      data-layout={layout}
      data-layout-max-width={layoutMaxWidth}
    >
      {children}
    </div>
  )
);

const PageContainer = ({ children }: { children: React.ReactNode }) => (
  <div data-testid="page-container">{children}</div>
);

const ErrorState = ({ onAction }: { onAction: () => void }) => (
  <button type="button" onClick={onAction}>
    retry
  </button>
);

const getPublicConfig = jest.fn();
const getUiDefaults = jest.fn();

jest.mock("@masarx/ui/client", () => ({
  AppShell,
  PageContainer,
  ErrorState,
  reportClientError,
}));

jest.mock("@masarx/config", () => ({
  getPublicConfig,
  getUiDefaults,
}));

import { AppErrorPage, AppGlobalErrorPage } from "../../apps/shared/app-error";

beforeEach(() => {
  reportClientError.mockReset();
  AppShell.mockClear();
  getPublicConfig.mockReset();
  getUiDefaults.mockReset();
  getPublicConfig.mockReturnValue({
    appName: "TestApp",
    locale: "en-US",
  });
  getUiDefaults.mockReturnValue({
    layout: {
      mode: "full",
      maxWidth: "1200px",
    },
  });
});

type ErrorWithDigest = Error & { digest?: string };

describe("shared AppErrorPage", () => {
  test("reports request-id extracted from error digest", async () => {
    const requestId = "3f2504e0-4f89-11d3-9a0c-0305e82c3301";
    const error = new Error("app crash") as ErrorWithDigest;
    error.digest = `request:${requestId}`;
    const reset = jest.fn();

    render(<AppErrorPage error={error} reset={reset} />);

    const button = await screen.findByRole("button", { name: "retry" });
    expect(button).toBeTruthy();

    await waitFor(() => {
      expect(reportClientError).toHaveBeenCalledTimes(1);
    });
    expect(reportClientError).toHaveBeenCalledWith(
      error,
      expect.objectContaining({
        context: "AppErrorPage",
        digest: error.digest,
        requestId,
      })
    );
  });

  test("uses request-id fallback behavior when digest contains no id-like token", async () => {
    const error = new Error("app crash") as ErrorWithDigest;
    error.digest = "plain-digest-without-token";
    const reset = jest.fn();

    render(<AppErrorPage error={error} reset={reset} />);
    await screen.findByRole("button", { name: "retry" });

    await waitFor(() => {
      expect(reportClientError).toHaveBeenCalledTimes(1);
    });
    expect(reportClientError).toHaveBeenCalledWith(
      error,
      expect.objectContaining({
        context: "AppErrorPage",
        digest: error.digest,
        requestId: undefined,
      })
    );
  });
});

describe("shared AppGlobalErrorPage", () => {
  test("applies app shell context from config and falls back safely if config is unavailable", async () => {
    getPublicConfig.mockImplementation(() => {
      throw new Error("config unavailable");
    });
    getUiDefaults.mockReturnValue({
      layout: {
        mode: "contained",
        maxWidth: "1024px",
      },
    });
    const error = new Error("global error") as ErrorWithDigest;
    error.digest = "f47ac10b-58cc-4372-a567-0e02b2c3d479";
    const reset = jest.fn();

    render(<AppGlobalErrorPage error={error} reset={reset} />);

    const shell = await screen.findByTestId("app-shell");
    expect(shell).toHaveAttribute("data-app-name", "App");
    expect(shell).toHaveAttribute("data-layout", "contained");
    expect(shell).toHaveAttribute("data-layout-max-width", "1024px");
  });
});

