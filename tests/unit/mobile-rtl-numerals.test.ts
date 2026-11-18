import {
  resolveFormattedNumber,
  useFormattedNumber,
} from "../../apps/fieldops/src/mobile-rtl-numerals";

describe("FieldOps numeral formatting", () => {
  test.each<[string, RegExp, RegExp]>([
    ["en", /[0-9]/, /[٠-٩۰-۹]/],
    ["ar", /[٠-٩]/, /[0-9]/],
    ["ar_SA", /[٠-٩]/, /[0-9]/],
    ["ar-SA", /[٠-٩]/, /[0-9]/],
    ["ar_EG", /[٠-٩]/, /[0-9]/],
    ["ar_AE", /[0-9]/, /[٠-٩]/],
    ["fa", /[۰-۹]/, /[0-9]/],
    ["zh", /[0-9]/, /[٠-٩۰-۹]/],
  ])("renders %s using the configured numbering system", (locale, expected, excluded) => {
    const formatted = resolveFormattedNumber(1234.56, locale);
    expect(formatted).toMatch(expected);
    expect(formatted).not.toMatch(excluded);
  });

  test("allows number formatting options and a custom policy", () => {
    expect(resolveFormattedNumber(100.5, "en", undefined, {
      minimumFractionDigits: 2,
      maximumFractionDigits: 2,
    })).toBe("100.50");
    expect(resolveFormattedNumber(42, "fr", {
      version: 1,
      default_numbering_system: "arab",
      locale_overrides: {},
    })).toBe("٤٢");
  });

  test("falls back to plain text for nonfinite numbers or invalid locale tags", () => {
    expect(resolveFormattedNumber(Number.NaN, "ar_SA")).toBe("NaN");
    expect(resolveFormattedNumber(Infinity, "ar_SA")).toBe("Infinity");
    expect(resolveFormattedNumber(-Infinity, "fa")).toBe("-Infinity");
    expect(resolveFormattedNumber(42, "invalid locale")).toBe("42");
  });

  test("exports the formatting hook", () => {
    expect(typeof useFormattedNumber).toBe("function");
  });
});
