/** Warn when spacing literals fall outside the shared spacing scale. */

"use strict";

const CANONICAL_RAMP = new Set([0, 2, 4, 8, 12, 16, 24, 32, 48, 64]);

// Keys that carry layout-spacing semantics in React Native StyleSheet objects.
const SPACING_KEY_PREFIXES = ["padding", "margin"];
const SPACING_KEYS_EXACT = new Set([
  "gap",
  "columnGap",
  "rowGap",
]);

// Allowlist (SSOT files): rule is a no-op inside these.
const ALLOWLIST_SUFFIXES = [
  "/apps/fieldops/src/mobile-theme.ts",
  "/apps/fieldops/src/mobile-theme-stylesheet.ts",
];

function isAllowlistedFile(filename) {
  if (!filename || filename === "<input>" || filename === "<text>") return false;
  const normalized = String(filename).split("\\").join("/");
  return ALLOWLIST_SUFFIXES.some((suffix) => normalized.endsWith(suffix));
}

function isSpacingKey(name) {
  if (typeof name !== "string") return false;
  if (SPACING_KEYS_EXACT.has(name)) return true;
  for (const prefix of SPACING_KEY_PREFIXES) {
    if (name === prefix) return true;
    if (name.startsWith(prefix) && name.length > prefix.length) {
      // e.g. paddingTop, marginHorizontal, paddingLeft
      const suffix = name.slice(prefix.length);
      // Must start with an uppercase letter to be a compound CSS-in-JS key.
      if (/^[A-Z]/.test(suffix)) return true;
    }
  }
  return false;
}

function resolveKeyName(property) {
  if (!property || property.type !== "Property") return null;
  const key = property.key;
  if (!key) return null;
  if (!property.computed && key.type === "Identifier") return key.name;
  if (key.type === "Literal" && typeof key.value === "string") return key.value;
  return null;
}

function resolveNumericLiteral(node) {
  if (!node) return null;
  if (node.type === "Literal" && typeof node.value === "number") return node.value;
  if (
    node.type === "UnaryExpression" &&
    node.operator === "-" &&
    node.argument &&
    node.argument.type === "Literal" &&
    typeof node.argument.value === "number"
  ) {
    return -node.argument.value;
  }
  return null;
}

module.exports = {
  meta: {
    type: "problem",
    docs: {
      description:
        "Forbid off-ramp padding/margin/gap numeric literals in FieldOps components (must use tokens.spacing.*).",
      recommended: false,
    },
    schema: [],
    messages: {
      offRamp:
        'Spacing literal {{value}} for "{{key}}" is not on the 4-pt ramp {0,2,4,8,12,16,24,32,48,64}. Use tokens.spacing.*.',
    },
  },

  create(context) {
    const filename =
      typeof context.getFilename === "function"
        ? context.getFilename()
        : context.filename;

    if (isAllowlistedFile(filename)) {
      return {};
    }

    return {
      Property(node) {
        const keyName = resolveKeyName(node);
        if (!keyName || !isSpacingKey(keyName)) return;
        const value = resolveNumericLiteral(node.value);
        if (value === null) return;
        if (CANONICAL_RAMP.has(value)) return;
        context.report({
          node: node.value,
          messageId: "offRamp",
          data: { value: String(value), key: keyName },
        });
      },
    };
  },
};
