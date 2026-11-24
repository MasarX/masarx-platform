import { formatMoneyLabel } from "../../apps/fieldops/src/mobile-shell-surface-helpers";

test.each([
  ["JPY", "JPY 12"],
  ["USD", "USD 12.35"],
  ["KWD", "KWD 12.346"],
  [null, "SAR 12.35"],
] as const)("uses the display precision for %s", (currency, expected) => {
  expect(formatMoneyLabel(12.3456, currency)).toBe(expected);
});

test("continues to omit missing or non-finite amounts", () => {
  expect(formatMoneyLabel(null, "KWD")).toBeNull();
  expect(formatMoneyLabel(Infinity, "KWD")).toBeNull();
});
