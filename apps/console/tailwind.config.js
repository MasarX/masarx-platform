const uiPreset = require("@masarx/ui/tailwind-preset");

module.exports = {
  presets: [uiPreset],
  content: [
    "./app/**/*.{ts,tsx}",
    "../../packages/ui/src/**/*.{ts,tsx}"
  ]
};
