// Verify visible scan chips, input validation and compact selection copy.
import * as fs from "node:fs";
import * as path from "node:path";

const APP_TSX_PATH = path.resolve(
  __dirname,
  "..",
  "..",
  "apps",
  "fieldops",
  "App.tsx",
);

function readScanScreenSource(): string {
  const fullSource = fs.readFileSync(APP_TSX_PATH, "utf8");
  const startMarker = "function ScanScreen(";
  const startIdx = fullSource.indexOf(startMarker);
  if (startIdx < 0) {
    throw new Error("ScanScreen function not found in apps/fieldops/App.tsx");
  }
  // ScanScreen is followed by a comment block then the next screen
  // function (LocationScreen was extracted; today the next sibling is
  // MoreScreen). Try MoreScreen first, then any "function " after
  // ScanScreen as a fallback so this slicer survives further extractions.
  const moreIdx = fullSource.indexOf("function MoreScreen(", startIdx);
  const fallbackIdx = fullSource.indexOf("\nfunction ", startIdx + startMarker.length);
  const endIdx =
    moreIdx >= 0
      ? moreIdx
      : fallbackIdx >= 0
        ? fallbackIdx
        : fullSource.length;
  return fullSource.slice(startIdx, endIdx);
}

describe("Scan screen controls", () => {
  const source = readScanScreenSource();

  // Narrow the chip-rendering region so unrelated chip styling elsewhere in
  // the file (e.g. scan-input-mode chips) cannot accidentally satisfy the
  // assertions. The scan-type selection card is anchored on the
  // typeSelection testID; the next sibling is the barcode TextInput block.
  const typeSelectionAnchor = "MOBILE_TEST_IDS.scan.typeSelection";
  const typeSelectionStart = source.indexOf(typeSelectionAnchor);
  if (typeSelectionStart < 0) {
    throw new Error(
      "Scan-type selection block (typeSelection testID) not found in ScanScreen",
    );
  }
  // Barcode TextInput sits right after the type-selection card. Use the
  // setBarcode change handler as the next reliable anchor.
  const barcodeChangeAnchor = "onChangeText={setBarcode}";
  const barcodeAnchorStart = source.indexOf(barcodeChangeAnchor, typeSelectionStart);
  if (barcodeAnchorStart < 0) {
    throw new Error("Barcode TextInput (setBarcode) not found in ScanScreen");
  }
  const typeSelectionBlock = source.slice(typeSelectionStart, barcodeAnchorStart);

  // Capture the barcode TextInput element (open <TextInput ... /> back to
  // the matching tag start that contains the setBarcode change handler).
  const barcodeOpenIdx = source.lastIndexOf("<TextInput", barcodeAnchorStart);
  const barcodeCloseIdx = source.indexOf("/>", barcodeAnchorStart);
  if (barcodeOpenIdx < 0 || barcodeCloseIdx < 0) {
    throw new Error("Barcode TextInput tag boundaries not found in ScanScreen");
  }
  const barcodeInputBlock = source.slice(barcodeOpenIdx, barcodeCloseIdx + 2);

  describe("scan-type chip labels can wrap (no Deliv... truncation)", () => {
    test("chip Text inside the type-selection card declares numberOfLines>=2", () => {
      // Allow long chip text to remain visible without clipping.
      const chipTextMatch = typeSelectionBlock.match(
        /<Text\s+style=\{styles\.chipText\}\s+numberOfLines=\{(\d+)\}/,
      );
      expect(chipTextMatch).not.toBeNull();
      const declaredLines = Number(chipTextMatch![1]);
      expect(declaredLines).toBeGreaterThanOrEqual(2);
    });

    test("chip Text does NOT clamp to a single line", () => {
      // Defense-in-depth: explicit numberOfLines={1} on the chip label
      // would re-introduce the truncation regardless of width. Reject it.
      const truncatingChip =
        /<Text\s+style=\{styles\.chipText\}\s+numberOfLines=\{1\}/.exec(
          typeSelectionBlock,
        );
      expect(truncatingChip).toBeNull();
    });
  });

  describe("barcode TextInput is hardened for 1D/2D codes", () => {
    test("barcode input declares autoCapitalize=\"none\"", () => {
      expect(barcodeInputBlock).toMatch(/autoCapitalize="none"/);
    });

    test("barcode input disables autoCorrect", () => {
      expect(barcodeInputBlock).toMatch(/autoCorrect=\{false\}/);
    });

    test("barcode input disables spellCheck", () => {
      expect(barcodeInputBlock).toMatch(/spellCheck=\{false\}/);
    });

    test("barcode input declares a keyboardType hint", () => {
      // "visible-password" is preferred (preserves case + suppresses
      // autocomplete chrome on most platforms); "default" is also
      // acceptable when paired with the rest of the hardening.
      expect(barcodeInputBlock).toMatch(
        /keyboardType="(?:visible-password|default)"/,
      );
    });

    test("barcode input declares inputMode for RN-Web parity", () => {
      // RN-Web maps inputMode -> the HTML inputmode attribute, which is
      // the spec-compliant way to drive on-screen keyboards on web.
      expect(barcodeInputBlock).toMatch(/inputMode="(?:text|search|none)"/);
    });

    test("barcode input exposes accessibilityLabel for screen readers", () => {
      expect(barcodeInputBlock).toMatch(/accessibilityLabel=\{strings\.scan\.barcodePlaceholder\}/);
    });
  });

  describe("redundant \"Selected:\" cue removed", () => {
    test("ScanScreen no longer renders a 'Selected: <label>' visible cue", () => {
      // The visual "Selected: ..." Text was redundant — the active chip
      // styling (methodChipActive) plus accessibilityState.selected on
      // each chip already conveys selection visually and to screen
      // readers. The literal 'Selected: ' rendered as JSX text must be
      // gone (we still allow the word inside accessibility hints or
      // comments — only the user-visible Text>{`Selected: …`}</Text>
      // pattern is forbidden).
      const visibleSelectedCue =
        />\s*Selected:\s*\{selectedScanTypeLabel\}\s*</.exec(source);
      expect(visibleSelectedCue).toBeNull();
    });

    test("active-chip selection cue is preserved via accessibilityState.selected", () => {
      // Removing the visual cue is only acceptable because each chip
      // still surfaces its selection state to assistive tech via
      // accessibilityState.selected. If this regresses we have lost the
      // SR cue entirely.
      expect(typeSelectionBlock).toMatch(/accessibilityState=\{\{\s*selected:/);
    });
  });
});
