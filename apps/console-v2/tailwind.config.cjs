const uiPreset = require("@masarx/ui/tailwind-preset");

module.exports = {
  darkMode: "class",
  presets: [uiPreset],
  content: [
    "./index.html",
    "./src/**/*.{ts,tsx}",
    "../../packages/ui/src/**/*.{ts,tsx}"
  ]
};
