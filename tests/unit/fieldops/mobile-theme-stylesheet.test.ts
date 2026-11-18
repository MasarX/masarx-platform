jest.mock("react-native", () => ({
  View: "View",
  Text: "Text",
  Pressable: "Pressable",
  TextInput: "TextInput",
  Modal: "Modal",
  Dimensions: { get: () => ({ height: 800 }) },
  StyleSheet: { create: (styles: object) => styles, absoluteFillObject: {} },
}), { virtual: true });
import { getTokensForTheme } from "../../../apps/fieldops/src/mobile-theme";
import { buildThemedStyles } from "../../../apps/fieldops/src/mobile-theme-stylesheet";

test.each(["light", "dark"] as const)("binds %s shell styles to the active theme", mode => {
  const tokens = getTokensForTheme(mode, "web");
  const styles = buildThemedStyles(tokens);

  expect(styles.pageRoot.backgroundColor).toBe(tokens.color.pageBg);
  expect(styles.header).toMatchObject({
    backgroundColor: tokens.color.cardBg,
    borderBottomColor: tokens.color.border,
    paddingTop: tokens.spacing.md,
  });
  expect(styles.headerTitle).toMatchObject({ color: tokens.color.text, fontFamily: tokens.font.sans });
  expect(styles.cardSubtitle.color).toBe(tokens.color.textMuted);
});
