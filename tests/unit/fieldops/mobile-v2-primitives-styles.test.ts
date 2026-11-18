import { MOBILE_V2_THEMES } from "../../../apps/fieldops/src/mobile-v2-themes";
import {
  resolveFxAvatarInitials,
  resolveFxAvatarStyle,
  resolveFxButtonColors,
  resolveFxButtonGeometry,
  resolveFxCardStyle,
  resolveFxChipColors,
  resolveFxChipTypography,
  resolveFxColStyle,
  resolveFxMetricStyle,
  resolveFxRowStyle,
  resolveFxSectionHeadStyle,
  resolveFxStatusDotColor,
  resolveFxStickyActionStyle,
} from "../../../apps/fieldops/src/mobile-v2-primitives-styles";

const HIVIS = MOBILE_V2_THEMES.hivis;
const LIGHT = MOBILE_V2_THEMES.light;
const DARK = MOBILE_V2_THEMES.dark;

describe("resolveFxChipColors", () => {
  test("neutral tone uses surfaceAlt + inkSoft + border", () => {
    expect(resolveFxChipColors(LIGHT, "neutral")).toEqual({
      background: LIGHT.surfaceAlt,
      foreground: LIGHT.inkSoft,
      border: LIGHT.border,
    });
  });

  test("accent tone uses accentSoft fill, accent fg, transparent border", () => {
    expect(resolveFxChipColors(HIVIS, "accent")).toEqual({
      background: HIVIS.accentSoft,
      foreground: HIVIS.accent,
      border: "transparent",
    });
  });

  test("success / warning / danger / info / chrome map to corresponding theme tokens", () => {
    expect(resolveFxChipColors(LIGHT, "success").foreground).toBe(LIGHT.success);
    expect(resolveFxChipColors(LIGHT, "warning").foreground).toBe(LIGHT.warning);
    expect(resolveFxChipColors(LIGHT, "danger").foreground).toBe(LIGHT.danger);
    expect(resolveFxChipColors(LIGHT, "info").foreground).toBe(LIGHT.info);
    expect(resolveFxChipColors(LIGHT, "chrome")).toEqual({
      background: LIGHT.chrome,
      foreground: LIGHT.onChrome,
      border: "transparent",
    });
  });

  test("every toned chip renders a transparent border; only neutral keeps a hairline", () => {
    for (const tone of ["accent", "success", "warning", "danger", "info", "chrome"] as const) {
      expect(resolveFxChipColors(LIGHT, tone).border).toBe("transparent");
    }
    expect(resolveFxChipColors(LIGHT, "neutral").border).toBe(LIGHT.border);
  });
});

describe("resolveFxChipTypography", () => {
  test("default chip uses sans + size=11", () => {
    const out = resolveFxChipTypography({});
    expect(out.fontSize).toBe(11);
    expect(out.fontFamily).toContain("Geist");
  });

  test("dense chip uses smaller size", () => {
    const out = resolveFxChipTypography({ dense: true });
    expect(out.fontSize).toBe(10);
    expect(out.minHeight).toBeLessThan(resolveFxChipTypography({}).minHeight);
  });

  test("mono chip uses Geist Mono family", () => {
    const out = resolveFxChipTypography({ mono: true });
    expect(out.fontFamily).toContain("Geist Mono");
  });
});

describe("resolveFxButtonColors", () => {
  test("primary uses theme accent + accentInk", () => {
    expect(resolveFxButtonColors(HIVIS, "primary")).toEqual({
      background: HIVIS.accent,
      foreground: HIVIS.accentInk,
      border: HIVIS.accent,
    });
  });

  test("chrome uses theme chrome + onChrome", () => {
    expect(resolveFxButtonColors(LIGHT, "chrome")).toEqual({
      background: LIGHT.chrome,
      foreground: LIGHT.onChrome,
      border: LIGHT.chrome,
    });
  });

  test("ghost uses transparent background and ink foreground", () => {
    expect(resolveFxButtonColors(LIGHT, "ghost")).toEqual({
      background: "transparent",
      foreground: LIGHT.ink,
      border: LIGHT.borderStrong,
    });
  });

  test("outline-accent renders transparent bg + accent border + accent text", () => {
    // Used for low-emphasis chip-style inline CTAs (e.g. Mark missing
    // in manifest-detail) where design canvas calls for an outlined
    // accent treatment, not the accentSoft-filled "soft" variant.
    expect(resolveFxButtonColors(LIGHT, "outline-accent")).toEqual({
      background: "transparent",
      foreground: LIGHT.accent,
      border: LIGHT.accent,
    });
    expect(resolveFxButtonColors(DARK, "outline-accent").border).toBe(DARK.accent);
    expect(resolveFxButtonColors(HIVIS, "outline-accent").foreground).toBe(HIVIS.accent);
  });

  test("outline-danger renders transparent bg + danger border + danger text", () => {
    // Used for low-emphasis destructive CTAs (e.g. Cannot pick up in
    // pickup-detail) where design canvas shows a flat danger-toned
    // text+icon button rather than the filled "danger" variant.
    expect(resolveFxButtonColors(LIGHT, "outline-danger")).toEqual({
      background: "transparent",
      foreground: LIGHT.danger,
      border: LIGHT.danger,
    });
    expect(resolveFxButtonColors(DARK, "outline-danger").border).toBe(DARK.danger);
    expect(resolveFxButtonColors(HIVIS, "outline-danger").foreground).toBe(HIVIS.danger);
  });

  test("soft renders the design's neutral tokens (surfaceAlt bg + ink fg + transparent border)", () => {
    // U-m: the design `soft` variant (_kit.jsx:281) is a low-emphasis
    // NEUTRAL button — `{ bg: surfaceAlt, fg: ink, bd: transparent }`.
    // It must NOT be accent-tinted (that collapsed primary/secondary
    // contrast app-wide).
    for (const theme of [LIGHT, DARK, HIVIS]) {
      expect(resolveFxButtonColors(theme, "soft")).toEqual({
        background: theme.surfaceAlt,
        foreground: theme.ink,
        border: "transparent",
      });
      // Explicitly not the accent fill the old impl used.
      expect(resolveFxButtonColors(theme, "soft").background).not.toBe(theme.accentSoft);
      expect(resolveFxButtonColors(theme, "soft").foreground).not.toBe(theme.accent);
    }
  });

  test("danger / success render solid fills with white text", () => {
    expect(resolveFxButtonColors(LIGHT, "danger")).toEqual({
      background: LIGHT.danger,
      foreground: "#FFFFFF",
      border: LIGHT.danger,
    });
    expect(resolveFxButtonColors(LIGHT, "success")).toEqual({
      background: LIGHT.success,
      foreground: "#FFFFFF",
      border: LIGHT.success,
    });
  });
});

describe("resolveFxButtonGeometry", () => {
  test("md is the default size and has height 46", () => {
    const out = resolveFxButtonGeometry("md");
    expect(out.height).toBe(46);
  });

  test("sm is smaller (36)", () => {
    expect(resolveFxButtonGeometry("sm").height).toBe(36);
  });

  test("lg is larger (54)", () => {
    expect(resolveFxButtonGeometry("lg").height).toBe(54);
  });

  test("monotonic by size: sm < md < lg in height + iconSize", () => {
    const sm = resolveFxButtonGeometry("sm");
    const md = resolveFxButtonGeometry("md");
    const lg = resolveFxButtonGeometry("lg");
    expect(sm.height).toBeLessThan(md.height);
    expect(md.height).toBeLessThan(lg.height);
    expect(sm.iconSize).toBeLessThanOrEqual(md.iconSize);
    expect(md.iconSize).toBeLessThanOrEqual(lg.iconSize);
  });

  test("borderRadius matches design source button radius (12)", () => {
    expect(resolveFxButtonGeometry("md").borderRadius).toBe(12);
  });
});

describe("resolveFxCardStyle", () => {
  test("default uses surface + border + 14 padding + 14 radius", () => {
    const out = resolveFxCardStyle(LIGHT);
    expect(out.background).toBe(LIGHT.surface);
    expect(out.border).toBe(LIGHT.border);
    expect(out.padding).toBe(14);
    expect(out.borderRadius).toBe(14);
  });

  test("soft variant uses surfaceAlt", () => {
    expect(resolveFxCardStyle(LIGHT, { soft: true }).background).toBe(LIGHT.surfaceAlt);
  });

  test("accent variant renders a full accent border (design _kit.jsx:310)", () => {
    // U-p: the design FxCard border is `1px solid ${accent ? t.accent
    // : t.border}` — a full accent border on all four sides, not a
    // left-only strip.
    expect(resolveFxCardStyle(LIGHT, { accent: true }).border).toBe(LIGHT.accent);
    expect(resolveFxCardStyle(DARK, { accent: true }).border).toBe(DARK.accent);
    expect(resolveFxCardStyle(LIGHT).border).toBe(LIGHT.border);
  });

  test("custom padding respected when non-negative", () => {
    expect(resolveFxCardStyle(LIGHT, { padding: 22 }).padding).toBe(22);
    expect(resolveFxCardStyle(LIGHT, { padding: 0 }).padding).toBe(0);
  });

  test("negative padding falls back to default 14", () => {
    expect(resolveFxCardStyle(LIGHT, { padding: -5 }).padding).toBe(14);
  });
});

describe("resolveFxAvatarInitials", () => {
  test("two-word names use first letter of first + last word", () => {
    expect(resolveFxAvatarInitials("Khalid Al-Hashimi")).toBe("KA");
    expect(resolveFxAvatarInitials("ahmed bin saud")).toBe("AS");
  });

  test("single-word names use first two letters", () => {
    expect(resolveFxAvatarInitials("Mohammed")).toBe("MO");
    expect(resolveFxAvatarInitials("KH")).toBe("KH");
  });

  test("missing or empty name falls back to AB", () => {
    expect(resolveFxAvatarInitials(undefined)).toBe("AB");
    expect(resolveFxAvatarInitials("")).toBe("AB");
    expect(resolveFxAvatarInitials("   ")).toBe("AB");
  });

  test("normalizes to uppercase", () => {
    expect(resolveFxAvatarInitials("john doe")).toBe("JD");
  });
});

describe("resolveFxAvatarStyle", () => {
  test("default tone is accent (accentSoft disk + accent initials)", () => {
    // U-n: the design `FxAvatar` (_kit.jsx:428) defaults `tone='accent'`
    // — a call site that omits `tone` must render the accent treatment,
    // not gray.
    const out = resolveFxAvatarStyle(LIGHT);
    expect(out.background).toBe(LIGHT.accentSoft);
    expect(out.foreground).toBe(LIGHT.accent);
  });

  test("explicit accent tone uses accentSoft + accent ink", () => {
    const out = resolveFxAvatarStyle(LIGHT, { tone: "accent" });
    expect(out.background).toBe(LIGHT.accentSoft);
    expect(out.foreground).toBe(LIGHT.accent);
  });

  test("explicit neutral tone still opts into the surfaceAlt / inkSoft palette", () => {
    const out = resolveFxAvatarStyle(LIGHT, { tone: "neutral" });
    expect(out.background).toBe(LIGHT.surfaceAlt);
    expect(out.foreground).toBe(LIGHT.inkSoft);
  });

  test("default size 36, custom positive size respected, invalid size falls back", () => {
    expect(resolveFxAvatarStyle(LIGHT).size).toBe(36);
    expect(resolveFxAvatarStyle(LIGHT, { size: 48 }).size).toBe(48);
    expect(resolveFxAvatarStyle(LIGHT, { size: 0 }).size).toBe(36);
  });

  test("initials propagate from name input", () => {
    expect(resolveFxAvatarStyle(LIGHT, { name: "Sara Faisal" }).initials).toBe("SF");
  });
});

describe("resolveFxMetricStyle", () => {
  test("default tone uses theme.ink for value", () => {
    expect(resolveFxMetricStyle(LIGHT, "default").valueColor).toBe(LIGHT.ink);
  });

  test("success / warning / danger / accent use corresponding tokens", () => {
    expect(resolveFxMetricStyle(LIGHT, "success").valueColor).toBe(LIGHT.success);
    expect(resolveFxMetricStyle(LIGHT, "warning").valueColor).toBe(LIGHT.warning);
    expect(resolveFxMetricStyle(LIGHT, "danger").valueColor).toBe(LIGHT.danger);
    expect(resolveFxMetricStyle(LIGHT, "accent").valueColor).toBe(LIGHT.accent);
  });

  test("value font is mono (numerics) and matches design metric size 22", () => {
    const out = resolveFxMetricStyle(LIGHT, "default");
    expect(out.valueFontFamily).toContain("Geist Mono");
    expect(out.valueFontSize).toBe(22);
  });
});

describe("resolveFxStatusDotColor", () => {
  test("done -> success, current -> accent, pending -> muted, failed -> danger, sla -> warning", () => {
    expect(resolveFxStatusDotColor(LIGHT, "done")).toBe(LIGHT.success);
    expect(resolveFxStatusDotColor(LIGHT, "current")).toBe(LIGHT.accent);
    expect(resolveFxStatusDotColor(LIGHT, "pending")).toBe(LIGHT.muted);
    expect(resolveFxStatusDotColor(LIGHT, "failed")).toBe(LIGHT.danger);
    expect(resolveFxStatusDotColor(LIGHT, "sla")).toBe(LIGHT.warning);
  });
});

describe("resolveFxSectionHeadStyle", () => {
  test("uppercase + size 10 + bold + muted color", () => {
    const out = resolveFxSectionHeadStyle(DARK);
    expect(out.fontSize).toBe(10);
    expect(out.fontWeight).toBe("700");
    expect(out.textTransform).toBe("uppercase");
    expect(out.color).toBe(DARK.muted);
  });
});

describe("resolveFxStickyActionStyle", () => {
  test("uses theme.bg + border + muted sub", () => {
    const out = resolveFxStickyActionStyle(HIVIS);
    expect(out.background).toBe(HIVIS.bg);
    expect(out.borderTop).toBe(HIVIS.border);
    expect(out.subColor).toBe(HIVIS.muted);
  });
});

describe("resolveFxRowStyle / resolveFxColStyle", () => {
  test("row defaults: flex-direction row, align center, no wrap, gap 8", () => {
    const out = resolveFxRowStyle();
    expect(out.flexDirection).toBe("row");
    expect(out.alignItems).toBe("center");
    expect(out.flexWrap).toBe("nowrap");
    expect(out.gap).toBe(8);
  });

  test("row respects align/justify/wrap/gap overrides", () => {
    const out = resolveFxRowStyle({ align: "flex-start", justify: "space-between", wrap: true, gap: 12 });
    expect(out.alignItems).toBe("flex-start");
    expect(out.justifyContent).toBe("space-between");
    expect(out.flexWrap).toBe("wrap");
    expect(out.gap).toBe(12);
  });

  test("row falls back to default gap on invalid input", () => {
    expect(resolveFxRowStyle({ gap: -1 }).gap).toBe(8);
  });

  test("col is column direction with default gap 8", () => {
    const out = resolveFxColStyle();
    expect(out.flexDirection).toBe("column");
    expect(out.gap).toBe(8);
  });

  test("col respects custom gap (including 0)", () => {
    expect(resolveFxColStyle({ gap: 16 }).gap).toBe(16);
    expect(resolveFxColStyle({ gap: 0 }).gap).toBe(0);
  });
});
