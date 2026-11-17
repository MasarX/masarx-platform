/* eslint-disable @typescript-eslint/no-require-imports -- Jest's existing .js unit lane is CommonJS. */
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const publicDir = path.resolve(__dirname, "../../../apps/fieldops/public");

test("foreground web sync preserves completion observers and verifies storage before RPC", () => {
  const app = fs.readFileSync(path.resolve(__dirname, "../../../apps/fieldops/App.tsx"), "utf8");
  expect(app.match(/const ctxQuery = useQuery\(/g)).toHaveLength(1);
  const sync = app.slice(app.indexOf("const syncMutation = useMutation({"), app.indexOf("const bootEventQueuedRef"));
  expect(sync).toContain("syncCompletionOutbox(outbox, async (rpc, args) => {");
  expect(sync.indexOf("await webStoreScope.assertCurrent();")).toBeLessThan(sync.indexOf("return executor(rpc, args);"));
  expect(sync).toContain("cacheStore, () => resolveVerifiedCompletionScope(client)");
});

test("sign-out and diagnostics clear scoped stores before logout without reopening completion admission", () => {
  const app = fs.readFileSync(path.resolve(__dirname, "../../../apps/fieldops/App.tsx"), "utf8");
  for (const start of [app.indexOf("message: strings.confirm.signOutMessage"), app.indexOf("onClearLocal={async () => {")]) {
    expect(start).toBeGreaterThanOrEqual(0);
    const clear = app.slice(start, app.indexOf('client.auth.signOut({ scope: "local" })', start));
    expect(clear).toContain("await pendingEvidence.invalidate();");
    expect(clear).toContain("clearCompletionReadbacks(() => clearEvidenceLocalState");
    expect(clear).toContain("() => outboxStore.clear(), () => cacheStore.clear()), async () => null");
  }
});

function worker(scope = "https://fieldops.example/") {
  const handlers = {};
  const cache = { addAll: jest.fn().mockResolvedValue(), put: jest.fn().mockResolvedValue(), match: jest.fn() };
  const open = jest.fn().mockResolvedValue(cache);
  const fetch = jest.fn();
  const context = vm.createContext({
    URL, fetch, caches: { open },
    self: { registration: { scope },
      clients: { claim: jest.fn().mockResolvedValue() },
      addEventListener: (name, callback) => { handlers[name] = callback; } },
  });
  vm.runInContext(fs.readFileSync(path.join(publicDir, "sw.js"), "utf8"), context);
  return { handlers, cache, fetch, open };
}

test("child worker caches its own export and never intercepts Console or sibling assets", async () => {
  const { handlers, cache, fetch, open } = worker("https://console.example/fieldops/");
  fetch.mockResolvedValue({ ok: true, clone: () => ({ text: async () =>
    '<script src="/fieldops/_expo/static/main.js"></script><script src="/_expo/static/console.js"></script>' }) });
  let pending;
  handlers.install({ waitUntil: (value) => { pending = value; } });
  await pending;
  expect(open).toHaveBeenCalledWith("fieldops-shell-v1:%2Ffieldops%2F");
  expect(Array.from(cache.addAll.mock.calls[0][0])).toEqual(["https://console.example/fieldops/_expo/static/main.js"]);
  expect(cache.put.mock.calls[0][0]).toBe("https://console.example/fieldops/index.html");
  fetch.mockClear();
  for (const url of ["https://console.example/", "https://console.example/_expo/static/console.js", "https://console.example/fieldops-other/assets/private.js"]) {
    const respondWith = jest.fn();
    handlers.fetch({ request: { method: "GET", url, mode: "navigate" }, respondWith });
    expect(respondWith).not.toHaveBeenCalled();
  }
  expect(fetch).not.toHaveBeenCalled();
});

test("child offline navigation resolves only its own shell", async () => {
  const { handlers, cache, fetch } = worker("https://console.example/fieldops/");
  const cached = { shell: true };
  cache.match.mockResolvedValue(cached);
  fetch.mockRejectedValue(new Error("offline"));
  let pending;
  handlers.fetch({ request: { method: "GET", url: "https://console.example/fieldops/", mode: "navigate" },
    respondWith: (value) => { pending = value; } });
  expect(await pending).toBe(cached);
  expect(cache.match).toHaveBeenCalledWith("https://console.example/fieldops/index.html");
});

test("install manifest links existing sized icons and Apple home-screen metadata", () => {
  const manifest = JSON.parse(fs.readFileSync(path.join(publicDir, "manifest.json"), "utf8"));
  expect(manifest).toMatchObject({ display: "standalone", scope: "./", start_url: "./" });
  for (const icon of manifest.icons) {
    const png = fs.readFileSync(path.join(publicDir, icon.src));
    expect(`${png.readUInt32BE(16)}x${png.readUInt32BE(20)}`).toBe(icon.sizes);
  }
  const html = fs.readFileSync(path.join(publicDir, "index.html"), "utf8");
  expect(html).toContain('rel="manifest"');
  expect(html).toContain('rel="apple-touch-icon"');
  expect(html).toContain('id="root"');
});

test("worker install caches only same-origin generated assets and the public shell", async () => {
  const { handlers, cache, fetch } = worker();
  fetch.mockResolvedValue({ ok: true, clone: () => ({ text: async () =>
    '<script src="/_expo/static/main.js"></script><img src="https://api.example/private"><link href="/auth/v1/user">' }) });
  let pending;
  handlers.install({ waitUntil: (value) => { pending = value; } });
  await pending;
  expect(Array.from(cache.addAll.mock.calls[0][0])).toEqual(["https://fieldops.example/_expo/static/main.js"]);
  expect(cache.put.mock.calls[0][0]).toBe("https://fieldops.example/index.html");
});

test.each([
  ["GET", "https://api.example/rest/v1/routes"],
  ["GET", "https://fieldops.example/auth/v1/user"],
  ["GET", "https://fieldops.example/_expo/static/app.js?token=private"],
  ["POST", "https://fieldops.example/_expo/static/app.js"],
])("worker leaves %s %s entirely on the network", (method, url) => {
  const { handlers, fetch } = worker();
  const respondWith = jest.fn();
  handlers.fetch({ request: { method, url }, respondWith });
  expect(respondWith).not.toHaveBeenCalled();
  expect(fetch).not.toHaveBeenCalled();
});

test("offline navigation uses the public shell, online navigation refreshes it", async () => {
  const { handlers, cache, fetch } = worker();
  const cached = { shell: true };
  cache.match.mockResolvedValue(cached);
  fetch.mockRejectedValueOnce(new Error("offline"));
  let pending;
  const event = { request: { method: "GET", url: "https://fieldops.example/", mode: "navigate" },
    respondWith: (value) => { pending = value; } };
  handlers.fetch(event);
  expect(await pending).toBe(cached);
  expect(cache.match).toHaveBeenCalledWith("https://fieldops.example/index.html");
  const online = { ok: true, clone: () => ({}) };
  fetch.mockResolvedValueOnce(online);
  handlers.fetch(event);
  expect(await pending).toBe(online);
  expect(cache.put).toHaveBeenCalled();
});

test("cache quota failure never replaces a successful online response", async () => {
  const { handlers, cache, fetch } = worker();
  const online = { ok: true, clone: () => ({}) };
  fetch.mockResolvedValue(online);
  cache.put.mockRejectedValue(new Error("quota"));
  let pending;
  handlers.fetch({ request: { method: "GET", url: "https://fieldops.example/", mode: "navigate" },
    respondWith: (value) => { pending = value; } });
  expect(await pending).toBe(online);
  expect(cache.match).not.toHaveBeenCalled();
});

test("activation removes obsolete build assets but retains current shell dependencies", async () => {
  const { handlers, cache } = worker();
  cache.match.mockResolvedValue({ text: async () => '<script src="/_expo/static/current.js"></script>' });
  cache.keys = jest.fn().mockResolvedValue([
    { url: "https://fieldops.example/index.html" },
    { url: "https://fieldops.example/_expo/static/current.js" },
    { url: "https://fieldops.example/_expo/static/old.js" },
  ]);
  cache.delete = jest.fn().mockResolvedValue(true);
  let pending;
  handlers.activate({ waitUntil: (value) => { pending = value; } });
  await pending;
  expect(cache.delete).toHaveBeenCalledTimes(1);
  expect(cache.delete).toHaveBeenCalledWith({ url: "https://fieldops.example/_expo/static/old.js" });
});

test("denied cache access never blocks a successful online response", async () => {
  const { handlers, fetch, open } = worker();
  const online = { ok: true, clone: () => ({}) };
  fetch.mockResolvedValue(online);
  open.mockRejectedValue(new Error("denied"));
  let pending;
  handlers.fetch({ request: { method: "GET", url: "https://fieldops.example/", mode: "navigate" },
    respondWith: (value) => { pending = value; } });
  expect(await pending).toBe(online);
});
