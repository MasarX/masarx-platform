const baseConfig = require("./jest.config.ui.js");

module.exports = {
  ...baseConfig,
  displayName: "fieldops-ui",
  testMatch: ["**/tests/ui/components/**/*.test.ts?(x)", "**/tests/unit/app-*.test.tsx"],
  transform: {
    ...baseConfig.transform,
    "^.+\\.(ts|tsx)$": [
      "ts-jest",
      {
        ...baseConfig.transform["^.+\\.(ts|tsx)$"][1],
        tsconfig: "<rootDir>/tsconfig.jest.fieldops.json",
      },
    ],
  },
  moduleNameMapper: {
    ...baseConfig.moduleNameMapper,
    "^react-native$": require.resolve("react-native-web", { paths: [require("node:path").join(__dirname, "..", "..", "apps", "fieldops")] }),
    "^react-native-maps$": "<rootDir>/apps/fieldops/src/mobile-map-stub-web.tsx",
  },
};
