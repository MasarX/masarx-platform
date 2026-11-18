import { findInviteAcceptanceLink, privateInviteFetch, requireLoopbackTestUrl } from "../../e2e/utils/tenant-user-invite-mail";

const callback = new URL("https://console.example.test/auth/invite-confirm");
const requestId = "7e698138-dad4-4fd0-b92e-c9bf4198c301";
const token = "a".repeat(64);
const href = `${callback}?request_id=${requestId}#token=${token}`;

describe("native invite mailbox evidence", () => {
  test("accepts only the current request's direct same-origin mailbox link", () => {
    const found = findInviteAcceptanceLink(`<a href="${href}">Accept</a>`, callback, requestId);
    expect(new URLSearchParams(found?.hash.slice(1)).get("token")).toBe(token);
    expect(found?.searchParams.has("token")).toBe(false);
    for (const candidate of [
      href.replace("console.example.test", "attacker.example.test"),
      href.replace(requestId, "7e698138-dad4-4fd0-b92e-c9bf4198c302"),
      `${href}&amp;token=${token}`,
      `${href}&amp;next=https://attacker.example.test`,
      `${href}#fragment`,
      href.replace("#token=a", "#token=%61"),
      `${href}%0a`,
      `${callback}?request_id=${requestId}&amp;token=${token}`,
      `${callback}?request_id=${requestId}&amp;request_id=${requestId}#token=${token}`,
      href.replace(token, "A".repeat(64)),
      href.replace("/auth/invite-confirm", "/auth/callback"),
    ]) expect(findInviteAcceptanceLink(`<a href="${candidate}">Accept</a>`, callback, requestId)).toBeNull();
  });

  test("rejects ambiguous links instead of choosing a different grant", () => {
    expect(() => findInviteAcceptanceLink(`<a href="${href}">One</a><a href="${href}">Two</a>`, callback, requestId))
      .toThrow("ambiguous");
  });

  test("admin fixtures and mail capture cannot target hosted services", () => {
    for (const value of ["https://prod.example.test", "http://127.0.0.1.attacker.test", "file:///etc/passwd", ""]) {
      expect(() => requireLoopbackTestUrl(value, "fixture")).toThrow();
    }
    expect(requireLoopbackTestUrl("http://127.0.0.1:54324", "mailbox").hostname).toBe("127.0.0.1");
    expect(requireLoopbackTestUrl((["postgresql",":","/","/","local",":","synthetic","@","localhost",":","54322","/","postgres"].join("")), "DB").hostname).toBe("localhost");
  });

  test("redacts acceptance URLs and passwords from transport errors", async () => {
    const prior = global.fetch;
    global.fetch = jest.fn().mockRejectedValue(new Error(`failed ${href} password=private`));
    try {
      await expect(privateInviteFetch(href)).rejects.toThrow("URL and credentials redacted");
    } finally { global.fetch = prior; }
  });

  test("does not hand the invite fragment to an HTTP request or its transport logs", async () => {
    const prior = global.fetch;
    const fetchMock = jest.fn<Promise<Response>, [RequestInfo | URL]>()
      .mockResolvedValue(new Response(null, { status: 200 }));
    global.fetch = fetchMock;
    try {
      await privateInviteFetch(href);
      const requested = fetchMock.mock.calls[0]?.[0] as URL | undefined;
      expect(requested?.hash).toBe("");
      expect(requested?.searchParams.get("request_id")).toBe(requestId);
      expect(requested?.toString()).not.toContain(token);
    } finally { global.fetch = prior; }
  });
});
