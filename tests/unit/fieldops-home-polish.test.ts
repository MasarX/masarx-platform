import * as fs from "fs";
import * as path from "path";

// Verify the branded empty state and trend indicators on the FieldOps home screen.

const REPO_ROOT = path.resolve(__dirname, "..", "..");
const HOME_SCREEN_PATH = path.join(
  REPO_ROOT,
  "apps",
  "fieldops",
  "src",
  "screens",
  "HomeScreen.tsx",
);
const SPARKLINE_PATH = path.join(
  REPO_ROOT,
  "apps",
  "fieldops",
  "src",
  "components",
  "Sparkline.tsx",
);

function readFileText(filePath: string): string {
  return fs.readFileSync(filePath, "utf8");
}

const HOME_SCREEN_SOURCE = readFileText(HOME_SCREEN_PATH);
const SPARKLINE_SOURCE = readFileText(SPARKLINE_PATH);

describe("Sparkline component", () => {
  test("module file exists and exports the Sparkline named symbol", () => {
    expect(SPARKLINE_SOURCE.length).toBeGreaterThan(0);
    expect(SPARKLINE_SOURCE).toContain("export function Sparkline(");
    // `default export` re-exports the named export so callers can use
    // either import style.
    expect(SPARKLINE_SOURCE).toContain("export default Sparkline");
  });

  test("declares the documented prop contract (points / width / height / tone / testID)", () => {
    expect(SPARKLINE_SOURCE).toContain("export type SparklineProps = {");
    expect(SPARKLINE_SOURCE).toMatch(/points:\s*number\[\]/);
    expect(SPARKLINE_SOURCE).toMatch(/width\?:\s*number/);
    expect(SPARKLINE_SOURCE).toMatch(/height\?:\s*number/);
    expect(SPARKLINE_SOURCE).toMatch(/tone\?:\s*SparklineTone/);
    expect(SPARKLINE_SOURCE).toMatch(/testID\?:\s*string/);
  });

  test("default prop values match the documented defaults (width=60, height=16, tone='neutral', testID='sparkline')", () => {
    // The destructured defaults live in a single block at the top of
    // the function body. We assert each default literal is present so
    // the contract documented in the file header cannot drift silently.
    expect(SPARKLINE_SOURCE).toMatch(/width\s*=\s*60/);
    expect(SPARKLINE_SOURCE).toMatch(/height\s*=\s*16/);
    expect(SPARKLINE_SOURCE).toMatch(/tone\s*=\s*"neutral"/);
    expect(SPARKLINE_SOURCE).toMatch(/testID\s*=\s*"sparkline"/);
  });

  test("supports each documented tone (positive / neutral / negative) via the resolveBarColor switch", () => {
    // The tone resolver must include an explicit case for every
    // documented alias so adding a new tone fails the exhaustive
    // switch guard at compile time.
    expect(SPARKLINE_SOURCE).toMatch(/case\s*"positive"/);
    expect(SPARKLINE_SOURCE).toMatch(/case\s*"neutral"/);
    expect(SPARKLINE_SOURCE).toMatch(/case\s*"negative"/);
    // Each tone resolves to the canonical palette family.
    expect(SPARKLINE_SOURCE).toMatch(/tokens\.color\.success/);
    expect(SPARKLINE_SOURCE).toMatch(/tokens\.color\.danger/);
    expect(SPARKLINE_SOURCE).toMatch(/tokens\.color\.metaFg/);
  });

  test("renders SVG-free (View bars only) — no react-native-svg / react-native-svg-charts dependency", () => {
    // Use the shared icon component for the empty-state glyph.
    expect(SPARKLINE_SOURCE).not.toMatch(/from\s+['"]react-native-svg['"]/);
    expect(SPARKLINE_SOURCE).not.toMatch(/from\s+['"]react-native-svg-charts['"]/);
    // The bars are <View>s laid out in a flex row.
    expect(SPARKLINE_SOURCE).toContain("flexDirection: \"row\"");
  });

  test("empty series renders nothing (returns null)", () => {
    // A flat-zero series should still draw the baseline bars, but a
    // truly empty array (no data at all) returns null so the caller
    // can decide whether to show a placeholder.
    expect(SPARKLINE_SOURCE).toContain("return null");
  });

  test("is decorative — wrapper is hidden from screen readers", () => {
    // The sparkline is purely visual context; the underlying counter
    // value is the canonical a11y surface.
    expect(SPARKLINE_SOURCE).toContain("accessibilityElementsHidden={true}");
    expect(SPARKLINE_SOURCE).toContain('importantForAccessibility="no-hide-descendants"');
  });
});

describe("HomeScreen — hero 'no active stop' brand cue", () => {
  test("imports the IconRegistry Icon component (route icon dependency)", () => {
    expect(HOME_SCREEN_SOURCE).toContain(
      'import { Icon } from "../components/IconRegistry"',
    );
  });

  test("renders an empty-state icon wrapper with the canonical testID", () => {
    expect(HOME_SCREEN_SOURCE).toContain("`${heroTestID}-empty-icon`");
    expect(HOME_SCREEN_SOURCE).toContain("`${heroTestID}-empty-icon-glyph`");
  });

  test("renders the route icon at 2xl size with muted tone", () => {
    // The icon is the brand cue — it must render through the
    // IconRegistry contract using the curated 'route' name + 2xl size.
    expect(HOME_SCREEN_SOURCE).toMatch(/<Icon[\s\S]*?name="route"/);
    expect(HOME_SCREEN_SOURCE).toMatch(/<Icon[\s\S]*?size="2xl"/);
    expect(HOME_SCREEN_SOURCE).toMatch(/<Icon[\s\S]*?tone="muted"/);
  });

  test("declares an optional subtitle string slot in HomeScreenStrings", () => {
    // Backward-compatible additive: callers that don't pass the
    // subtitle simply skip rendering the line.
    expect(HOME_SCREEN_SOURCE).toContain(
      "hero_no_active_stop_subtitle?: string",
    );
  });

  test("renders the optional subtitle inside its own Text node when provided", () => {
    expect(HOME_SCREEN_SOURCE).toContain("`${heroTestID}-empty-subtitle`");
    expect(HOME_SCREEN_SOURCE).toContain("strings.hero_no_active_stop_subtitle");
  });

  test("empty hero card uses the brand-accent border + accent-soft background pair", () => {
    // Resolve empty-state colors from the active theme.
    expect(HOME_SCREEN_SOURCE).toMatch(
      /heroCardEmpty:[\s\S]*?backgroundColor:\s*tokens\.color\.accentSoft/,
    );
    expect(HOME_SCREEN_SOURCE).toMatch(
      /heroCardEmpty:[\s\S]*?borderColor:\s*tokens\.color\.accent[,\s]/,
    );
  });
});

describe("HomeScreen — counter delta + sparkline (UI portion)", () => {
  test("imports the Sparkline component", () => {
    expect(HOME_SCREEN_SOURCE).toContain(
      'import { Sparkline } from "../components/Sparkline"',
    );
  });

  test("declares the additive HomeScreenCounterDelta + HomeScreenCounterTrends types", () => {
    expect(HOME_SCREEN_SOURCE).toContain(
      "export type HomeScreenCounterDelta = {",
    );
    expect(HOME_SCREEN_SOURCE).toContain(
      "export type HomeScreenCounterTrends = {",
    );
    // The delta type covers the four counters the cell grid renders.
    expect(HOME_SCREEN_SOURCE).toMatch(/completedStops\?:\s*number/);
    expect(HOME_SCREEN_SOURCE).toMatch(/failedStops\?:\s*number/);
    expect(HOME_SCREEN_SOURCE).toMatch(/pendingStops\?:\s*number/);
    expect(HOME_SCREEN_SOURCE).toMatch(/codCollected\?:\s*number/);
    // The trends type uses number arrays so the Sparkline can render.
    expect(HOME_SCREEN_SOURCE).toMatch(/completedStops\?:\s*number\[\]/);
  });

  test("HomeScreenProps adds delta? and trends? as optional, additive props (backward-compat)", () => {
    // The contract is additive — existing callers must continue to
    // compile without the new props.
    expect(HOME_SCREEN_SOURCE).toMatch(/delta\?:\s*HomeScreenCounterDelta/);
    expect(HOME_SCREEN_SOURCE).toMatch(/trends\?:\s*HomeScreenCounterTrends/);
  });

  test("renderCounterTrend helper exists and is invoked by all four counter cells", () => {
    expect(HOME_SCREEN_SOURCE).toContain("function renderCounterTrend(");
    // The four cells (done / failed / pending / cod) all invoke the
    // helper with their respective delta + trend pair.
    expect(HOME_SCREEN_SOURCE).toMatch(
      /renderCounterTrend\(\s*"done"[\s\S]*?delta\?\.completedStops[\s\S]*?trends\?\.completedStops/,
    );
    expect(HOME_SCREEN_SOURCE).toMatch(
      /renderCounterTrend\(\s*"failed"[\s\S]*?delta\?\.failedStops[\s\S]*?trends\?\.failedStops/,
    );
    expect(HOME_SCREEN_SOURCE).toMatch(
      /renderCounterTrend\(\s*"pending"[\s\S]*?delta\?\.pendingStops[\s\S]*?trends\?\.pendingStops/,
    );
    expect(HOME_SCREEN_SOURCE).toMatch(
      /renderCounterTrend\(\s*"cod"[\s\S]*?delta\?\.codCollected[\s\S]*?trends\?\.codCollected/,
    );
  });

  test("renderCounterTrend returns null when neither delta nor trend is provided (backward-compat)", () => {
    // This is the contract that keeps existing callers visually
    // identical. Without delta + trends, no trend block renders.
    expect(HOME_SCREEN_SOURCE).toMatch(
      /if\s*\(!hasDelta\s*&&\s*!hasTrend\)\s*\{\s*return\s+null/,
    );
  });

  test("delta chip uses success / danger / neutral palette tokens (no inline hex)", () => {
    // The chip must resolve through the same theme tokens as the rest
    // of the screen so dark-mode swaps stay consistent.
    expect(HOME_SCREEN_SOURCE).toMatch(
      /deltaChipPositive:[\s\S]*?backgroundColor:\s*tokens\.color\.successSoft[\s\S]*?borderColor:\s*tokens\.color\.success/,
    );
    expect(HOME_SCREEN_SOURCE).toMatch(
      /deltaChipNegative:[\s\S]*?backgroundColor:\s*tokens\.color\.dangerSoft[\s\S]*?borderColor:\s*tokens\.color\.danger/,
    );
    expect(HOME_SCREEN_SOURCE).toMatch(
      /deltaChipLabelPositive:[\s\S]*?color:\s*tokens\.color\.successFg/,
    );
    expect(HOME_SCREEN_SOURCE).toMatch(
      /deltaChipLabelNegative:[\s\S]*?color:\s*tokens\.color\.dangerFg/,
    );
  });

  test("delta chip prefixes positive values with '+' (formatDeltaLabel helper)", () => {
    // The chip reads as "+12" / "-3" / "0" — positive values need the
    // explicit + prefix because String(value) drops it.
    expect(HOME_SCREEN_SOURCE).toContain("function formatDeltaLabel(");
    expect(HOME_SCREEN_SOURCE).toMatch(/return\s+`\+\$\{value\}`/);
  });

  test("delta tone resolution maps positive>0 / negative<0 / neutral=0", () => {
    // The tone helper must split on the sign of the value so
    // success/danger/neutral palettes apply correctly.
    expect(HOME_SCREEN_SOURCE).toContain("function resolveDeltaTone(");
    expect(HOME_SCREEN_SOURCE).toMatch(/if\s*\(value\s*>\s*0\)/);
    expect(HOME_SCREEN_SOURCE).toMatch(/if\s*\(value\s*<\s*0\)/);
  });

  test("counter trend block invokes <Sparkline /> with the same tone resolution", () => {
    // Sparkline tone must match the delta chip tone so the visual
    // grouping (chip + trend) reads as a single signal.
    expect(HOME_SCREEN_SOURCE).toMatch(
      /<Sparkline[\s\S]*?points=\{trendPoints[\s\S]*?tone=\{tone\}/,
    );
  });

  test("counter trend testIDs follow the documented `${countersTestID}-${cellKey}-trend` shape", () => {
    expect(HOME_SCREEN_SOURCE).toContain(
      "`${countersTestID}-${cellKey}-trend`",
    );
    expect(HOME_SCREEN_SOURCE).toContain("`${cellTrendTestID}-delta`");
    expect(HOME_SCREEN_SOURCE).toContain("`${cellTrendTestID}-sparkline`");
  });
});
