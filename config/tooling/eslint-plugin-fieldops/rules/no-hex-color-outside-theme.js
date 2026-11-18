/** Warn when component code uses a color literal outside its theme definitions. */

"use strict";

// `#abc`, `#aabbcc`, or `#aabbccdd` — case-insensitive.
const HEX_COLOR_RE = /^#(?:[0-9a-fA-F]{3,4}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})$/;

// Allowlist (SSOT files): rule is a no-op inside these.
// Match by suffix to be portable across worktree paths and OS path separators.
const ALLOWLIST_SUFFIXES = [
  "/apps/fieldops/src/mobile-theme.ts",
  "/apps/fieldops/src/mobile-theme-stylesheet.ts",
];

function isAllowlistedFile(filename) {
  if (!filename || filename === "<input>" || filename === "<text>") return false;
  const normalized = String(filename).split("\\").join("/");
  return ALLOWLIST_SUFFIXES.some((suffix) => normalized.endsWith(suffix));
}

module.exports = {
  meta: {
    type: "problem",
    docs: {
      description:
        "Forbid hex color literals outside the canonical FieldOps theme SSOT files.",
      recommended: false,
    },
    schema: [],
    messages: {
      hexColorForbidden:
        'Hex color literal "{{value}}" is forbidden outside mobile-theme.ts/mobile-theme-stylesheet.ts. Use tokens.color.* via useThemedStyles().',
    },
  },

  create(context) {
    const filename =
      typeof context.getFilename === "function"
        ? context.getFilename()
        : context.filename;

    if (isAllowlistedFile(filename)) {
      // SSOT file: nothing to lint here.
      return {};
    }

    function check(node, raw) {
      if (typeof raw !== "string") return;
      if (!HEX_COLOR_RE.test(raw)) return;
      context.report({
        node,
        messageId: "hexColorForbidden",
        data: { value: raw },
      });
    }

    return {
      Literal(node) {
        check(node, node.value);
      },
      TemplateLiteral(node) {
        // Only flag templates that are a single static chunk equal to a hex
        // color (e.g. `\`#aabbcc\``); anything dynamic is left alone.
        if (node.expressions.length !== 0) return;
        if (node.quasis.length !== 1) return;
        check(node, node.quasis[0].value.cooked);
      },
    };
  },
};
