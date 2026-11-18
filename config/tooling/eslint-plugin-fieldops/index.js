/** Register the FieldOps ESLint rules for theme colors, typography and spacing tokens. */

"use strict";

const noHexColorOutsideTheme = require("./rules/no-hex-color-outside-theme");
const noSpacingLiteralOffRamp = require("./rules/no-spacing-literal-off-ramp");
const noRawTypographyLiterals = require("./rules/no-raw-typography-literals");

module.exports = {
  meta: {
    name: "eslint-plugin-fieldops",
    version: "0.1.0",
  },
  rules: {
    "no-hex-color-outside-theme": noHexColorOutsideTheme,
    "no-spacing-literal-off-ramp": noSpacingLiteralOffRamp,
    "no-raw-typography-literals": noRawTypographyLiterals,
  },
};
