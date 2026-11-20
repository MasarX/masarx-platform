/** Warn when field styles bypass the shared typography scale. */

"use strict";

const TYPOGRAPHY_KEYS = new Set(["fontSize", "fontWeight", "fontFamily"]);

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

function resolveKeyName(property) {
  if (!property || property.type !== "Property") return null;
  const key = property.key;
  if (!key) return null;
  if (!property.computed && key.type === "Identifier") return key.name;
  if (key.type === "Literal" && typeof key.value === "string") return key.value;
  return null;
}

function isRawLiteral(node) {
  if (!node) return false;
  if (node.type === "Literal") {
    return typeof node.value === "string" || typeof node.value === "number";
  }
  // Disallow plain template strings without interpolation, e.g. `bold`.
  if (
    node.type === "TemplateLiteral" &&
    node.expressions.length === 0 &&
    node.quasis.length === 1
  ) {
    return true;
  }
  return false;
}

function describeLiteral(node) {
  if (node.type === "Literal") {
    return JSON.stringify(node.value);
  }
  if (node.type === "TemplateLiteral") {
    return JSON.stringify(node.quasis[0].value.cooked);
  }
  return "<literal>";
}

module.exports = {
  meta: {
    type: "problem",
    docs: {
      description:
        "Forbid raw fontSize/fontWeight/fontFamily literals in FieldOps components (must use tokens.font.*).",
      recommended: false,
    },
    schema: [],
    messages: {
      rawTypography:
        'Raw typography literal {{value}} for "{{key}}" is forbidden. Use tokens.font.* (scale/weight/role) via useThemedStyles().',
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
        if (!keyName || !TYPOGRAPHY_KEYS.has(keyName)) return;
        if (!isRawLiteral(node.value)) return;
        context.report({
          node: node.value,
          messageId: "rawTypography",
          data: { value: describeLiteral(node.value), key: keyName },
        });
      },
    };
  },
};
