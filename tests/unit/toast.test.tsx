jest.mock("react-native", () => ({
  StyleSheet: { create: (styles: object) => styles },
}), { virtual: true });

import { buildToastStyles, TOAST_DEFAULT_DURATION_MS, TOAST_TONES } from "../../apps/fieldops/src/components/Toast";
import { getTokensForTheme } from "../../apps/fieldops/src/mobile-theme";

test.each(["light", "dark"] as const)("uses %s tokens for the toast and its action target", mode => {
  const tokens = getTokensForTheme(mode, "web");
  const styles = buildToastStyles(tokens);

  expect(styles.card).toMatchObject({ borderRadius: tokens.radius.md, gap: tokens.spacing.sm });
  expect(styles.message).toMatchObject({ fontSize: tokens.font.scale.lg, fontFamily: tokens.font.sans });
  expect(styles.actionButton).toMatchObject({ minHeight: 44, minWidth: 44 });
});

test("provides a bounded default lifetime and the four announcement tones", () => {
  expect(TOAST_DEFAULT_DURATION_MS).toBe(4000);
  expect(TOAST_TONES).toEqual(["info", "success", "warning", "danger"]);
});
