const uiPreset = require("@masarx/ui/tailwind-preset");

module.exports = {
  darkMode: "class",
  presets: [uiPreset],
  content: [
    "./apps/console-v2/index.html",
    "./apps/console-v2/src/**/*.{ts,tsx}",
    "./packages/ui/src/**/*.{ts,tsx}"
  ]
};
