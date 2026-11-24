import {
  buildThemeStyleBlock,
  getTokensForTheme,
  tokensToCssVariables,
} from "../../apps/fieldops/src/mobile-theme";

test.each(["light", "dark", "sunlight"] as const)("exports the %s web theme as CSS variables", (theme) => {
  const tokens = getTokensForTheme(theme, "web");
  const variables = tokensToCssVariables(tokens);
  expect(variables).toMatchObject({
    "--fieldops-color-page-bg": tokens.color.pageBg,
    "--fieldops-font-sans": tokens.font.sans,
    "--fieldops-font-mono": tokens.font.mono,
    "--fieldops-font-size-lg": `${tokens.font.scale.lg}px`,
    "--fieldops-spacing-md": `${tokens.spacing.md}px`,
    "--fieldops-radius-pill": `${tokens.radius.pill}px`,
  });
  const css = buildThemeStyleBlock(tokens, theme);
  expect(css).toContain(`:root[data-theme="${theme}"]`);
  expect(css).toContain(`--fieldops-color-page-bg: ${tokens.color.pageBg};`);
  expect(css).toContain("font-family: var(--fieldops-font-sans)");
  expect(buildThemeStyleBlock(tokens, theme)).toBe(css);
});

test("omits an undefined native font", () => {
  const tokens = getTokensForTheme("light", "native");
  expect(tokensToCssVariables(tokens)).not.toHaveProperty("--fieldops-font-sans");
  expect(buildThemeStyleBlock(tokens, "light")).not.toContain("font-family");
});
