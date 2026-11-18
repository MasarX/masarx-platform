const cleartextPlugin = require("../../../apps/fieldops/plugins/with-fieldops-android-cleartext");

describe("fieldops Android native manifest config", () => {
  test("writes the local-only cleartext placeholder into the Android manifest", () => {
    const manifest = {
      manifest: {
        application: [
          {
            $: {
              "android:name": ".MainApplication",
            },
          },
        ],
      },
    };

    const output = cleartextPlugin.applyAndroidManifestCleartextPlaceholder(manifest);

    expect(output.manifest.application[0].$["android:usesCleartextTraffic"]).toBe(
      cleartextPlugin.CLEAR_TEXT_PLACEHOLDER
    );
  });

  test("injects the local-only Gradle gate and manifest placeholder once", () => {
    const input = `
apply plugin: "com.android.application"

def projectRoot = rootDir.getAbsoluteFile().getParentFile().getAbsolutePath()

android {
    defaultConfig {
        versionName "0.1.0"
    }
}
`.trim();

    const once = cleartextPlugin.applyFieldopsCleartextGradle(input);
    const twice = cleartextPlugin.applyFieldopsCleartextGradle(once);

    expect(once).toContain(cleartextPlugin.GRADLE_BLOCK_BEGIN);
    expect(once).toContain("FIELDOPS_ANDROID_EMULATOR_SUPABASE_URL");
    expect(once).toContain("FIELDOPS_ANDROID_NATIVE_BUILD_ROOT");
    expect(once).toContain("FIELDOPS_ANDROID_EMBED_DEBUG_BUNDLE");
    expect(once).toContain("fieldops.android.nativeBuildRoot");
    expect(once).toContain("fieldops.android.embedDebugBundle");
    expect(once).toContain("fieldopsBuildProfile == null");
    expect(once).toContain("!fieldopsIsEasBuild");
    expect(once).toContain(cleartextPlugin.SAME_DRIVE_NATIVE_BUILD_ROOT_LINE);
    expect(once).toContain(cleartextPlugin.APP_BUILD_DIR_LINE);
    expect(once).toContain(cleartextPlugin.MANIFEST_PLACEHOLDER_LINE);
    expect(once).toContain(cleartextPlugin.EMBED_DEBUG_BUILD_CONFIG_LINE);
    expect(twice).toBe(once);
  });

  test("injects local native CMake staging once", () => {
    const input = `
apply plugin: "com.android.application"

android {
    namespace 'co.masarx.fieldops.dev'
    defaultConfig {
        versionName "0.1.0"
    }
}
`.trim();

    const once = cleartextPlugin.applyFieldopsNativeBuildGradle(input);
    const twice = cleartextPlugin.applyFieldopsNativeBuildGradle(once);

    expect(once).toContain(cleartextPlugin.NATIVE_BUILD_STAGING_LINE);
    expect(once).toContain("if (project.ext.fieldopsAndroidNativeBuildRoot != null)");
    expect(twice).toBe(once);
  });

  test("pins React Native Android bundling to the FieldOps app root once", () => {
    const input = `
apply plugin: "com.android.application"

react {
    entryFile = file("index.ts")
}
`.trim();

    const once = cleartextPlugin.applyFieldopsReactNativeGradleRoot(input);
    const twice = cleartextPlugin.applyFieldopsReactNativeGradleRoot(once);

    expect(once).toContain(cleartextPlugin.REACT_ROOT_LINE);
    expect(once).toContain(cleartextPlugin.REACT_ENTRY_FILE_LINE);
    expect(once).toContain(cleartextPlugin.REACT_EXTRA_PACKAGER_ARGS_LINE);
    expect(once).toContain(cleartextPlugin.REACT_EMBED_DEBUG_BUNDLE_BLOCK);
    expect(twice).toBe(once);
  });

  test("disables developer support only for embedded debug bundle proof builds", () => {
    const input = `
package co.masarx.fieldops.dev

class MainApplication {
          override fun getUseDeveloperSupport(): Boolean = BuildConfig.DEBUG
}
`.trim();

    const once = cleartextPlugin.applyFieldopsMainApplicationDevSupport(input);
    const twice = cleartextPlugin.applyFieldopsMainApplicationDevSupport(once);

    expect(once).toContain(cleartextPlugin.MAIN_APPLICATION_EMBEDDED_DEV_SUPPORT_LINE);
    expect(twice).toBe(once);
  });
});
