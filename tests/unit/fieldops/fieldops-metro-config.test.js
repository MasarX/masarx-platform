const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const source = fs.readFileSync(path.resolve(__dirname, "../../../apps/fieldops/metro.config.js"), "utf8");
const workspaceRoot = path.resolve("fixture-workspace");
const projectRoot = path.join(workspaceRoot, "apps", "fieldops");
const reactFile = path.join(projectRoot, "node_modules", "react", "index.js");
const nestedWorktree = path.join(workspaceRoot, ".scratch", "worktrees", "fixture", "package.json");

function loadConfig(env = {}) {
  const loads = [];
  const delegate = jest.fn(() => ({ type: "empty" }));
  const modules = new Map([
    ["fs", {
      existsSync: () => true,
      realpathSync: (file) => file,
      readdirSync: () => [{ name: ".scratch", isDirectory: () => true }],
    }],
    ["path", path],
    ["../../scripts/ops/mobile/fieldops-expo-peer-resolver.cjs", {}],
    ["expo/metro-config", {
      getDefaultConfig: () => ({ watchFolders: [workspaceRoot], resolver: { resolveRequest: delegate } }),
    }],
  ]);
  const requireModule = (name) => {
    loads.push(name);
    if (!modules.has(name)) throw new Error("Uninstalled fixture module");
    return modules.get(name);
  };
  requireModule.resolve = (request, { paths }) => request === "react"
    ? reactFile
    : path.join(paths[0], "node_modules", request);
  const module = { exports: {} };
  vm.runInNewContext(source, { require: requireModule, module, __dirname: projectRoot, process: { env } });
  return { config: module.exports, loads, delegate };
}

test("preloads Expo peer resolution and keeps the receiving workspace boundaries", () => {
  const { config, loads, delegate } = loadConfig();
  const preload = loads.indexOf("../../scripts/ops/mobile/fieldops-expo-peer-resolver.cjs");
  expect(preload).toBeGreaterThanOrEqual(0);
  expect(preload).toBeLessThan(loads.indexOf("expo/metro-config"));
  expect(config.watchFolders).not.toContain(workspaceRoot);
  expect(config.watchFolders).toContain(path.join(workspaceRoot, "packages", "mobile-core"));
  expect(config.resolver.nodeModulesPaths).toContain(path.join(projectRoot, "node_modules", "expo", "node_modules"));
  expect(config.resolver.blockList.some((pattern) => pattern.test(nestedWorktree))).toBe(true);
  expect(config.resolver.resolveRequest({}, "react", "web")).toEqual({ type: "sourceFile", filePath: reactFile });
  expect(config.resolver.resolveRequest({}, "react-native-maps", "web").filePath).toBe(
    path.join(projectRoot, "src", "mobile-map-stub-web.tsx"),
  );
  expect(config.resolver.resolveRequest({}, "fixture-module", "android")).toEqual({ type: "empty" });
  expect(delegate).toHaveBeenCalledWith({}, "fixture-module", "android");
});

test("keeps Android plain bundle negotiation and browser isolation headers", () => {
  const { config } = loadConfig({ FIELDOPS_ANDROID_METRO_PLAIN_BUNDLE: "1" });
  const request = { url: "/index.bundle", headers: { accept: "multipart/mixed, application/javascript" } };
  const response = { setHeader: jest.fn() };
  const next = jest.fn();
  config.server.enhanceMiddleware(next, {})(request, response, undefined);
  expect(request.headers.accept).toBe("application/javascript");
  expect(response.setHeader).toHaveBeenCalledWith("Cross-Origin-Embedder-Policy", "credentialless");
  expect(response.setHeader).toHaveBeenCalledWith("Cross-Origin-Opener-Policy", "same-origin");
  expect(next).toHaveBeenCalledWith(request, response, undefined);
});
