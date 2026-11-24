import { getTokensForTheme } from "../../apps/fieldops/src/mobile-theme";
import { normalizeStatusThemePolicy, resolveToneFromPolicy } from "../../apps/fieldops/src/status-theme-policy";

jest.mock("react", () => ({}), { virtual: true });
jest.mock("react/jsx-runtime", () => {
  const element = (type: unknown, props: unknown) => ({ type, props });
  return { jsx: element, jsxs: element };
}, { virtual: true });
jest.mock("react-native", () => ({ Text: "Text", View: "View" }), { virtual: true });
jest.mock("../../apps/fieldops/src/mobile-theme-context", () => {
  const theme = jest.requireActual("../../apps/fieldops/src/mobile-theme") as
    typeof import("../../apps/fieldops/src/mobile-theme");
  return { useTheme: () => ({ tokens: theme.getTokensForTheme("dark", "native") }) };
});
const { getStatusChipPalette, resolveStatusTone, StatusChip } = require("../../apps/fieldops/src/components/StatusChip") as
  typeof import("../../apps/fieldops/src/components/StatusChip");

test.each(["light", "dark", "sunlight"] as const)("renders meta against the %s theme token contract", (theme) => {
  const tokens = getTokensForTheme(theme, "native");
  expect(getStatusChipPalette("meta", tokens)).toEqual({
    background: tokens.color.metaSoft,
    border: tokens.color.metaBorder,
    foreground: tokens.color.metaFg,
  });
});

test("uses a tenant's configured status tone and a neutral fallback", () => {
  const policy = normalizeStatusThemePolicy({ status_map: { Awaiting_Proof: { tone: "meta" } } });
  expect(resolveToneFromPolicy(policy, " awaiting_proof ")).toBe("meta");
  expect(resolveToneFromPolicy(policy, "unexpected")).toBe("neutral");
});

test.each([
  ["success", ["completed", "DONE", "closed", "synced"]],
  ["danger", ["failed", "exception", "rejected", "refused"]],
  ["info", ["in_progress", "en_route", "arrived"]],
  ["warning", ["overdue", "delayed", "late", "warning"]],
  ["neutral", ["unknown", null, undefined, "", "   "]],
] as const)("maps offline statuses to %s", (tone, statuses) => {
  for (const status of statuses) expect(resolveStatusTone(status)).toBe(tone);
});

test("renders a leading icon and honors a custom accessibility label", () => {
  const element = StatusChip({ label: "Synced", icon: "✓", testID: "fixture-chip", accessibilityLabel: "Sync complete" });
  expect(element.props.accessibilityLabel).toBe("Sync complete");
  expect(element.props.children[0].props).toMatchObject({ testID: "fixture-chip-icon", children: "✓" });
  expect(element.props.children[1].props).toMatchObject({ testID: "fixture-chip-label", children: "Synced" });
});

test.each(["neutral", "info", "success", "warning", "danger", "meta"] as const)(
  "renders %s with its theme and an accessible text label", (tone) => {
    const label = "Fixture status";
    const tokens = getTokensForTheme("dark", "native");
    const colors = getStatusChipPalette(tone, tokens);
    const element = StatusChip({ label, tone });
    expect(element.props).toMatchObject({
      testID: "status-chip", accessibilityRole: "text", accessibilityLabel: label,
      style: [expect.objectContaining({ backgroundColor: colors.background, borderColor: colors.border }), undefined],
    });
    expect(element.props.children[1].props).toMatchObject({
      testID: "status-chip-label", style: { color: colors.foreground, fontSize: tokens.font.scale.xs }, children: label,
    });
  },
);
