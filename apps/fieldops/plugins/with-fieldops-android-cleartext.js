const {
  createRunOncePlugin,
  withAndroidManifest,
  withAppBuildGradle,
  withMainApplication,
} = require("@expo/config-plugins");

const PLUGIN_NAME = "with-fieldops-android-cleartext";
const CLEAR_TEXT_PLACEHOLDER = "${fieldopsUsesCleartextTraffic}";
const GRADLE_BLOCK_BEGIN = "// @fieldops-android-cleartext-local-begin";
const GRADLE_BLOCK_END = "// @fieldops-android-cleartext-local-end";
const GRADLE_INSERT_MARKER =
  "def projectRoot = rootDir.getAbsoluteFile().getParentFile().getAbsolutePath()";
const MANIFEST_PLACEHOLDER_LINE =
  "manifestPlaceholders += [fieldopsUsesCleartextTraffic: fieldopsUsesCleartextTraffic.toString()]";
const EMBED_DEBUG_BUILD_CONFIG_LINE =
  '        buildConfigField "boolean", "FIELDOPS_EMBED_DEBUG_BUNDLE", project.ext.fieldopsEmbedDebugBundle.toString()';
const SAME_DRIVE_NATIVE_BUILD_ROOT_LINE =
  '            ?: new File((new File(projectRoot).toPath().getRoot()?.toFile() ?: new File(System.getenv(\'SystemDrive\') ?: \'C:\')), "mxn/${Integer.toHexString(projectRoot.hashCode())}").getPath()';
const NATIVE_BUILD_STAGING_LINE =
  '            buildStagingDirectory new File(project.ext.fieldopsAndroidNativeBuildRoot, "cmake")';
const APP_BUILD_DIR_LINE =
  '    buildDir = new File(project.ext.fieldopsAndroidNativeBuildRoot, "gradle-app")';
const ANDROID_BLOCK_MARKER = "android {";
const REACT_BLOCK_MARKER = "react {";
const REACT_ROOT_LINE = "    root = file(projectRoot)";
const REACT_ENTRY_FILE_LINE = '    entryFile = file("${projectRoot}/index.ts")';
const REACT_EXTRA_PACKAGER_ARGS_LINE =
  '    extraPackagerArgs = ["--entry-file", "${projectRoot}/index.ts"]';
const REACT_EMBED_DEBUG_BUNDLE_BLOCK = `
    if (project.ext.fieldopsEmbedDebugBundle) {
        debuggableVariants = []
    }
`.trimEnd();
const MAIN_APPLICATION_DEV_SUPPORT_LINE =
  "          override fun getUseDeveloperSupport(): Boolean = BuildConfig.DEBUG";
const MAIN_APPLICATION_EMBEDDED_DEV_SUPPORT_LINE =
  "          override fun getUseDeveloperSupport(): Boolean = BuildConfig.DEBUG && !BuildConfig.FIELDOPS_EMBED_DEBUG_BUNDLE";

const GRADLE_CLEAR_TEXT_BLOCK = `
${GRADLE_BLOCK_BEGIN}
def readFieldopsEnvString = { String name ->
    def value = System.getenv(name)
    if (value == null) {
        return null
    }
    def trimmed = value.trim()
    return trimmed.length() > 0 ? trimmed : null
}

def isFieldopsLocalHttpUrl = { String value ->
    if (value == null) {
        return false
    }
    try {
        def parsed = new URI(value)
        return parsed.scheme == 'http' && ['127.0.0.1', 'localhost', '192.0.2.10'].contains(parsed.host)
    } catch (Exception ignored) {
        return false
    }
}

def readFieldopsGradleString = { String name ->
    def value = findProperty(name)
    if (value == null) {
        return null
    }
    def trimmed = value.toString().trim()
    return trimmed.length() > 0 ? trimmed : null
}

def normalizeFieldopsBoolean = { String value ->
    if (value == null) {
        return false
    }
    def normalized = value.trim().toLowerCase(Locale.ROOT)
    return normalized == '1' || normalized == 'true' || normalized == 'yes'
}

def normalizeFieldopsLocalPath = { String value ->
    if (value == null) {
        return null
    }
    def fileValue = new File(value)
    return fileValue.isAbsolute() ? fileValue : new File(rootDir, value)
}

def fieldopsBuildProfile = readFieldopsEnvString('FIELDOPS_BUILD_PROFILE')
def fieldopsIsEasBuild = readFieldopsEnvString('EAS_BUILD') == 'true'
def fieldopsAndroidEmulatorSupabaseUrl = readFieldopsEnvString('FIELDOPS_ANDROID_EMULATOR_SUPABASE_URL')
def fieldopsRequestedNativeBuildRoot =
        readFieldopsGradleString('fieldops.android.nativeBuildRoot')
        ?: readFieldopsEnvString('FIELDOPS_ANDROID_NATIVE_BUILD_ROOT')
def fieldopsEmbedDebugBundle = normalizeFieldopsBoolean(
        readFieldopsGradleString('fieldops.android.embedDebugBundle')
        ?: readFieldopsEnvString('FIELDOPS_ANDROID_EMBED_DEBUG_BUNDLE')
)
def fieldopsResolvedSupabaseUrl =
        fieldopsAndroidEmulatorSupabaseUrl
        ?: readFieldopsEnvString('NEXT_PUBLIC_SUPABASE_URL')
        ?: readFieldopsEnvString('SUPABASE_URL')
def fieldopsUsesCleartextTraffic =
        !fieldopsIsEasBuild && fieldopsBuildProfile == null && isFieldopsLocalHttpUrl(fieldopsResolvedSupabaseUrl)
def fieldopsUsesLocalAndroidBuildRoots = !fieldopsIsEasBuild && fieldopsBuildProfile == null
def fieldopsAndroidNativeBuildRoot = fieldopsUsesLocalAndroidBuildRoots
        ? normalizeFieldopsLocalPath(
            fieldopsRequestedNativeBuildRoot
${SAME_DRIVE_NATIVE_BUILD_ROOT_LINE}
        )
        : null
project.ext.fieldopsAndroidNativeBuildRoot = fieldopsAndroidNativeBuildRoot
project.ext.fieldopsEmbedDebugBundle = fieldopsEmbedDebugBundle

if (fieldopsAndroidEmulatorSupabaseUrl != null) {
    if (fieldopsIsEasBuild || fieldopsBuildProfile != null) {
        throw new GradleException('FIELDOPS_ANDROID_EMULATOR_SUPABASE_URL is local-only and cannot be used with EAS_BUILD or FIELDOPS_BUILD_PROFILE.')
    }
    if (!isFieldopsLocalHttpUrl(fieldopsAndroidEmulatorSupabaseUrl)) {
        throw new GradleException('FIELDOPS_ANDROID_EMULATOR_SUPABASE_URL must be a local http URL for Android emulator builds.')
    }
}
if (fieldopsRequestedNativeBuildRoot != null && !fieldopsUsesLocalAndroidBuildRoots) {
    throw new GradleException('FIELDOPS_ANDROID_NATIVE_BUILD_ROOT and fieldops.android.nativeBuildRoot are local-only and cannot be used with EAS_BUILD or FIELDOPS_BUILD_PROFILE.')
}
if (fieldopsEmbedDebugBundle && !fieldopsUsesLocalAndroidBuildRoots) {
    throw new GradleException('FIELDOPS_ANDROID_EMBED_DEBUG_BUNDLE and fieldops.android.embedDebugBundle are local-only and cannot be used with EAS_BUILD or FIELDOPS_BUILD_PROFILE.')
}
if (project.ext.fieldopsAndroidNativeBuildRoot != null) {
${APP_BUILD_DIR_LINE}
}
${GRADLE_BLOCK_END}
`.trim();

function getMainApplication(androidManifest) {
  const applications = androidManifest?.manifest?.application;
  if (!Array.isArray(applications) || applications.length === 0) {
    throw new Error(`[${PLUGIN_NAME}] AndroidManifest.xml is missing an application node.`);
  }
  const application = applications[0];
  application.$ = application.$ || {};
  return application;
}

function applyAndroidManifestCleartextPlaceholder(androidManifest) {
  const application = getMainApplication(androidManifest);
  application.$["android:usesCleartextTraffic"] = CLEAR_TEXT_PLACEHOLDER;
  return androidManifest;
}

function applyFieldopsCleartextGradle(contents) {
  let next = contents;

  if (!next.includes(GRADLE_BLOCK_BEGIN)) {
    if (!next.includes(GRADLE_INSERT_MARKER)) {
      throw new Error(`[${PLUGIN_NAME}] Could not find projectRoot marker in app/build.gradle.`);
    }
    next = next.replace(
      GRADLE_INSERT_MARKER,
      `${GRADLE_INSERT_MARKER}\n\n${GRADLE_CLEAR_TEXT_BLOCK}`
    );
  }

  if (!next.includes(MANIFEST_PLACEHOLDER_LINE)) {
    const versionNamePattern = /(\n\s*versionName\s+["'][^"']+["']\s*\n)/;
    if (!versionNamePattern.test(next)) {
      throw new Error(`[${PLUGIN_NAME}] Could not find defaultConfig versionName in app/build.gradle.`);
    }
    next = next.replace(versionNamePattern, `$1        ${MANIFEST_PLACEHOLDER_LINE}\n`);
  }

  if (!next.includes(EMBED_DEBUG_BUILD_CONFIG_LINE)) {
    const manifestPlaceholderPattern = new RegExp(
      `(${MANIFEST_PLACEHOLDER_LINE.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\n)`
    );
    if (manifestPlaceholderPattern.test(next)) {
      next = next.replace(manifestPlaceholderPattern, `$1${EMBED_DEBUG_BUILD_CONFIG_LINE}\n`);
    } else {
      const versionNamePattern = /(\n\s*versionName\s+["'][^"']+["']\s*\n)/;
      if (!versionNamePattern.test(next)) {
        throw new Error(`[${PLUGIN_NAME}] Could not find defaultConfig versionName in app/build.gradle.`);
      }
      next = next.replace(versionNamePattern, `$1${EMBED_DEBUG_BUILD_CONFIG_LINE}\n`);
    }
  }

  return next;
}

function applyFieldopsNativeBuildGradle(contents) {
  let next = contents;

  if (!next.includes(ANDROID_BLOCK_MARKER)) {
    throw new Error(`[${PLUGIN_NAME}] Could not find android block in app/build.gradle.`);
  }

  if (!next.includes(NATIVE_BUILD_STAGING_LINE)) {
    const namespacePattern = /(\n\s*namespace\s+['"][^'"]+['"]\s*\n)/;
    if (!namespacePattern.test(next)) {
      throw new Error(`[${PLUGIN_NAME}] Could not find android namespace in app/build.gradle.`);
    }
    next = next.replace(
      namespacePattern,
      `$1    if (project.ext.fieldopsAndroidNativeBuildRoot != null) {\n        externalNativeBuild {\n            cmake {\n${NATIVE_BUILD_STAGING_LINE}\n            }\n        }\n    }\n`
    );
  }

  return next;
}

function applyFieldopsMainApplicationDevSupport(contents) {
  if (contents.includes(MAIN_APPLICATION_EMBEDDED_DEV_SUPPORT_LINE)) {
    return contents;
  }
  if (!contents.includes(MAIN_APPLICATION_DEV_SUPPORT_LINE)) {
    throw new Error(`[${PLUGIN_NAME}] Could not find getUseDeveloperSupport in MainApplication.`);
  }
  return contents.replace(
    MAIN_APPLICATION_DEV_SUPPORT_LINE,
    MAIN_APPLICATION_EMBEDDED_DEV_SUPPORT_LINE
  );
}

function applyFieldopsReactNativeGradleRoot(contents) {
  let next = contents;

  if (!next.includes(REACT_BLOCK_MARKER)) {
    throw new Error(`[${PLUGIN_NAME}] Could not find react block in app/build.gradle.`);
  }

  const reactBlockWithRootPattern = /react\s*\{[\s\S]*?\n\s*root\s*=/;
  if (!reactBlockWithRootPattern.test(next)) {
    next = next.replace(REACT_BLOCK_MARKER, `${REACT_BLOCK_MARKER}\n${REACT_ROOT_LINE}`);
  } else {
    next = next.replace(/\n\s*root\s*=\s*file\(["'][^"']+["']\)/, `\n${REACT_ROOT_LINE}`);
  }

  const reactBlockWithEntryPattern = /react\s*\{[\s\S]*?\n\s*entryFile\s*=/;
  if (reactBlockWithEntryPattern.test(next)) {
    next = next.replace(/\n\s*entryFile\s*=\s*file\([^\n]+\)/, `\n${REACT_ENTRY_FILE_LINE}`);
  } else {
    next = next.replace(REACT_ROOT_LINE, `${REACT_ROOT_LINE}\n${REACT_ENTRY_FILE_LINE}`);
  }

  const reactBlockWithExtraPackagerArgsPattern =
    /react\s*\{[\s\S]*?\n\s*extraPackagerArgs\s*=/;
  if (reactBlockWithExtraPackagerArgsPattern.test(next)) {
    next = next.replace(
      /\n\s*extraPackagerArgs\s*=\s*\[[^\n]+\]/,
      `\n${REACT_EXTRA_PACKAGER_ARGS_LINE}`
    );
  } else {
    next = next.replace(REACT_ENTRY_FILE_LINE, `${REACT_ENTRY_FILE_LINE}\n${REACT_EXTRA_PACKAGER_ARGS_LINE}`);
  }

  if (!next.includes(REACT_EMBED_DEBUG_BUNDLE_BLOCK)) {
    next = next.replace(
      REACT_EXTRA_PACKAGER_ARGS_LINE,
      `${REACT_EXTRA_PACKAGER_ARGS_LINE}\n${REACT_EMBED_DEBUG_BUNDLE_BLOCK}`
    );
  }

  return next;
}

function withFieldopsAndroidManifestCleartext(config) {
  return withAndroidManifest(config, (nextConfig) => {
    nextConfig.modResults = applyAndroidManifestCleartextPlaceholder(nextConfig.modResults);
    return nextConfig;
  });
}

function withFieldopsAndroidGradleCleartext(config) {
  return withAppBuildGradle(config, (nextConfig) => {
    if (nextConfig.modResults.language !== "groovy") {
      throw new Error(`[${PLUGIN_NAME}] Only Groovy app/build.gradle is supported.`);
    }
    nextConfig.modResults.contents = applyFieldopsNativeBuildGradle(
      applyFieldopsReactNativeGradleRoot(applyFieldopsCleartextGradle(nextConfig.modResults.contents))
    );
    return nextConfig;
  });
}

function withFieldopsMainApplication(config) {
  return withMainApplication(config, (nextConfig) => {
    if (nextConfig.modResults.language !== "kt") {
      throw new Error(`[${PLUGIN_NAME}] Only Kotlin MainApplication is supported.`);
    }
    nextConfig.modResults.contents = applyFieldopsMainApplicationDevSupport(
      nextConfig.modResults.contents
    );
    return nextConfig;
  });
}

function withFieldopsAndroidCleartext(config) {
  let nextConfig = withFieldopsAndroidManifestCleartext(config);
  nextConfig = withFieldopsAndroidGradleCleartext(nextConfig);
  nextConfig = withFieldopsMainApplication(nextConfig);
  return nextConfig;
}

module.exports = createRunOncePlugin(withFieldopsAndroidCleartext, PLUGIN_NAME, "1.0.0");
module.exports.applyAndroidManifestCleartextPlaceholder = applyAndroidManifestCleartextPlaceholder;
module.exports.applyFieldopsCleartextGradle = applyFieldopsCleartextGradle;
module.exports.applyFieldopsNativeBuildGradle = applyFieldopsNativeBuildGradle;
module.exports.applyFieldopsReactNativeGradleRoot = applyFieldopsReactNativeGradleRoot;
module.exports.applyFieldopsMainApplicationDevSupport = applyFieldopsMainApplicationDevSupport;
module.exports.APP_BUILD_DIR_LINE = APP_BUILD_DIR_LINE;
module.exports.EMBED_DEBUG_BUILD_CONFIG_LINE = EMBED_DEBUG_BUILD_CONFIG_LINE;
module.exports.CLEAR_TEXT_PLACEHOLDER = CLEAR_TEXT_PLACEHOLDER;
module.exports.GRADLE_BLOCK_BEGIN = GRADLE_BLOCK_BEGIN;
module.exports.MANIFEST_PLACEHOLDER_LINE = MANIFEST_PLACEHOLDER_LINE;
module.exports.SAME_DRIVE_NATIVE_BUILD_ROOT_LINE = SAME_DRIVE_NATIVE_BUILD_ROOT_LINE;
module.exports.NATIVE_BUILD_STAGING_LINE = NATIVE_BUILD_STAGING_LINE;
module.exports.REACT_ROOT_LINE = REACT_ROOT_LINE;
module.exports.REACT_ENTRY_FILE_LINE = REACT_ENTRY_FILE_LINE;
module.exports.REACT_EXTRA_PACKAGER_ARGS_LINE = REACT_EXTRA_PACKAGER_ARGS_LINE;
module.exports.REACT_EMBED_DEBUG_BUNDLE_BLOCK = REACT_EMBED_DEBUG_BUNDLE_BLOCK;
module.exports.MAIN_APPLICATION_EMBEDDED_DEV_SUPPORT_LINE = MAIN_APPLICATION_EMBEDDED_DEV_SUPPORT_LINE;
