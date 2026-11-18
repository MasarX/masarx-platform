const fs = require("node:fs");
const path = require("node:path");
const { pathToFileURL } = require("node:url");

const repoRoot = path.resolve(__dirname, "../../..");
const functionsRoot = path.join(repoRoot, "supabase", "functions");

const publicIntakes = [
  "marketing-lead-intake",
  "tenant-signup-intake",
  "driver-signup-intake",
  "driver-application-status",
  "public-shipment-tracking",
];

test.each(publicIntakes)("%s applies scoped browser CORS", (name) => {
  const source = fs.readFileSync(path.join(functionsRoot, name, "index.ts"), "utf8");
  expect(source).toContain("resolveBrowserCorsPolicy(req, {");
  expect(source).not.toContain('"Access-Control-Allow-Origin": "*"');
});

test("browser intake requires an allowed origin", async () => {
  const corsPath = path.join(functionsRoot, "_shared", "cors.mjs");
  const { resolveBrowserCorsPolicy } = await import(pathToFileURL(corsPath).href);
  const url = "https://edge.example.test/intake";
  const allowedOrigin = "https://landing.example.test";
  const options = {
    hostedAllowedOrigins: allowedOrigin,
    allowedMethods: ["POST", "OPTIONS"],
  };

  const missing = resolveBrowserCorsPolicy(new Request(url, { method: "POST" }), options);
  const unlisted = resolveBrowserCorsPolicy(new Request(url, {
    method: "POST",
    headers: { origin: "https://unlisted.example.test" },
  }), options);
  const allowed = resolveBrowserCorsPolicy(new Request(url, {
    method: "POST",
    headers: { origin: allowedOrigin },
  }), options);

  expect(missing).toMatchObject({ ok: false, status: 403, body: { error: { code: "origin_required" } } });
  expect(unlisted).toMatchObject({ ok: false, status: 403, body: { error: { code: "origin_not_allowed" } } });
  expect(missing.headers["Access-Control-Allow-Origin"]).toBeUndefined();
  expect(unlisted.headers["Access-Control-Allow-Origin"]).toBeUndefined();
  expect(allowed).toMatchObject({ ok: true, headers: { "Access-Control-Allow-Origin": allowedOrigin } });
});

test("landing tracking posts the actions recognized by the edge entrypoint", () => {
  const edge = fs.readFileSync(path.join(functionsRoot, "public-shipment-tracking", "index.ts"), "utf8");
  const page = fs.readFileSync(path.join(repoRoot, "docs", "marketing", "landing-v2", "app.js"), "utf8");
  for (const [action, rpc] of [
    ["lookup", "public_tracking_lookup_v1"],
    ["verify", "public_tracking_verify_v1"],
    ["session", "public_tracking_session_v1"],
    ["request", "public_tracking_submit_request_v2"],
  ]) {
    expect(edge).toContain(`${action}: "${rpc}"`);
    expect(page).toContain(`postTracking('${action}'`);
  }
});
