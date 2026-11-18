jest.mock("../../packages/auth/src/server", () => ({
  createServerClient: () => ({
    auth: {
      signOut,
      exchangeCodeForSession,
    },
  }),
}));

import { handleAuthCallback, handleSignOut } from "../../packages/auth/src/next";

const signOut = jest.fn();
const exchangeCodeForSession = jest.fn();
const originalConsoleInfo = console.info;

const requestFor = (path, init) =>
  new Request(`https://example.test${path}`, init);

function parseRedirect(response) {
  return new URL(response.headers.get("location"), "https://example.test").href;
}

beforeEach(() => {
  console.info = jest.fn();
  signOut.mockReset();
  signOut.mockResolvedValue({});
  exchangeCodeForSession.mockReset();
  exchangeCodeForSession.mockResolvedValue({ data: null, error: null });
});

afterEach(() => {
  console.info = originalConsoleInfo;
});

test("handleSignOut defaults to canonical root path", async () => {
  process.env.NEXT_PUBLIC_APP_BASE_PATH = "/console";
  const response = await handleSignOut(
    requestFor("/console/auth/sign-out", {
      headers: { "sec-fetch-site": "same-origin" },
    })
  );
  expect(signOut).toHaveBeenCalledTimes(1);
  expect(signOut).toHaveBeenCalledWith({ scope: "local" });
  expect(parseRedirect(response)).toBe("https://example.test/");
  expect(response.headers.get("x-request-id")).toBeTruthy();
  expect(console.info).toHaveBeenCalledWith(
    "auth.route",
    expect.stringContaining("auth.sign_out.start")
  );
});

test("handleSignOut falls back to root when app base path is missing", async () => {
  delete process.env.NEXT_PUBLIC_APP_BASE_PATH;
  const response = await handleSignOut(
    requestFor("/portal/auth/sign-out", {
      headers: { "sec-fetch-site": "same-origin" },
    })
  );
  expect(signOut).toHaveBeenCalledTimes(1);
  expect(signOut).toHaveBeenCalledWith({ scope: "local" });
  expect(parseRedirect(response)).toBe("https://example.test/");
  expect(response.headers.get("x-request-id")).toBeTruthy();
});

test("handleSignOut rejects unsafe external redirect paths", async () => {
  process.env.NEXT_PUBLIC_APP_BASE_PATH = "/portal";
  const response = await handleSignOut(
    requestFor("/portal/auth/sign-out", {
      headers: { "sec-fetch-site": "same-origin" },
    }),
    { redirectPath: "https://evil.example/shell" }
  );
  expect(parseRedirect(response)).toBe("https://example.test/");
});

test("handleSignOut supports explicit safe app-relative redirect", async () => {
  process.env.NEXT_PUBLIC_APP_BASE_PATH = "/portal";
  const response = await handleSignOut(
    requestFor("/portal/auth/sign-out", {
      headers: { "sec-fetch-site": "same-origin" },
    }),
    { redirectPath: "/portal/sign-in" }
  );
  expect(parseRedirect(response)).toBe("https://example.test/sign-in");
});

test("handleSignOut handles sign-out failures with safe error redirect", async () => {
  process.env.NEXT_PUBLIC_APP_BASE_PATH = "/portal";
  signOut.mockRejectedValueOnce(new Error("server rejected logout"));
  const response = await handleSignOut(
    requestFor("/portal/auth/sign-out", {
      headers: { "sec-fetch-site": "same-origin" },
    }),
    { redirectPath: "/portal/sign-in" }
  );
  expect(parseRedirect(response))
    .toBe("https://example.test/sign-in?error=server+rejected+logout");
  expect(console.info).toHaveBeenCalledWith(
    "auth.route",
    expect.stringContaining("auth.sign_out.failure")
  );
});

test("handleSignOut blocks cross-site browser requests", async () => {
  process.env.NEXT_PUBLIC_APP_BASE_PATH = "/portal";
  const response = await handleSignOut(
    requestFor("/portal/auth/sign-out", {
      headers: { "sec-fetch-site": "cross-site" },
    })
  );
  expect(signOut).not.toHaveBeenCalled();
  expect(response.status).toBe(403);
});

test("handleAuthCallback defaults to canonical root path when next is missing", async () => {
  process.env.NEXT_PUBLIC_APP_BASE_PATH = "/console";
  const response = await handleAuthCallback(
    requestFor("/console/auth/callback")
  );
  expect(parseRedirect(response)).toBe("https://example.test/");
  expect(console.info).toHaveBeenCalledWith(
    "auth.route",
    expect.stringContaining("auth.callback.success")
  );
  expect(response.headers.get("x-request-id")).toBeTruthy();
});

test("handleAuthCallback uses safe next parameter for redirect", async () => {
  process.env.NEXT_PUBLIC_APP_BASE_PATH = "/console";
  const response = await handleAuthCallback(
    requestFor("/console/auth/callback?next=/console/home")
  );
  expect(parseRedirect(response)).toBe("https://example.test/home");
});

test("handleAuthCallback does not exchange session when code is missing", async () => {
  process.env.NEXT_PUBLIC_APP_BASE_PATH = "/console";
  exchangeCodeForSession.mockResolvedValueOnce({
    data: null,
    error: null,
  });
  const response = await handleAuthCallback(
    requestFor("/console/auth/callback?next=/console/dashboard")
  );
  expect(exchangeCodeForSession).not.toHaveBeenCalled();
  expect(parseRedirect(response)).toBe("https://example.test/dashboard");
});

test("handleAuthCallback rejects empty code string as missing code input", async () => {
  process.env.NEXT_PUBLIC_APP_BASE_PATH = "/console";
  const response = await handleAuthCallback(
    requestFor("/console/auth/callback?code=&next=/console/home")
  );
  expect(exchangeCodeForSession).not.toHaveBeenCalled();
  expect(parseRedirect(response)).toBe("https://example.test/home");
});

test("handleAuthCallback rejects unsafe next values and falls back to app base path", async () => {
  process.env.NEXT_PUBLIC_APP_BASE_PATH = "/console";
  const response = await handleAuthCallback(
    requestFor("/console/auth/callback?next=https://evil.example/dashboard")
  );
  expect(parseRedirect(response)).toBe("https://example.test/");
});

test("handleAuthCallback preserves request correlation id from header", async () => {
  process.env.NEXT_PUBLIC_APP_BASE_PATH = "/console";
  const request = requestFor("/console/auth/callback", {
    headers: { "x-request-id": "route-req-123" },
  });
  const response = await handleAuthCallback(request);
  expect(response.headers.get("x-request-id")).toBe("route-req-123");
});

test("handleAuthCallback reads request correlation id from query param", async () => {
  process.env.NEXT_PUBLIC_APP_BASE_PATH = "/portal";
  const request = requestFor("/portal/auth/callback?next=/portal/home&request_id=magic-link-abc");
  const response = await handleAuthCallback(request);
  expect(response.headers.get("x-request-id")).toBe("magic-link-abc");
});

test("handleAuthCallback normalizes malformed request id query values", async () => {
  process.env.NEXT_PUBLIC_APP_BASE_PATH = "/portal";
  const request = requestFor(
    "/portal/auth/callback?next=/portal/home&request_id=bad<id>%20value"
  );
  const response = await handleAuthCallback(request);
  expect(response.headers.get("x-request-id")).toBe("badidvalue");
});

test("handleAuthCallback handles exchange-code errors and surfaces safe message", async () => {
  exchangeCodeForSession.mockResolvedValueOnce({
    data: null,
    error: { message: "expired_code" },
  });
  process.env.NEXT_PUBLIC_APP_BASE_PATH = "/console";
  const response = await handleAuthCallback(
    requestFor("/console/auth/callback?code=abc123")
  );
  expect(parseRedirect(response))
    .toBe("https://example.test/?error=expired_code");
  expect(console.info).toHaveBeenCalledWith(
    "auth.route",
    expect.stringContaining("auth.callback.exchange_error")
  );
});

test("handleAuthCallback never logs authorization code fragments on exchange errors", async () => {
  const code = "private-authorization-code-123456789";
  exchangeCodeForSession.mockResolvedValueOnce({
    data: null,
    error: { message: "expired_code" },
  });

  const response = await handleAuthCallback(
    requestFor(`/auth/callback?code=${code}`)
  );

  expect(response.status).toBe(307);
  const logs = JSON.stringify((console.info as jest.Mock).mock.calls);
  expect(logs).toContain("auth.callback.exchange_error");
  expect(logs).not.toContain(code.slice(0, 16));
  expect(logs).not.toContain("codePrefix");
});

test("handleAuthCallback treats exchange exceptions as internal-safe failure", async () => {
  process.env.NEXT_PUBLIC_APP_BASE_PATH = "/console";
  exchangeCodeForSession.mockRejectedValueOnce(new Error("unexpected-failure"));
  const response = await handleAuthCallback(
    requestFor("/console/auth/callback?code=bad")
  );
  expect(parseRedirect(response))
    .toBe("https://example.test/?error=unexpected-failure");
  expect(console.info).toHaveBeenCalledWith(
    "auth.route",
    expect.stringContaining("auth.callback.failure")
  );
});

test("handleAuthCallback sanitizes external error text before redirect", async () => {
  process.env.NEXT_PUBLIC_APP_BASE_PATH = "/console";
  const response = await handleAuthCallback(
    requestFor(
      "/console/auth/callback?error_description=server%0AError%3A%20%3Cscript%3Eevil%3C/script%3E"
    )
  );
  expect(parseRedirect(response))
    .toBe("https://example.test/?error=server+error%3A+%3Cscript%3Eevil%3C%2Fscript%3E");
  expect(console.info).toHaveBeenCalledWith(
    "auth.route",
    expect.stringContaining("auth.callback.blocked.external_error")
  );
});

test.each(["console", "portal"])(
  "%s callback redirects preserve the browser origin behind an internal bind URL",
  async (app) => {
    const publicOrigin = "https://public.example.test";
    for (const [next, expected] of [
      ["https://untrusted.example.test/account", "/"],
      ["//untrusted.example.test/account", "/"],
      ["/\\untrusted.example.test/account", "/"],
      ["/resources/shipments?status=ready#details", "/resources/shipments?status=ready#details"],
    ]) {
      const request = new Request(
        `http://0.0.0.0:5175/${app}/auth/callback?next=${encodeURIComponent(next)}`,
        {
          headers: {
            host: "untrusted.example.test",
            "x-forwarded-host": "untrusted.example.test",
            "x-forwarded-proto": "https",
          },
        },
      );
      const response = await handleAuthCallback(request);
      expect(response.status).toBe(307);
      expect(response.headers.get("location")).toBe(expected);
      expect(new URL(response.headers.get("location")!, publicOrigin).origin).toBe(publicOrigin);
      expect(response.headers.get("x-request-id")).toBeTruthy();
    }
    expect(exchangeCodeForSession).not.toHaveBeenCalled();
  },
);

test.each(["external", "exchange", "exception"])(
  "callback %s errors retain an app-relative redirect behind an internal bind URL",
  async (failure) => {
    if (failure === "exchange") {
      exchangeCodeForSession.mockResolvedValueOnce({ error: { message: "expired_code" } });
    } else if (failure === "exception") {
      exchangeCodeForSession.mockRejectedValueOnce(new Error("expired_code"));
    }
    const query = failure === "external" ? "error=expired_code" : "code=synthetic-code";
    const response = await handleAuthCallback(
      new Request(`http://0.0.0.0:5175/auth/callback?${query}&next=/resources`),
    );
    expect(response.status).toBe(307);
    expect(response.headers.get("location")).toBe("/resources?error=expired_code");
  },
);

test.each([false, true])(
  "sign-out preserves relative redirects behind an internal bind URL (failure=%s)",
  async (failure) => {
    if (failure) signOut.mockRejectedValueOnce(new Error("logout_failed"));
    const response = await handleSignOut(new Request("http://0.0.0.0:5175/auth/sign-out", {
      headers: {
        host: "untrusted.example.test",
        "x-forwarded-host": "untrusted.example.test",
        "x-forwarded-proto": "https",
        "sec-fetch-site": "same-origin",
      },
    }), { redirectPath: "/sign-in" });
    expect(response.status).toBe(307);
    expect(response.headers.get("location")).toBe(
      failure ? "/sign-in?error=logout_failed" : "/sign-in",
    );
    expect(signOut).toHaveBeenCalledWith({ scope: "local" });
  },
);

test.each(["/.//untrusted.example.test", "/safe/..//untrusted.example.test"])(
  "relative redirects keep one leading slash after normalizing %s",
  async (path) => {
    const request = new Request("http://0.0.0.0:5175/auth/callback");
    const fallbackResponse = await handleAuthCallback(request, { defaultRedirectPath: path });
    const nextResponse = await handleAuthCallback(new Request(
      `http://0.0.0.0:5175/auth/callback?next=${encodeURIComponent(`${path}?status=ready#details`)}`,
    ));
    const signOutResponse = await handleSignOut(
      new Request("http://0.0.0.0:5175/auth/sign-out"),
      { redirectPath: path },
    );
    for (const response of [fallbackResponse, nextResponse, signOutResponse]) {
      const location = response.headers.get("location")!;
      expect(location).toMatch(/^\/(?![\\/])/);
      expect(new URL(location, "https://public.example.test").origin).toBe("https://public.example.test");
    }
  },
);
