const uiPreset = require("@masarx/ui/tailwind-preset");

module.exports = {
  darkMode: "class",
  presets: [uiPreset],
  content: [
    "./packages/ui/src/**/*.{ts,tsx}"
  ]
};
