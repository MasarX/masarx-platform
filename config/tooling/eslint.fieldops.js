/** Apply the FieldOps token rules as warnings while components move to shared theme tokens. */

"use strict";

/**
 * @param {{ plugin: import('eslint').ESLint.Plugin }} options
 * @returns {Array<import('eslint').Linter.FlatConfig>}
 */
function buildFieldopsLintConfig({ plugin }) {
  if (!plugin || !plugin.rules) {
    throw new Error(
      "eslint.fieldops.js: missing fieldops plugin. Pass { plugin: require('./eslint-plugin-fieldops') }."
    );
  }
  return [
    {
      files: ["apps/fieldops/**/*.tsx"],
      plugins: {
        fieldops: plugin,
      },
      rules: {
        // Keep these rules at warning level so existing literals can be migrated incrementally.
        "fieldops/no-hex-color-outside-theme": "warn",
        "fieldops/no-spacing-literal-off-ramp": "warn",
        "fieldops/no-raw-typography-literals": "warn",
      },
    },
  ];
}

module.exports = buildFieldopsLintConfig;
module.exports.default = buildFieldopsLintConfig;
