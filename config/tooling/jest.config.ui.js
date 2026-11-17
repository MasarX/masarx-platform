const path = require("path");
const { pathsToModuleNameMapper } = require("ts-jest");
const tsconfig = require("../../tsconfig.base.json");
const { WORKTREE_JEST_ROOTS, WORKTREE_TEMP_IGNORE_PATTERNS } = require("./jest.shared");

const tsPaths =
  (tsconfig &&
    tsconfig.compilerOptions &&
    tsconfig.compilerOptions.paths &&
    typeof tsconfig.compilerOptions.paths === "object" &&
    tsconfig.compilerOptions.paths) ||
  {};

module.exports = {
  rootDir: path.join(__dirname, "..", ".."),
  roots: WORKTREE_JEST_ROOTS,
  testEnvironment: "jsdom",
  testTimeout: 15000,
  testMatch: ["**/tests/ui/**/*.test.ts?(x)"],
  testPathIgnorePatterns: WORKTREE_TEMP_IGNORE_PATTERNS,
  modulePathIgnorePatterns: WORKTREE_TEMP_IGNORE_PATTERNS,
  watchPathIgnorePatterns: WORKTREE_TEMP_IGNORE_PATTERNS,
  transform: {
    "^.+\\.(ts|tsx)$": [
      "ts-jest",
      { tsconfig: "<rootDir>/tsconfig.jest.json" }
    ]
  },
  moduleFileExtensions: ["ts", "tsx", "js", "jsx", "json"],
  moduleNameMapper: {
    "\\.(css|less|scss|sass)$": "<rootDir>/tests/ui/__mocks__/style.ts",
    "^next/cache$": "<rootDir>/tests/ui/__mocks__/next-cache.ts",
    "^next-intl$": "<rootDir>/tests/ui/__mocks__/next-intl.tsx",
    "^server-only$": "<rootDir>/tests/ui/__mocks__/server-only.ts",
    ...(Object.keys(tsPaths).length
      ? pathsToModuleNameMapper(tsPaths, { prefix: "<rootDir>/" })
      : {})
  },
  setupFilesAfterEnv: ["<rootDir>/tests/ui/setup.ts"]
};
