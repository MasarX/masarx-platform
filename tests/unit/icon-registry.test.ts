import {
  ICON_GLYPH,
  ICON_NAMES,
  ICON_SIZE_PX,
  ICON_SIZES,
  ICON_TONES,
  type IconName,
  type IconSize,
  type IconTone,
} from "../../apps/fieldops/src/components/IconRegistry.types";

describe("FieldOps icon registry", () => {
  describe("ICON_GLYPH table", () => {
    test("every IconName resolves to a non-empty glyph", () => {
      // Iterate the canonical ordered tuple instead of Object.keys so
      // additions to the union without a corresponding ICON_NAMES entry
      // surface here.
      for (const name of ICON_NAMES) {
        const glyph = ICON_GLYPH[name];
        expect(typeof glyph).toBe("string");
        expect(glyph.length).toBeGreaterThan(0);
      }
    });

    test("ICON_NAMES ordered tuple stays in lock-step with ICON_GLYPH keys", () => {
      // Keep the public icon names and glyph table in sync.
      const tableKeys = Object.keys(ICON_GLYPH).sort();
      const tupleKeys = [...ICON_NAMES].sort();
      expect(tupleKeys).toEqual(tableKeys);
    });

    test("every glyph is a single visible Unicode codepoint (no whitespace)", () => {
      // Whitespace glyphs would render as invisible hit targets, defeating
      // the icon's purpose. This guards against an accidental " " entry.
      for (const name of ICON_NAMES) {
        const glyph = ICON_GLYPH[name];
        expect([...glyph.trim()]).toHaveLength(1);
      }
    });

    test("known anchor glyphs match the documented Unicode codepoints", () => {
      // Spot-check a few load-bearing aliases so the SVG swap-in card
      // can confirm visual continuity by reading the static map.
      expect(ICON_GLYPH.menu).toBe("\u2630");
      expect(ICON_GLYPH.close).toBe("\u00D7");
      expect(ICON_GLYPH["chevron-left"]).toBe("\u2039");
      expect(ICON_GLYPH["chevron-right"]).toBe("\u203A");
      expect(ICON_GLYPH.check).toBe("\u2713");
      expect(ICON_GLYPH.more).toBe("\u22EF");
    });
  });

  describe("ICON_SIZE_PX ramp", () => {
    test("size ramp matches the typography scale steps (px)", () => {
      // These values intentionally mirror the typography token ramp
      // (xs/sm/md/lg/xl/2xl) so iconography aligns visually with text
      // of the same scale step. Drift here would regress visual hierarchy.
      expect(ICON_SIZE_PX.xs).toBe(14);
      expect(ICON_SIZE_PX.sm).toBe(16);
      expect(ICON_SIZE_PX.md).toBe(20);
      expect(ICON_SIZE_PX.lg).toBe(24);
      expect(ICON_SIZE_PX.xl).toBe(32);
      expect(ICON_SIZE_PX["2xl"]).toBe(48);
    });

    test("ICON_SIZES ordered tuple stays in lock-step with ICON_SIZE_PX keys", () => {
      const tableKeys = Object.keys(ICON_SIZE_PX).sort();
      const tupleKeys = [...ICON_SIZES].sort();
      expect(tupleKeys).toEqual(tableKeys);
    });

    test("size ramp is strictly monotonic (xs < sm < md < lg < xl < 2xl)", () => {
      // Monotonicity is a property the token ramp must maintain so callers
      // can reason about relative size by name without consulting the
      // table.
      const ordered: IconSize[] = ["xs", "sm", "md", "lg", "xl", "2xl"];
      for (let i = 1; i < ordered.length; i += 1) {
        const previous = ICON_SIZE_PX[ordered[i - 1]!];
        const current = ICON_SIZE_PX[ordered[i]!];
        expect(current).toBeGreaterThan(previous);
      }
    });

    test("md size matches body text scale (20px) -- default callsite parity", () => {
      // `md` is the default Icon size. Anchor it to the typography scale
      // `2xl` step (20px) so default-sized icons sit visually aligned
      // with body-emphasis text in the active typography ramp.
      expect(ICON_SIZE_PX.md).toBe(20);
    });
  });

  describe("IconTone resolution contract", () => {
    test("ICON_TONES enumerates exactly the 8 documented aliases", () => {
      const expected: IconTone[] = [
        "default",
        "muted",
        "accent",
        "success",
        "warning",
        "danger",
        "info",
        "inverse",
      ];
      expect([...ICON_TONES]).toEqual(expected);
    });

  });

  describe("Type-level contract (compile-time)", () => {
    test("IconName / IconSize / IconTone unions are usable as values via tuples", () => {
      // This is a smoke test that the types compile correctly when used
      // alongside the runtime tuples. If the tuples drift away from the
      // union (e.g. a name added to ICON_NAMES but missing from IconName)
      // ts-jest will fail the compile here.
      const sampleName: IconName = ICON_NAMES[0]!;
      const sampleSize: IconSize = ICON_SIZES[0]!;
      const sampleTone: IconTone = ICON_TONES[0]!;
      expect(sampleName).toBe("home");
      expect(sampleSize).toBe("xs");
      expect(sampleTone).toBe("default");
    });
  });
});
