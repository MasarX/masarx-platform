/** Verify the token-driven sign-in hero glass and glow styles. */

import {
  isWebGlassStyle,
  resolveSignInHeroGlassStyle,
  type SignInHeroGlassTokens,
} from "../../apps/fieldops/src/mobile-signin-hero-glass";

const TOKENS: SignInHeroGlassTokens = {
  accentSoft: "#e0f2fe",
  accentGlow: "rgba(13, 148, 136, 0.18)",
  brandTint: "rgba(255, 255, 255, 0.6)",
};

describe("resolveSignInHeroGlassStyle", () => {
  it("emits web-only CSS properties on the web platform", () => {
    const style = resolveSignInHeroGlassStyle("web", TOKENS);
    expect(style.backdropFilter).toBe("blur(8px)");
    expect(style.WebkitBackdropFilter).toBe("blur(8px)");
    expect(style.boxShadow).toBe(`0 0 40px ${TOKENS.accentGlow}`);
    expect(style.backgroundColor).toBe(TOKENS.brandTint);
  });

  it("does NOT emit web-only CSS properties on the native platform", () => {
    const style = resolveSignInHeroGlassStyle("native", TOKENS);
    expect(style.backdropFilter).toBeUndefined();
    expect(style.WebkitBackdropFilter).toBeUndefined();
    expect(style.boxShadow).toBeUndefined();
  });

  it("emits a soft accent ring on the native platform", () => {
    const style = resolveSignInHeroGlassStyle("native", TOKENS);
    expect(style.backgroundColor).toBe(TOKENS.accentSoft);
    expect(style.borderWidth).toBe(1);
    expect(style.borderColor).toBe(TOKENS.accentSoft);
  });

  it("uses the same border radius and padding on both platforms", () => {
    const web = resolveSignInHeroGlassStyle("web", TOKENS);
    const native = resolveSignInHeroGlassStyle("native", TOKENS);
    expect(web.borderRadius).toBe(native.borderRadius);
    expect(web.paddingVertical).toBe(native.paddingVertical);
    expect(web.paddingHorizontal).toBe(native.paddingHorizontal);
  });

  it("falls back to safe neutral tokens when the supplied tokens are malformed", () => {
    const malformed = {
      accentSoft: "",
      accentGlow: undefined as unknown as string,
      brandTint: null as unknown as string,
    };
    const webStyle = resolveSignInHeroGlassStyle("web", malformed);
    expect(webStyle.boxShadow).toContain("rgba(13, 148, 136, 0.18)");
    expect(webStyle.backgroundColor).toContain("rgba(");
  });

  it("returns a deterministic style object for the same inputs", () => {
    const a = resolveSignInHeroGlassStyle("web", TOKENS);
    const b = resolveSignInHeroGlassStyle("web", TOKENS);
    expect(a).toEqual(b);
  });
});

describe("isWebGlassStyle platform selection", () => {
  it("returns true for a style object with backdropFilter set", () => {
    const style = resolveSignInHeroGlassStyle("web", TOKENS);
    expect(isWebGlassStyle(style)).toBe(true);
  });

  it("returns false for a style object without web-only properties", () => {
    const style = resolveSignInHeroGlassStyle("native", TOKENS);
    expect(isWebGlassStyle(style)).toBe(false);
  });

  it("returns false for null / non-object inputs (defensive)", () => {
    expect(
      isWebGlassStyle(null as unknown as ReturnType<typeof resolveSignInHeroGlassStyle>),
    ).toBe(false);
  });
});
