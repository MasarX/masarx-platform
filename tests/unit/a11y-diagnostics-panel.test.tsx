jest.mock("react-native", () => ({
  View: "View",
  Text: "Text",
  Pressable: "Pressable",
  TextInput: "TextInput",
  Modal: "Modal",
  Dimensions: { get: () => ({ height: 800 }) },
  StyleSheet: { create: (styles: object) => styles, absoluteFillObject: {} },
}), { virtual: true });
import {
  summarizeSeverityCounts,
  topFindingTitles,
} from "../../apps/fieldops/src/screens/A11yDiagnosticsPanel";
import type { A11yFinding } from "../../apps/fieldops/src/mobile-a11y-audit";

const findings: A11yFinding[] = [
  { id: "1", severity: "critical", criterion: "Name", message: "Label missing", target: null, fix_hint: "" },
  { id: "2", severity: "major", criterion: "", message: "Target too small", target: null, fix_hint: "" },
  { id: "3", severity: "minor", criterion: "Order", message: "", target: null, fix_hint: "" },
];

test("tallies recognized severity levels and handles empty findings", () => {
  expect(summarizeSeverityCounts(findings)).toEqual({ critical: 1, major: 1, minor: 1, total: 3 });
  expect(summarizeSeverityCounts([])).toEqual({ critical: 0, major: 0, minor: 0, total: 0 });
});

test("keeps finding order and applies the requested title limit", () => {
  expect(topFindingTitles(findings)).toEqual(["Name — Label missing", "Target too small", "Order"]);
  expect(topFindingTitles(findings, 2)).toEqual(["Name — Label missing", "Target too small"]);
  expect(topFindingTitles(findings, 0)).toEqual([]);
});
