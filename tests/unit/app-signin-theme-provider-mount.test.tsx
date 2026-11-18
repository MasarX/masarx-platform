/** Verify that signed-out FieldOps screens mount inside the theme provider. */

import * as fs from "node:fs";
import * as path from "node:path";

const APP_TSX_PATH = path.join(
  __dirname,
  "..",
  "..",
  "apps",
  "fieldops",
  "App.tsx",
);

describe("Theme provider covers the sign-in screen", () => {
  let source: string;

  beforeAll(() => {
    source = fs.readFileSync(APP_TSX_PATH, "utf8");
  });

  it("App.tsx defines a `MobileThemeBoot` wrapper component (the new mount point for ThemeProvider above the auth gates)", () => {
    expect(source).toMatch(/function\s+MobileThemeBoot\s*\(/);
  });

  it("`MobileThemeBoot` mounts `<ThemeProvider value={themeContextValue}>` so descendants resolve theme tokens via useTheme()", () => {
    // The provider mount must live in MobileThemeBoot's body (not in
    // BootstrapAuthed). We capture the slice from the function declaration
    // to the next top-level `function ` keyword and assert the provider
    // mount is inside it.
    const start = source.indexOf("function MobileThemeBoot");
    expect(start).toBeGreaterThan(-1);
    // Find the next function declaration to bound the slice.
    const remainder = source.slice(start + 1);
    const nextFnIdx = remainder.search(/\nfunction\s+\w+\s*\(/);
    const slice =
      nextFnIdx === -1 ? source.slice(start) : source.slice(start, start + 1 + nextFnIdx);
    expect(slice).toMatch(/<ThemeProvider\s+value=\{\s*themeContextValue\s*\}\s*>/);
  });

  it("`<MobileThemeBoot>` is mounted from inside `Bootstrap()` (so the provider sits ABOVE the auth gates)", () => {
    const bootstrapStart = source.indexOf("function Bootstrap()");
    expect(bootstrapStart).toBeGreaterThan(-1);
    const bootstrapAuthedStart = source.indexOf("function BootstrapAuthed");
    expect(bootstrapAuthedStart).toBeGreaterThan(bootstrapStart);
    const bootstrapBody = source.slice(bootstrapStart, bootstrapAuthedStart);
    expect(bootstrapBody).toMatch(/<MobileThemeBoot[\s>]/);
  });

  it("the `<SignInScreen>` mount appears AFTER (i.e. INSIDE) the `<MobileThemeBoot>` mount in the source", () => {
    const wrapperOpenIdx = source.indexOf("<MobileThemeBoot");
    expect(wrapperOpenIdx).toBeGreaterThan(-1);
    // Find the SignInScreen JSX mount (not the function declaration).
    const signInMountIdx = source.indexOf("<SignInScreen", wrapperOpenIdx);
    expect(signInMountIdx).toBeGreaterThan(wrapperOpenIdx);
    // And it should be BEFORE the wrapper close so it is inside the
    // render-prop body (not after </MobileThemeBoot>).
    const wrapperCloseIdx = source.indexOf("</MobileThemeBoot>", wrapperOpenIdx);
    expect(wrapperCloseIdx).toBeGreaterThan(signInMountIdx);
  });

  it("there is EXACTLY ONE `<ThemeProvider value=` mount in App.tsx (the hoisted one) — no duplicate provider inside BootstrapAuthed", () => {
    const matches = source.match(/<ThemeProvider\s+value=/g) ?? [];
    expect(matches.length).toBe(1);
  });

  it("`BootstrapAuthed` accepts `selectedThemeMode` / `themeTokens` / `appliedTheme` as props (so theme is resolved ONCE in MobileThemeBoot)", () => {
    const propsStart = source.indexOf("type BootstrapAuthedProps = {");
    expect(propsStart).toBeGreaterThan(-1);
    // Find the type's closing `};` at the start of a line (inner field
    // types like `{ me: UiMe; navigation: UiNavigation };` also contain
    // `};` so naive indexOf returns the wrong position).
    const propsEnd = source.indexOf("\n};", propsStart);
    expect(propsEnd).toBeGreaterThan(propsStart);
    const propsSlice = source.slice(propsStart, propsEnd);
    expect(propsSlice).toMatch(/selectedThemeMode:\s*MobileThemeMode/);
    expect(propsSlice).toMatch(/themeTokens:\s*ThemeTokens/);
    expect(propsSlice).toMatch(/appliedTheme:\s*AppliedTheme/);
  });

  it("the BootstrapAuthed JSX invocation forwards the resolved theme triple from the MobileThemeBoot render-prop callback", () => {
    const wrapperOpenIdx = source.indexOf("<MobileThemeBoot");
    expect(wrapperOpenIdx).toBeGreaterThan(-1);
    const wrapperCloseIdx = source.indexOf("</MobileThemeBoot>", wrapperOpenIdx);
    const renderPropBody = source.slice(wrapperOpenIdx, wrapperCloseIdx);
    // The render-prop callback should destructure the resolved values...
    expect(renderPropBody).toMatch(
      /\{\s*selectedThemeMode\s*,\s*themeTokens\s*,\s*appliedTheme\s*\}\s*\)/,
    );
    // ...and forward them to <BootstrapAuthed>.
    expect(renderPropBody).toMatch(/<BootstrapAuthed[\s\S]*?selectedThemeMode=\{\s*selectedThemeMode\s*\}/);
    expect(renderPropBody).toMatch(/<BootstrapAuthed[\s\S]*?themeTokens=\{\s*themeTokens\s*\}/);
    expect(renderPropBody).toMatch(/<BootstrapAuthed[\s\S]*?appliedTheme=\{\s*appliedTheme\s*\}/);
  });

  it("there is NO early `return <SignInScreen` outside the MobileThemeBoot wrapper", () => {
    // Old shape was a literal "return (\n      <SignInScreen ..." inside
    // `Bootstrap()` BEFORE the provider mount. After the fix, the
    // SignInScreen mount lives inside an arrow-function render-prop body
    // (no `return` JSX statement directly preceding it at indent depth 4).
    //
    // We assert this by walking ONLY the SignInScreen JSX mounts (matched
    // via a regex that requires a `<SignInScreen` token followed by either
    // a newline or whitespace — i.e. the open tag of a JSX element).
    // Doc-comment occurrences like `<SignInScreen>` inside `/* */` blocks
    // are excluded by requiring the following character to NOT be `>`.
    const wrapperOpenIdx = source.indexOf("<MobileThemeBoot");
    expect(wrapperOpenIdx).toBeGreaterThan(-1);
    const wrapperCloseIdx = source.indexOf("</MobileThemeBoot>", wrapperOpenIdx);
    expect(wrapperCloseIdx).toBeGreaterThan(wrapperOpenIdx);

    // Match `<SignInScreen` followed by whitespace (open-tag start) — this
    // excludes both `function SignInScreen({` (the declaration) and
    // `<SignInScreen>` inside doc comments. The lookahead `(?=\s)` ensures
    // we only hit JSX mounts.
    const mountRegex = /<SignInScreen(?=\s)/g;
    const mountMatches: number[] = [];
    let m: RegExpExecArray | null;
    while ((m = mountRegex.exec(source)) !== null) {
      mountMatches.push(m.index);
    }
    // There must be at least one mount (the v6 fix preserves the
    // SignInScreen render path; it just hoists ThemeProvider above it).
    expect(mountMatches.length).toBeGreaterThanOrEqual(1);
    // Every JSX mount must be INSIDE the MobileThemeBoot wrapper bounds.
    for (const mountIdx of mountMatches) {
      expect(mountIdx).toBeGreaterThan(wrapperOpenIdx);
      expect(mountIdx).toBeLessThan(wrapperCloseIdx);
    }
  });

  it("`MobileThemeBoot` owns the canonical theme resolution (themeModeQuery + selectedThemeMode + themeTokens + setShellThemeMode + themeContextValue) so the resolved triple has a single source of truth", () => {
    const start = source.indexOf("function MobileThemeBoot");
    expect(start).toBeGreaterThan(-1);
    const remainder = source.slice(start + 1);
    const nextFnIdx = remainder.search(/\nfunction\s+\w+\s*\(/);
    const slice =
      nextFnIdx === -1 ? source.slice(start) : source.slice(start, start + 1 + nextFnIdx);
    expect(slice).toMatch(/const\s+themeModeQuery\s*=\s*useQuery/);
    expect(slice).toMatch(/const\s+selectedThemeMode\s*=\s*React\.useMemo/);
    expect(slice).toMatch(/const\s+themeTokens\s*=\s*React\.useMemo/);
    expect(slice).toMatch(/const\s+appliedTheme\s*=\s*React\.useMemo/);
    expect(slice).toMatch(/const\s+setShellThemeMode\s*=\s*React\.useCallback/);
    expect(slice).toMatch(/const\s+themeContextValue\s*=\s*React\.useMemo/);
  });

  it("`BootstrapAuthed` no longer redeclares `themeModeQuery` / `selectedThemeMode` / `themeContextValue` / a second `<ThemeProvider value=` mount (single source of truth)", () => {
    const start = source.indexOf("function BootstrapAuthed");
    expect(start).toBeGreaterThan(-1);
    // BootstrapAuthed is the last large function; slice to end-of-file.
    const slice = source.slice(start);
    expect(slice).not.toMatch(/const\s+themeModeQuery\s*=\s*useQuery/);
    expect(slice).not.toMatch(/const\s+selectedThemeMode\s*=\s*React\.useMemo/);
    expect(slice).not.toMatch(/const\s+setShellThemeMode\s*=\s*React\.useCallback/);
    expect(slice).not.toMatch(/const\s+themeContextValue\s*=\s*React\.useMemo/);
    expect(slice).not.toMatch(/<ThemeProvider\s+value=/);
  });

  it("the AppliedTheme + ThemeTokens types are imported as TS-types (so the new BootstrapAuthed prop signature compiles)", () => {
    expect(source).toMatch(/type\s+AppliedTheme\b/);
    expect(source).toMatch(/type\s+ThemeTokens\b/);
  });
});
