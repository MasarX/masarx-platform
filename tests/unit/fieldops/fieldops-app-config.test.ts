const loadPublicEnvMock = jest.fn();

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
  });

  afterAll(() => {
    process.env = originalEnv;
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
