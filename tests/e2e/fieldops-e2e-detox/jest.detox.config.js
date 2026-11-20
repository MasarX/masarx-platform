/**
 * Jest config for the Detox E2E runner (P3.9). Kept separate from the unit
 * and UI Jest configs so Detox timeouts and the detox/runners/jest preset
 * do not pollute the rest of the suite.
 */

/** @type {import('jest').Config} */
module.exports = {
  rootDir: __dirname,
  testEnvironment: "detox/runners/jest/testEnvironment",
  testRunner: "jest-circus/runner",
  testMatch: ["<rootDir>/**/*.e2e.ts", "<rootDir>/**/*.e2e.js"],
  reporters: ["detox/runners/jest/reporter"],
  globalSetup: "detox/runners/jest/globalSetup",
  globalTeardown: "detox/runners/jest/globalTeardown",
  verbose: true,
  testTimeout: 180_000,
  maxWorkers: 1,
};
