import { act, renderHook } from "@testing-library/react";
import { useAssets } from "../../packages/ui/src/label-designer/use-label-designer-data";
import { initialState } from "../../packages/ui/src/label-designer/use-label-designer-store";

const mockFunctionsInvoke = jest.fn();
const mockGetSession = jest.fn();

jest.mock("@masarx/api", () => ({
  createUiClient: jest.fn(() => ({})),
}));

jest.mock("@masarx/auth/browser", () => ({
  createBrowserClient: jest.fn(() => ({
    auth: { getSession: mockGetSession },
    functions: { invoke: mockFunctionsInvoke },
  })),
}));

jest.mock("@masarx/config", () => ({
  getPublicConfig: jest.fn(() => ({ supabaseAnonKey: "anon-key" })),
}));

const originalTrustedExternalDataOrigins =
  process.env.NEXT_PUBLIC_UI_TRUSTED_EXTERNAL_DATA_ORIGINS;

describe("useAssets openAsset", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    process.env.NEXT_PUBLIC_UI_TRUSTED_EXTERNAL_DATA_ORIGINS =
      "https://cdn.example.com";
    mockGetSession.mockResolvedValue({
      data: { session: { access_token: "user-jwt" } },
      error: null,
    });
  });

  afterEach(() => {
    if (originalTrustedExternalDataOrigins === undefined) {
      delete process.env.NEXT_PUBLIC_UI_TRUSTED_EXTERNAL_DATA_ORIGINS;
    } else {
      process.env.NEXT_PUBLIC_UI_TRUSTED_EXTERNAL_DATA_ORIGINS =
        originalTrustedExternalDataOrigins;
    }
    jest.restoreAllMocks();
  });

  test.each([
    ["untrusted origin", "https://cdn.example.com.evil.test/tenant/logo.png"],
    ["absolute backslash URL", String.raw`https:\\cdn.example.com\tenant\logo.png`],
  ])("blocks a %s before window.open and surfaces a safe error", async (_name, signedUrl) => {
    mockFunctionsInvoke.mockResolvedValue({
      data: { ok: true, signed_url: signedUrl },
      error: null,
    });
    const openMock = jest.spyOn(window, "open").mockReturnValue(null);
    const dispatch = jest.fn();
    const { result } = renderHook(() =>
      useAssets(
        { ...initialState, capabilities: ["label_design.read"] },
        dispatch,
      ),
    );

    await act(async () => {
      await expect(result.current.openAsset("tenant/logo.png")).rejects.toThrow(
        "Signed URL origin is not trusted.",
      );
    });

    expect(openMock).not.toHaveBeenCalled();
  });

  test("opens an exact trusted signed URL in a protected new tab", async () => {
    mockFunctionsInvoke.mockResolvedValue({
      data: {
        ok: true,
        signed_url: "https://cdn.example.com/tenant/logo.png",
      },
      error: null,
    });
    const openedWindow = { location: null } as unknown as Window;
    const openMock = jest.spyOn(window, "open").mockReturnValue(openedWindow);
    const dispatch = jest.fn();
    const { result } = renderHook(() =>
      useAssets(
        { ...initialState, capabilities: ["label_design.read"] },
        dispatch,
      ),
    );

    await act(async () => {
      await expect(result.current.openAsset("tenant/logo.png")).resolves.toBeUndefined();
    });

    expect(openMock).toHaveBeenCalledTimes(1);
    expect(openMock).toHaveBeenCalledWith(
      "https://cdn.example.com/tenant/logo.png",
      "_blank",
      "noopener,noreferrer",
    );
  });
});
