import { validateTrustedBrowserRequest } from "../../packages/auth/src/request-guard";

describe("auth request guard", () => {
  test("allows same-origin browser requests", () => {
    const request = new Request("https://unjijvxjrwurjgsnokovrvom.example.invalid/auth/sign-out", {
      method: "GET",
      headers: {
        "sec-fetch-site": "same-origin",
        referer: "https://unjijvxjrwurjgsnokovrvom.example.invalid/dashboard",
      },
    });

    expect(validateTrustedBrowserRequest(request)).toEqual({ ok: true });
  });

  test("allows browser requests that match forwarded host origin", () => {
    const request = new Request("http://localhost:3001/api/ui-event", {
      method: "POST",
      headers: {
        host: "127.0.0.1:3001",
        origin: "http://127.0.0.1:3001",
        referer: "http://127.0.0.1:3001/resources/labels",
        "sec-fetch-site": "same-origin",
        "content-type": "application/json",
      },
      body: JSON.stringify({ event: { type: "ui.click" } }),
    });

    expect(validateTrustedBrowserRequest(request, { requireJson: true })).toEqual({
      ok: true,
    });
  });

  test("blocks explicit cross-site browser requests", () => {
    const request = new Request("https://unjijvxjrwurjgsnokovrvom.example.invalid/auth/sign-out", {
      method: "GET",
      headers: {
        "sec-fetch-site": "cross-site",
      },
    });

    expect(validateTrustedBrowserRequest(request)).toMatchObject({
      ok: false,
      status: 403,
      code: "cross_site_request_rejected",
    });
  });

  test("blocks origin mismatch", () => {
    const request = new Request("https://unjijvxjrwurjgsnokovrvom.example.invalid/api/ui-event", {
      method: "POST",
      headers: {
        origin: "https://evil.example",
        "content-type": "application/json",
      },
      body: JSON.stringify({ event: { type: "ui.click" } }),
    });

    expect(validateTrustedBrowserRequest(request, { requireJson: true })).toMatchObject({
      ok: false,
      status: 403,
      code: "origin_mismatch",
    });
  });

  test("allows localhost and 127.0.0.1 as equivalent local origins", () => {
    const request = new Request("http://localhost:3001/api/resource-import", {
      method: "POST",
      headers: {
        origin: "http://127.0.0.1:3001",
      },
    });

    expect(validateTrustedBrowserRequest(request)).toEqual({ ok: true });
  });

  test("requires application/json when requested", () => {
    const request = new Request("https://unjijvxjrwurjgsnokovrvom.example.invalid/api/ui-event", {
      method: "POST",
      headers: {
        "sec-fetch-site": "same-origin",
        "content-type": "text/plain",
      },
      body: "{}",
    });

    expect(validateTrustedBrowserRequest(request, { requireJson: true })).toMatchObject({
      ok: false,
      status: 415,
      code: "unsupported_content_type",
    });
  });
});
