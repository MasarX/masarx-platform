import { GET, POST } from "../../apps/portal/app/delivery-signing/route";

const origin = "https://portal.example.invalid";
const upstream = "https://backend.example.invalid";
const pageUrl = `${origin}/delivery-signing`;
const nonce = "a".repeat(32);
const token = "b".repeat(64);
const environment = process.env;

beforeEach(() => {
  process.env = { ...environment, CONTACTLESS_POD_SIGNING_ORIGIN: origin, NEXT_PUBLIC_SUPABASE_URL: upstream };
});

afterEach(() => {
  process.env = environment;
  jest.restoreAllMocks();
});

test("serves a non-cacheable signing page only on the configured HTTPS origin", async () => {
  const page = GET(new Request(pageUrl, { headers: { "x-nonce": nonce } }));
  expect(page.status).toBe(200);
  expect(page.headers.get("Cache-Control")).toBe("no-store");
  expect(page.headers.get("Referrer-Policy")).toBe("no-referrer");
  expect(page.headers.get("Content-Security-Policy")).toContain(`'nonce-${nonce}'`);
  expect(await page.text()).toContain(`src="/delivery-signing.js" nonce="${nonce}"`);
  expect(GET(new Request("https://foreign.example.invalid/delivery-signing")).status).toBe(404);
  delete process.env.CONTACTLESS_POD_SIGNING_ORIGIN;
  expect(GET(new Request(pageUrl)).status).toBe(404);
});

test("renders Arabic signing instructions and status messages right to left", async () => {
  const response = GET(new Request(pageUrl, { headers: { "accept-language": "ar-SA,en;q=0.8" } }));
  const html = await response.text();
  expect(html).toContain('<html lang="ar" dir="rtl">');
  expect(html).toContain('data-received="تم استلام التوقيع."');
});

function post(source: string = origin, signingToken: string = token, mime = "image/png") {
  return new Request(pageUrl, {
    method: "POST",
    headers: { Origin: source, "Content-Type": mime, "Content-Length": "12", "X-Signing-Token": signingToken, Cookie: "fixture=ignored" },
    body: "fixture body",
  });
}

test("rejects foreign origins and invalid signature envelopes before contacting intake", async () => {
  const fetchStub = jest.spyOn(globalThis, "fetch").mockResolvedValue(new Response(null, { status: 204 }));
  expect((await POST(post("https://foreign.example.invalid"))).status).toBe(403);
  expect((await POST(post(origin, "invalid"))).status).toBe(400);
  expect((await POST(post(origin, token, "text/plain"))).status).toBe(400);
  delete process.env.CONTACTLESS_POD_SIGNING_ORIGIN;
  expect((await POST(post())).status).toBe(403);
  expect(fetchStub).not.toHaveBeenCalled();
});

test.each([[204, 204], [409, 409], [500, 503]])(
  "forwards only the signature envelope and reports intake status %i as %i",
  async (status, expected) => {
    const fetchStub = jest.spyOn(globalThis, "fetch").mockResolvedValue(new Response(null, { status }));
    expect((await POST(post())).status).toBe(expected);
    const [endpoint, options] = fetchStub.mock.calls[0];
    expect(String(endpoint)).toBe(`${upstream}/functions/v1/contactless-pod-intake`);
    expect(options?.redirect).toBe("error");
    expect(options?.headers).toEqual({ Origin: origin, "Content-Type": "image/png", "Content-Length": "12", "X-Signing-Token": token });
    expect(await new Response(options?.body).text()).toBe("fixture body");
  },
);

test("rejects undeclared, oversized and inconsistent request lengths before forwarding", async () => {
  const fetchStub = jest.spyOn(globalThis, "fetch");
  const missing = post();
  missing.headers.delete("Content-Length");
  expect((await POST(missing)).status).toBe(411);
  const tooLarge = post();
  tooLarge.headers.set("Content-Length", String(1024 * 1024 + 1));
  expect((await POST(tooLarge)).status).toBe(413);
  const mismatch = post();
  mismatch.headers.set("Content-Length", "11");
  expect((await POST(mismatch)).status).toBe(400);
  expect(fetchStub).not.toHaveBeenCalled();
});

test("rejects an oversized stream even with an allowed declared length", async () => {
  const fetchStub = jest.spyOn(globalThis, "fetch");
  const request = new Request(pageUrl, {
    method: "POST",
    headers: {
      Origin: origin, "Content-Type": "image/png", "Content-Length": String(1024 * 1024), "X-Signing-Token": token,
    },
    body: new Uint8Array(1024 * 1024 + 1),
  });
  expect((await POST(request)).status).toBe(413);
  expect(fetchStub).not.toHaveBeenCalled();
});
