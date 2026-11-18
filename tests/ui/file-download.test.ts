import { downloadTrustedFile } from "../../packages/ui/src/file-download";

const originalFetch = global.fetch;
const originalCreate = URL.createObjectURL;
const originalRevoke = URL.revokeObjectURL;
let click: jest.SpyInstance;
let activated: HTMLAnchorElement[];
beforeEach(() => {
  jest.useFakeTimers();
  activated = [];
  URL.createObjectURL = jest.fn(() => "blob:labels");
  URL.revokeObjectURL = jest.fn();
  click = jest.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(function (this: HTMLAnchorElement) { activated.push(this); });
  global.fetch = jest.fn().mockResolvedValue({ ok: true, headers: { get: () => null }, blob: async () => new Blob(["labels"]) });
});
afterEach(() => {
  jest.runOnlyPendingTimers();
  jest.useRealTimers();
  click.mockRestore();
  global.fetch = originalFetch;
  URL.createObjectURL = originalCreate;
  URL.revokeObjectURL = originalRevoke;
  delete process.env.NEXT_PUBLIC_UI_TRUSTED_EXTERNAL_DATA_ORIGINS;
});

test.each([
  ["/labels.pdf", "include"],
  ["https://files.example.com/labels.pdf", "omit"],
])("downloads %s in-page without redirects", async (url, credentials) => {
  process.env.NEXT_PUBLIC_UI_TRUSTED_EXTERNAL_DATA_ORIGINS = "https://files.example.com";
  const open = jest.spyOn(window, "open");
  expect(await downloadTrustedFile(url)).toBe(true);
  expect(fetch).toHaveBeenCalledWith(new URL(url, window.location.origin).href, { credentials, redirect: "error", signal: expect.any(AbortSignal) });
  expect(activated[0]).toMatchObject({ href: "blob:labels", download: "labels.pdf", target: "" });
  expect(open).not.toHaveBeenCalled();
  jest.runOnlyPendingTimers();
  expect(URL.revokeObjectURL).toHaveBeenCalledWith("blob:labels");
  expect(jest.getTimerCount()).toBe(0);
  open.mockRestore();
});

test.each(["javascript:alert(1)", "https://attacker.example/labels.pdf", "https://gozqmgnvxxymxwljojkmvvkk@example.invalid/a", "http://files.example.com/a"])("blocks %s before fetching", async url => {
  process.env.NEXT_PUBLIC_UI_TRUSTED_EXTERNAL_DATA_ORIGINS = "https://files.example.com";
  expect(await downloadTrustedFile(url)).toBe(false);
  expect(fetch).not.toHaveBeenCalled();
});

test.each([
  ['attachment; filename="labels.pdf"', "labels.pdf"],
  ["attachment; filename*=UTF-8''%D9%85%D9%84%D8%B5%D9%82.pdf", "ملصق.pdf"],
  ['attachment; filename="../bad\\name.pdf"', ".._bad_name.pdf"],
])("uses safe filename from %s", async (header, expected) => {
  (fetch as jest.Mock).mockResolvedValue({ ok: true, headers: { get: () => header }, blob: async () => new Blob() });
  expect(await downloadTrustedFile("/fallback.pdf")).toBe(true);
  expect(activated[0].download).toBe(expected);
});

test("HTTP and network/CORS failures never activate downloads", async () => {
  (fetch as jest.Mock).mockResolvedValueOnce({ ok: false }).mockRejectedValueOnce(new Error("CORS"));
  expect(await downloadTrustedFile("/labels.pdf")).toBe(false);
  expect(await downloadTrustedFile("/labels.pdf")).toBe(false);
  expect(click).not.toHaveBeenCalled();
});

test("failed click still releases the object URL", async () => {
  click.mockImplementation(() => { throw new Error("click failed"); });
  expect(await downloadTrustedFile("/labels.pdf")).toBe(false);
  jest.runOnlyPendingTimers();
  expect(URL.revokeObjectURL).toHaveBeenCalledWith("blob:labels");
});

test.each(["request", "body"])("bounds a stalled %s with one download deadline", async phase => {
  let signal!: AbortSignal;
  const stalled = () => new Promise<never>((_resolve, reject) => {
    signal.addEventListener("abort", () => reject(new DOMException("Download timed out", "AbortError")), { once: true });
  });
  const body = jest.fn(stalled);
  (fetch as jest.Mock).mockImplementation((_url, options: RequestInit) => {
    signal = options.signal as AbortSignal;
    return phase === "request" ? stalled() : Promise.resolve({ ok: true, headers: { get: () => null }, blob: body });
  });
  const download = downloadTrustedFile("/labels.pdf");
  await Promise.resolve();
  if (phase === "body") expect(body).toHaveBeenCalledTimes(1);
  await jest.advanceTimersByTimeAsync(119_999);
  expect(signal.aborted).toBe(false);
  await jest.advanceTimersByTimeAsync(1);
  expect(signal.aborted).toBe(true);
  await expect(download).resolves.toBe(false);
  expect(click).not.toHaveBeenCalled();
  expect(URL.createObjectURL).not.toHaveBeenCalled();
  expect(jest.getTimerCount()).toBe(0);
});
