jest.mock("child_process", () => ({
  spawnSync: jest.fn(),
}));

const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawnSync } = require("child_process");
const {
  LOCAL_WEB_SERVER_PORT_FALLBACK_SCAN_LIMIT,
  parsePort,
  resolveLocalWebServerPort,
} = require("../../scripts/utils/resolve-local-web-server-port.js");

describe("resolve local web server port", () => {
  let cacheDir;
  let cachePath;

  beforeEach(() => {
    jest.clearAllMocks();
    cacheDir = fs.mkdtempSync(path.join(os.tmpdir(), "masarx-landing-port-"));
    cachePath = path.join(cacheDir, "landing-web-server-port-cache.txt");
  });

  afterEach(() => {
    fs.rmSync(cacheDir, { recursive: true, force: true });
  });

  test("parses only positive integer ports", () => {
    expect(parsePort("3333")).toBe(3333);
    expect(parsePort("0")).toBeNull();
    expect(parsePort("abc")).toBeNull();
  });

  test("returns the resolver child-process port when available", () => {
    spawnSync.mockReturnValue({
      status: 0,
      stdout: "45678\n",
    });

    expect(resolveLocalWebServerPort({ preferredPort: 3333, cachePath })).toBe(45678);
    expect(spawnSync).toHaveBeenCalledWith(
      process.execPath,
      expect.arrayContaining(["-e", expect.any(String), "127.0.0.1", "3333"]),
      expect.objectContaining({
        encoding: "utf8",
        windowsHide: true,
      }),
    );
  });

  test("scans deterministic fallback ports when the preferred port is busy", () => {
    spawnSync.mockImplementation((execPath, args) => {
      const port = Number.parseInt(String(args[3] || ""), 10);
      if (port === 3333) {
        return {
          status: 1,
          stdout: "",
        };
      }

      if (port === 3334) {
        return {
          status: 0,
          stdout: "3334\n",
        };
      }

      return {
        status: 1,
        stdout: "",
      };
    });

    expect(resolveLocalWebServerPort({ preferredPort: 3333, cachePath })).toBe(3334);
    expect(spawnSync.mock.calls.map((call) => Number.parseInt(String(call[1][3]), 10))).toEqual([
      3333,
      3334,
    ]);
    expect(LOCAL_WEB_SERVER_PORT_FALLBACK_SCAN_LIMIT).toBeGreaterThan(0);
  });

  test("re-probes a cached port before reusing it for a fresh local server", () => {
    spawnSync.mockImplementation((execPath, args) => {
      const port = Number.parseInt(String(args?.[3] || ""), 10);
      return {
        status: port === 3334 ? 0 : 1,
        stdout: port === 3334 ? "3334\n" : "",
      };
    });

    const loadResolver = () => {
      let loadedModule;
      jest.isolateModules(() => {
        loadedModule = require("../../scripts/utils/resolve-local-web-server-port.js");
      });
      return loadedModule;
    };

    const firstPort = loadResolver().resolveLocalWebServerPort({
      preferredPort: 3333,
      cachePath,
    });
    expect(firstPort).toBe(3334);
    expect(fs.readFileSync(cachePath, "utf8").trim()).toBe("3334");

    const callsAfterFirstLoad = spawnSync.mock.calls.length;
    spawnSync.mockImplementation((execPath, args) => {
      const port = Number.parseInt(String(args?.[3] || ""), 10);
      return {
        status: port === 3335 ? 0 : 1,
        stdout: port === 3335 ? "3335\n" : "",
      };
    });

    const secondPort = loadResolver().resolveLocalWebServerPort({
      preferredPort: 3333,
      cachePath,
    });

    expect(secondPort).toBe(3335);
    expect(spawnSync.mock.calls.length).toBeGreaterThan(callsAfterFirstLoad);
    expect(fs.readFileSync(cachePath, "utf8").trim()).toBe("3335");
  });

  test("allows an occupied cached port when the caller explicitly reuses an existing server", () => {
    fs.writeFileSync(cachePath, "3334\n", "utf8");
    spawnSync.mockReturnValue({
      status: 1,
      stdout: "",
    });

    expect(resolveLocalWebServerPort({
      preferredPort: 3333,
      cachePath,
      allowOccupiedCachedPort: true,
    })).toBe(3334);
  });

  test("falls back to the preferred port when the resolver child process fails", () => {
    spawnSync.mockReturnValue({
      status: 1,
      stdout: "",
    });

    expect(resolveLocalWebServerPort({ preferredPort: 3333, cachePath })).toBe(3333);
  });

  test("rejects missing preferred ports", () => {
    expect(() => resolveLocalWebServerPort({ preferredPort: 0, cachePath })).toThrow(
      "resolveLocalWebServerPort requires a positive preferredPort",
    );
  });
});
