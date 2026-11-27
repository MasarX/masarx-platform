const uiPreset = require("@masarx/ui/tailwind-preset");

// Inside Console V2 the shared ui-accent* utilities (the label designer studio) use Console V2's accent family (#443).
const v2 = (token) => `color-mix(in oklab, var(${token}) calc(<alpha-value> * 100%), transparent)`;

module.exports = {
  darkMode: "class",
  presets: [uiPreset],
  content: [
    "./index.html",
    "./src/**/*.{ts,tsx}",
    "../../packages/ui/src/**/*.{ts,tsx}"
  ],
  theme: {
    extend: {
      colors: {
        "ui-accent": v2("--accent"),
        "ui-accent-hover": v2("--accent-ink"),
        "ui-accent-ink": v2("--ink-inv"),
        "ui-accent-soft": v2("--accent-soft")
      }
    }
  }
};
