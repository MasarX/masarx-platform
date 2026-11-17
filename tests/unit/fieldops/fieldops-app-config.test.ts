const loadPublicEnvMock = jest.fn();
const { spawnSync } = require("child_process");
const path = require("path");

async function loadBuildConfig() {
  jest.doMock("../../../scripts/utils/load-public-env", () => ({
    loadPublicEnv: loadPublicEnvMock,
  }));
  return (await import("../../../apps/fieldops/app.config")).default;
}

describe("fieldops app config", () => {
  const originalEnv = process.env;

  beforeEach(() => {
    jest.resetModules();
    loadPublicEnvMock.mockReset();
    process.env = { ...originalEnv };
    delete process.env.FIELDOPS_BUILD_PROFILE;
    delete process.env.EAS_BUILD;
    delete process.env.NEXT_PUBLIC_FIELDOPS_APP_ID_SUFFIX;
    delete process.env.NEXT_PUBLIC_IOS_BUNDLE_IDENTIFIER_FIELDOPS;
    delete process.env.NEXT_PUBLIC_ANDROID_PACKAGE_FIELDOPS;
    delete process.env.NEXT_PUBLIC_EAS_PROJECT_ID_FIELDOPS;
    delete process.env.NEXT_PUBLIC_LOCATION_ALWAYS_PERMISSION_FIELDOPS;
    delete process.env.NEXT_PUBLIC_APP_NAME;
    delete process.env.NEXT_PUBLIC_APP_BASE_PATH;
  });

  afterAll(() => {
    process.env = originalEnv;
  });

  test.each([
    [],
    ["@maplibre/maplibre-react-native"],
    [["@maplibre/maplibre-react-native", { existingOption: "preserved" }]],
  ].map((plugins) => [plugins]))("adds the native map plugin once and preserves existing options: %j", async (plugins) => {
    const buildConfig = await loadBuildConfig();
    const output = buildConfig({ config: { name: "Fieldops", slug: "fieldops", version: "1.0.0", plugins } } as any);
    const matches = (output.plugins as any[]).filter((entry) => (typeof entry === "string" ? entry : entry[0]) === "@maplibre/maplibre-react-native");
    expect(matches).toHaveLength(1);
    const existing = plugins.find((entry) => Array.isArray(entry));
    if (existing) expect(matches[0]).toEqual(existing);
  });

  test.each([undefined, "/", "/fieldops/", "/dev/fieldops"])("exports web resources under %s without changing native identifiers", async (basePath) => {
    if (basePath !== undefined) process.env.NEXT_PUBLIC_APP_BASE_PATH = basePath;
    const buildConfig = await loadBuildConfig();
    const output = buildConfig({ config: {
      name: "Fieldops", slug: "fieldops", experiments: { tsconfigPaths: true },
      ios: { bundleIdentifier: "existing.ios" }, android: { package: "existing.android" },
    } } as Parameters<typeof buildConfig>[0]);
    expect(output.experiments).toEqual({ tsconfigPaths: true, baseUrl: basePath?.replace(/\/+$/g, "") ?? "" });
    expect(output.ios?.bundleIdentifier).toBe("existing.ios");
    expect(output.android?.package).toBe("existing.android");
  });

  test.each(["fieldops", "//external", "/../console", "/fieldops?token=value"])("rejects non-path web prefix %s", async (basePath) => {
    process.env.NEXT_PUBLIC_APP_BASE_PATH = basePath;
    const buildConfig = await loadBuildConfig();
    expect(() => buildConfig({ config: { name: "Fieldops", slug: "fieldops" } } as Parameters<typeof buildConfig>[0]))
      .toThrow("NEXT_PUBLIC_APP_BASE_PATH must be an absolute path");
  });

  test("injects location plugin + ios background mode when missing", async () => {
    process.env.NEXT_PUBLIC_LOCATION_ALWAYS_PERMISSION_FIELDOPS = "Always allow background location.";

    const buildConfig = await loadBuildConfig();
    const output = buildConfig({
      config: {
        name: "Fieldops",
        slug: "fieldops",
        version: "1.0.0",
        plugins: [],
        ios: {},
      },
    } as any);

    const locationPlugin = (output.plugins as any[]).find(
      (entry) => Array.isArray(entry) && entry[0] === "expo-location"
    );

    expect(locationPlugin?.[1]).toEqual(
      expect.objectContaining({
        isAndroidBackgroundLocationEnabled: true,
        isIosBackgroundLocationEnabled: true,
        locationAlwaysAndWhenInUsePermission: "Always allow background location.",
      })
    );
    expect((output.ios?.infoPlist as any)?.UIBackgroundModes).toContain("location");
  });

  test("omits SDK 55 removed architecture and edge-to-edge flags", async () => {
    const buildConfig = await loadBuildConfig();
    const output = buildConfig({
      config: {
        name: "Fieldops",
        slug: "fieldops",
        version: "1.0.0",
        plugins: [],
        android: {},
      },
    } as any);

    expect(output).not.toHaveProperty("newArchEnabled");
    expect(output.android).not.toHaveProperty("edgeToEdgeEnabled");
  });

  test("keeps React Native transitive modules reachable with hierarchical lookup disabled", () => {
    const repoRoot = path.resolve(__dirname, "../../..");
    const script = [
      "const path = require('path');",
      "const config = require(path.resolve('apps/fieldops/metro.config.js'));",
      "const projectRoot = path.resolve('apps/fieldops');",
      "const reactNativeDir = path.dirname(require.resolve('react-native/package.json', { paths: [projectRoot] }));",
      "const nestedNodeModules = path.resolve(reactNativeDir, 'node_modules');",
      "if (!config.resolver.disableHierarchicalLookup) throw new Error('hierarchical lookup must stay disabled');",
      "if (!config.resolver.nodeModulesPaths.includes(nestedNodeModules)) throw new Error('missing selected React Native nested node_modules');",
    ].join("\n");

    const result = spawnSync(process.execPath, ["-e", script], {
      cwd: repoRoot,
      encoding: "utf8",
    });

    expect(result.status).toBe(0);
    expect(result.stderr).toBe("");
  });

  test("upgrades existing expo-location string plugin to configured tuple", async () => {
    const buildConfig = await loadBuildConfig();
    const output = buildConfig({
      config: {
        name: "Fieldops",
        slug: "fieldops",
        version: "1.0.0",
        plugins: ["expo-location"],
        ios: {},
      },
    } as any);

    const locationPlugin = (output.plugins as any[]).find(
      (entry) => Array.isArray(entry) && entry[0] === "expo-location"
    );

    expect(locationPlugin).toBeTruthy();
    expect(locationPlugin?.[1]).toEqual(
      expect.objectContaining({
        isAndroidBackgroundLocationEnabled: true,
        isIosBackgroundLocationEnabled: true,
      })
    );
  });

  test("merges required options into existing expo-location config", async () => {
    const buildConfig = await loadBuildConfig();
    const output = buildConfig({
      config: {
        name: "Fieldops",
        slug: "fieldops",
        version: "1.0.0",
        plugins: [["expo-location", { existingOption: "keep-me" }]],
        ios: {},
      },
    } as any);

    const locationPlugin = (output.plugins as any[]).find(
      (entry) => Array.isArray(entry) && entry[0] === "expo-location"
    );

    expect(locationPlugin?.[1]).toEqual(
      expect.objectContaining({
        existingOption: "keep-me",
        isAndroidBackgroundLocationEnabled: true,
        isIosBackgroundLocationEnabled: true,
      })
    );
  });

  test("throws when native id env is missing for production profile", async () => {
    process.env.FIELDOPS_BUILD_PROFILE = "production";

    const buildConfig = await loadBuildConfig();
    delete process.env.NEXT_PUBLIC_IOS_BUNDLE_IDENTIFIER_FIELDOPS;
    delete process.env.NEXT_PUBLIC_ANDROID_PACKAGE_FIELDOPS;
    delete process.env.NEXT_PUBLIC_EAS_PROJECT_ID_FIELDOPS;

    expect(() =>
      buildConfig({
        config: {
          name: "Fieldops",
          slug: "fieldops",
          version: "1.0.0",
          plugins: [],
          ios: {},
          android: {},
        },
      } as any)
    ).toThrow(
      "Missing required env for native builds: NEXT_PUBLIC_IOS_BUNDLE_IDENTIFIER_FIELDOPS, NEXT_PUBLIC_ANDROID_PACKAGE_FIELDOPS, NEXT_PUBLIC_EAS_PROJECT_ID_FIELDOPS"
    );
  });

  test("throws when EAS build requires native ids", async () => {
    process.env.EAS_BUILD = "true";
    process.env.NEXT_PUBLIC_IOS_BUNDLE_IDENTIFIER_FIELDOPS = "com.masarx.fieldops";

    const buildConfig = await loadBuildConfig();
    delete process.env.NEXT_PUBLIC_ANDROID_PACKAGE_FIELDOPS;
    delete process.env.NEXT_PUBLIC_EAS_PROJECT_ID_FIELDOPS;

    expect(() =>
      buildConfig({
        config: {
          name: "Fieldops",
          slug: "fieldops",
          version: "1.0.0",
          plugins: [],
          ios: {},
          android: {},
        },
      } as any)
    ).toThrow(
      "Missing required env for native builds: NEXT_PUBLIC_ANDROID_PACKAGE_FIELDOPS, NEXT_PUBLIC_EAS_PROJECT_ID_FIELDOPS"
    );
  });

  test("derives production identifiers, updates URL, and project id from env", async () => {
    process.env.FIELDOPS_BUILD_PROFILE = "production";
    process.env.NEXT_PUBLIC_FIELDOPS_APP_ID_SUFFIX = ".preview";
    process.env.NEXT_PUBLIC_IOS_BUNDLE_IDENTIFIER_FIELDOPS = "com.masarx.fieldops";
    process.env.NEXT_PUBLIC_ANDROID_PACKAGE_FIELDOPS = "com.masarx.fieldops";
    process.env.NEXT_PUBLIC_EAS_PROJECT_ID_FIELDOPS = "7f2e4d62-0a46-40ac-8f74-c98c3e8630f7";
    process.env.NEXT_PUBLIC_APP_NAME = "MasarX Field Ops";

    const buildConfig = await loadBuildConfig();
    const output = buildConfig({
      config: {
        name: "Fieldops",
        slug: "fieldops",
        version: "1.0.0",
        plugins: [],
        ios: {},
        android: {},
        updates: { enabled: true },
        extra: {},
      },
    } as any);

    expect(output.name).toBe("MasarX Field Ops");
    expect(output.slug).toBe("fieldops-eas");
    expect(output.ios?.bundleIdentifier).toBe("com.masarx.fieldops.preview");
    expect(output.android?.package).toBe("com.masarx.fieldops.preview");
    expect(output.updates?.url).toBe("https://u.expo.dev/7f2e4d62-0a46-40ac-8f74-c98c3e8630f7");
    expect((output.extra as any)?.eas?.projectId).toBe("7f2e4d62-0a46-40ac-8f74-c98c3e8630f7");
  });

  test("injects expo-notifications when missing", async () => {
    const buildConfig = await loadBuildConfig();
    const output = buildConfig({
      config: {
        name: "Fieldops",
        slug: "fieldops",
        version: "1.0.0",
        plugins: [],
        ios: {},
      },
    } as any);

    expect(output.plugins).toEqual(expect.arrayContaining(["expo-notifications"]));
  });

  test("injects sentry expo plugin when missing", async () => {
    const buildConfig = await loadBuildConfig();
    const output = buildConfig({
      config: {
        name: "Fieldops",
        slug: "fieldops",
        version: "1.0.0",
        plugins: [],
        ios: {},
      },
    } as any);

    expect(output.plugins).toEqual(expect.arrayContaining(["@sentry/react-native/expo"]));
  });

  test("keeps existing ios background modes and adds location once", async () => {
    const buildConfig = await loadBuildConfig();
    const output = buildConfig({
      config: {
        name: "Fieldops",
        slug: "fieldops",
        version: "1.0.0",
        plugins: [],
        ios: {
          infoPlist: {
            UIBackgroundModes: ["location", "remote-notification", "location"],
          },
        },
      },
    } as any);

    expect((output.ios?.infoPlist as any)?.UIBackgroundModes).toEqual([
      "location",
      "remote-notification",
    ]);
  });

  test("consumes the container public key without privileged fallback credentials", async () => {
    process.env.NEXT_PUBLIC_SUPABASE_URL = "http://127.0.0.1:58457";
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY = "container-public-anon-key";
    process.env.SUPABASE_ANON_KEY = "";
    process.env.SUPABASE_SERVICE_ROLE_KEY = "";
    process.env.VITE_SUPABASE_ANON_KEY = "legacy-vite-key-not-consumed";
    const buildConfig = await loadBuildConfig();
    const output = buildConfig({
      config: { name: "Fieldops", slug: "fieldops", version: "1.0.0", plugins: [], extra: {} },
    } as any);
    expect((output.extra as any)?.NEXT_PUBLIC_SUPABASE_URL).toBe("http://127.0.0.1:58457");
    expect((output.extra as any)?.NEXT_PUBLIC_SUPABASE_ANON_KEY).toBe("container-public-anon-key");
    expect(JSON.stringify(output.extra)).not.toContain("legacy-vite-key-not-consumed");
  });

  test("prefers SUPABASE fallback values when NEXT_PUBLIC values are placeholders", async () => {
    process.env.NEXT_PUBLIC_SUPABASE_URL = "https://example.supabase.co";
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY = "dummy-anon-key";
    process.env.SUPABASE_URL = "http://127.0.0.1:54321";
    process.env.SUPABASE_ANON_KEY = "real-anon-key";

    const buildConfig = await loadBuildConfig();
    const output = buildConfig({
      config: {
        name: "Fieldops",
        slug: "fieldops",
        version: "1.0.0",
        plugins: [],
        extra: {},
      },
    } as any);

    expect((output.extra as any)?.NEXT_PUBLIC_SUPABASE_URL).toBe("http://127.0.0.1:54321");
    expect((output.extra as any)?.NEXT_PUBLIC_SUPABASE_ANON_KEY).toBe("real-anon-key");
  });
});
