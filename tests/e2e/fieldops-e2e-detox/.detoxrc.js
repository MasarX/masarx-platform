/**
 * Detox configuration for FieldOps mobile E2E (P3.9).
 *
 * This scaffold is opt-in: Detox binaries are not installed in CI and no
 * workflow invokes this configuration yet. See `./README.md` for the full
 * install + run flow. Device matrix mirrors the Maestro smoke targets so
 * flows translate cleanly from smoke to native E2E.
 */

const path = require('path');

const FIELDOPS_ROOT = path.resolve(__dirname, '..', '..', '..', 'apps', 'fieldops');
const IOS_APP_PATH = path.join(
  FIELDOPS_ROOT,
  'ios',
  'build',
  'Build',
  'Products',
  'Debug-iphonesimulator',
  'FieldOps.app'
);
const ANDROID_APP_PATH = path.join(
  FIELDOPS_ROOT,
  'android',
  'app',
  'build',
  'outputs',
  'apk',
  'debug',
  'app-debug.apk'
);

/** @type {import('detox/config').DetoxConfig} */
module.exports = {
  testRunner: {
    args: {
      config: path.join(__dirname, 'jest.detox.config.js'),
      _: ['**/*.e2e.ts', '**/*.e2e.js'],
    },
    jest: {
      setupTimeout: 180_000,
    },
  },
  apps: {
    'ios.debug': {
      type: 'ios.app',
      binaryPath: IOS_APP_PATH,
      build: `cd ${FIELDOPS_ROOT} && xcodebuild -workspace ios/FieldOps.xcworkspace -scheme FieldOps -configuration Debug -sdk iphonesimulator -derivedDataPath ios/build`,
    },
    'android.debug': {
      type: 'android.apk',
      binaryPath: ANDROID_APP_PATH,
      build: `cd ${FIELDOPS_ROOT} && ./android/gradlew -p android assembleDebug assembleAndroidTest -DtestBuildType=debug`,
    },
  },
  devices: {
    'ios.simulator': {
      type: 'ios.simulator',
      device: {
        type: 'iPhone 15',
      },
    },
    'android.emulator': {
      type: 'android.emulator',
      device: {
        avdName: 'Pixel_7_API_35',
      },
    },
  },
  configurations: {
    'ios.sim.debug': {
      device: 'ios.simulator',
      app: 'ios.debug',
    },
    'android.emu.debug': {
      device: 'android.emulator',
      app: 'android.debug',
    },
  },
  logger: {
    level: 'info',
  },
  artifacts: {
    rootDir: path.join(__dirname, '.artifacts'),
    plugins: {
      log: 'failing',
      screenshot: 'failing',
      video: 'failing',
      timeline: 'failing',
    },
  },
  behavior: {
    init: {
      reinstallApp: true,
      exposeGlobals: false,
    },
    cleanup: {
      shutdownDevice: false,
    },
  },
};
