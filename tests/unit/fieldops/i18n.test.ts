import { AR_STRINGS, EN_STRINGS, getFieldOpsStrings } from "../../../apps/fieldops/src/i18n";
import { resolveDirectionMode, resolveLocaleMode } from "../../../apps/fieldops/src/mobile-shell-display";

test("Arabic catalog strings have no runs of replacement question marks", () => {
  expect(JSON.stringify(AR_STRINGS)).not.toMatch(/\?{2,}/);
});

describe("FieldOps locale selection", () => {
  test.each(["ar", " AR "])("normalizes %s to the Arabic catalog", (value) => {
    expect(getFieldOpsStrings(resolveLocaleMode(value))).toBe(AR_STRINGS);
  });

  test.each([undefined, null, "fr", 42, { value: "ar" }])(
    "uses English for unsupported input %p",
    (value) => {
      expect(getFieldOpsStrings(resolveLocaleMode(value))).toBe(EN_STRINGS);
    }
  );

  test("uses locale direction unless an explicit direction is supplied", () => {
    expect(resolveDirectionMode({ value: undefined, locale: "ar" })).toBe("rtl");
    expect(resolveDirectionMode({ value: undefined, locale: "en" })).toBe("ltr");
    expect(resolveDirectionMode({ value: "ltr", locale: "ar" })).toBe("ltr");
  });
});
