"use strict";

// The landing build prepends the shared --ui-* tokens from packages/ui/src/tokens.css
// so landing names that differ from them only in name can alias them (#162).
// Only --ui-* declarations are copied: the shared font and color-scheme
// declarations would otherwise change the landing look.
const fs = require("fs");
const path = require("path");

const SHARED_TOKENS = path.join("packages", "ui", "src", "tokens.css");
const THEME_SELECTORS = [":root", ':root[data-theme="dark"]'];

function sharedUiTokenCss(sharedCss) {
  const css = `\n${sharedCss.replace(/\r\n/g, "\n")}`;
  return THEME_SELECTORS.map((selector) => {
    const start = css.indexOf(`\n${selector} {`);
    if (start < 0) throw new Error(`${SHARED_TOKENS}: no "${selector}" block`);
    const open = css.indexOf("{", start);
    const body = css.slice(open + 1, css.indexOf("}", open));
    const declarations = body
      .split(";")
      .map((declaration) => declaration.trim())
      .filter((declaration) => declaration.startsWith("--ui-"));
    if (!declarations.length) throw new Error(`${SHARED_TOKENS}: "${selector}" has no --ui-* tokens`);
    return `${selector} {\n  ${declarations.join(";\n  ")};\n}\n`;
  }).join("");
}

function readSharedUiTokenCss(repoRoot) {
  return sharedUiTokenCss(fs.readFileSync(path.join(repoRoot, SHARED_TOKENS), "utf8"));
}

module.exports = { sharedUiTokenCss, readSharedUiTokenCss };
