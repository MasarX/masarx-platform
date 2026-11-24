import * as fs from "fs";
import * as path from "path";

// Designer controls use theme tokens so they follow light and dark themes (#362).
const root = path.join(__dirname, "../../packages/ui/src/label-designer");
const RAW_PALETTE = /\b(?:bg|text|border|ring)-(?:blue|green|red|yellow|amber|gray|white)(?:-\d+)?\b/g;
// label-canvas.tsx draws the printed label, which keeps white paper in every theme.
// The selected layer row keeps bg-blue-50 / text-blue-700 because a trunk test asserts that class.
const ALLOWED: Record<string, string[]> = {
  "canvas/label-canvas.tsx": ["bg-white"],
  "canvas/canvas-layers-panel.tsx": ["bg-blue-50", "text-blue-700"],
};

function sources(dir: string): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) return sources(full);
    return /\.tsx$/.test(entry.name) && !/\.stories\.tsx$/.test(entry.name) ? [full] : [];
  });
}

describe("label designer theme tokens", () => {
  it("uses no raw palette colors outside the documented exceptions", () => {
    const found: Record<string, string[]> = {};
    for (const file of sources(root)) {
      const rel = path.relative(root, file).split(path.sep).join("/");
      const hits = (fs.readFileSync(file, "utf8").match(RAW_PALETTE) ?? []).filter(
        (cls) => !(ALLOWED[rel] ?? []).includes(cls),
      );
      if (hits.length > 0) found[rel] = hits;
    }
    expect(found).toEqual({});
  });
});
