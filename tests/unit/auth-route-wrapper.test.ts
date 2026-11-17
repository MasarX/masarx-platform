import { GET as consoleAuthCallbackGet } from "../../apps/console/app/auth/callback/route";
import { GET as portalAuthCallbackGet } from "../../apps/portal/app/auth/callback/route";
import { GET as consoleSignOutGet } from "../../apps/console/app/auth/sign-out/route";
import { GET as portalSignOutGet } from "../../apps/portal/app/auth/sign-out/route";

import {
  handleAuthCallback,
  handleSignOut,
} from "@masarx/auth";

jest.mock("@masarx/auth", () => ({
  handleAuthCallback: jest.fn(),
  handleSignOut: jest.fn(),
}));

const requestFor = (path: string, init: RequestInit = {}) =>
  new Request(`https://example.test${path}`, init);

const requestIdHeader = "wrapper-route-req";
const requestIdFromQuery = "query-id-42";
const makeRedirect = (location: string, requestId = requestIdHeader) =>
  new Response(null, {
    status: 302,
    headers: {
      location: location,
      "x-request-id": requestId,
    },
  });

const mockHandleAuthCallback = handleAuthCallback as jest.MockedFunction<
  typeof handleAuthCallback
>;
const mockHandleSignOut = handleSignOut as jest.MockedFunction<
  typeof handleSignOut
>;

beforeEach(() => {
  mockHandleAuthCallback.mockReset();
  mockHandleSignOut.mockReset();
  mockHandleAuthCallback.mockResolvedValue(
    makeRedirect("https://example.test/console")
  );
  mockHandleSignOut.mockResolvedValue(
    makeRedirect("https://example.test/console")
  );
});

describe("auth route wrappers", () => {
  test("console auth callback route forwards request into callback handler", async () => {
    const request = requestFor("/console/auth/callback", {
      headers: { "x-request-id": requestIdHeader },
    });

    const response = await consoleAuthCallbackGet(request);

    expect(mockHandleAuthCallback).toHaveBeenCalledTimes(1);
    expect(mockHandleAuthCallback).toHaveBeenCalledWith(request);
    expect(response.headers.get("x-request-id")).toBe(requestIdHeader);
    expect(response.headers.get("location")).toBe("https://example.test/console");
  });

  test("portal auth callback route forwards request into callback handler with query request id", async () => {
    const request = requestFor(
      `/portal/auth/callback?next=/portal/home&request_id=${requestIdFromQuery}`
    );
    mockHandleAuthCallback.mockResolvedValue(
      makeRedirect("https://example.test/portal/home", requestIdFromQuery)
    );

    const response = await portalAuthCallbackGet(request);

    expect(mockHandleAuthCallback).toHaveBeenCalledTimes(1);
    expect(mockHandleAuthCallback).toHaveBeenCalledWith(request);
    expect(response.headers.get("x-request-id")).toBe(requestIdFromQuery);
    expect(response.headers.get("location")).toBe("https://example.test/portal/home");
  });

  test("console sign-out route forwards request into sign-out handler", async () => {
    const request = requestFor("/console/auth/sign-out", {
      headers: { "x-request-id": requestIdHeader },
    });

    const response = await consoleSignOutGet(request);

    expect(mockHandleSignOut).toHaveBeenCalledTimes(1);
    expect(mockHandleSignOut).toHaveBeenCalledWith(request);
    expect(response.headers.get("x-request-id")).toBe(requestIdHeader);
    expect(response.headers.get("location")).toBe("https://example.test/console");
  });

  test("portal sign-out route forwards request into sign-out handler", async () => {
    const request = requestFor("/portal/auth/sign-out", {
      headers: { "x-request-id": requestIdHeader },
    });
    mockHandleSignOut.mockResolvedValue(
      makeRedirect("https://example.test/portal")
    );

    const response = await portalSignOutGet(request);

    expect(mockHandleSignOut).toHaveBeenCalledTimes(1);
    expect(mockHandleSignOut).toHaveBeenCalledWith(request);
    expect(response.headers.get("x-request-id")).toBe(requestIdHeader);
    expect(response.headers.get("location")).toBe("https://example.test/portal");
  });
});
