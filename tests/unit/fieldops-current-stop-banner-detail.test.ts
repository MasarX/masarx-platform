import * as fs from "fs";
import * as path from "path";

// Verify that task and route detail retain current-stop context where applicable.

const REPO_ROOT = path.resolve(__dirname, "..", "..");
const APP_TSX_PATH = path.join(
  REPO_ROOT,
  "apps",
  "fieldops",
  "App.tsx",
);

function readAppTsx(): string {
  return fs.readFileSync(APP_TSX_PATH, "utf8");
}

describe("fieldops persistent CurrentStopBanner on resource detail", () => {
  describe("App.tsx — detail render wires the persistent banner", () => {
    test("renders a wrapper with the canonical persistent-banner testID", () => {
      const source = readAppTsx();
      // The wrapper testID is the stable hook used by E2E + a11y suites
      // to assert the persistent banner is mounted on the detail surface.
      expect(source).toContain(
        'testID="mobile-detail-persistent-current-stop-banner"',
      );
    });

    test("the conditional gates the banner to task / route surfaces only", () => {
      const source = readAppTsx();
      // The persistent banner must only render on task / route surfaces;
      // settlements and other surfaces have no current-stop concept.
      expect(source).toMatch(
        /\(isRouteSurface\s*\|\|\s*isTasksSurface\)\s*&&\s*[\r\n\s]*currentStopBannerStop/,
      );
    });

    test("the conditional gates the banner to a stop OTHER than the current active stop", () => {
      const source = readAppTsx();
      // Hide the banner for details that do not belong to the current stop.
      expect(source).toMatch(
        /selectedResourceId\s*!==\s*currentStopBannerStop\.stopId/,
      );
    });

    test("the persistent banner mounts the real CurrentStopBanner component", () => {
      const source = readAppTsx();
      // The component import is shared with the list-pane banner; the
      // detail-surface render must mount the same canonical component
      // (not a stub or duplicated inline view), so behavior + a11y remain
      // consistent across surfaces.
      const wrapperIdx = source.indexOf(
        'testID="mobile-detail-persistent-current-stop-banner"',
      );
      expect(wrapperIdx).toBeGreaterThan(-1);
      const wrapperBlock = source.slice(wrapperIdx, wrapperIdx + 2000);
      expect(wrapperBlock).toContain("<CurrentStopBanner");
      // Reuses the canonical row-driven snapshot + i18n strings; this
      // guards against a future regression that re-defines a per-surface
      // copy or stop shape.
      expect(wrapperBlock).toContain("stop={currentStopBannerStop}");
      expect(wrapperBlock).toContain("strings={currentStopBannerStrings}");
      // Reuses the canonical open + navigate handlers (open via
      // `setSelectedResourceId`, navigate via `buildNavigationUrl`).
      expect(wrapperBlock).toContain("onOpenStop=");
      expect(wrapperBlock).toContain("onNavigateStop=");
    });

    test("the persistent banner is rendered ABOVE the detail header (not inside or after)", () => {
      const source = readAppTsx();
      const wrapperIdx = source.indexOf(
        'testID="mobile-detail-persistent-current-stop-banner"',
      );
      const detailWrapperIdx = source.indexOf("<View style={styles.detailWrapper}>");
      // Read the resolved title layout from the combined styles.
      const detailHeaderMatch = source.match(/<View style=\{(?:styles\.detailHeader|\[\s*styles\.detailHeader\b)/);
      const detailHeaderIdx = detailHeaderMatch
        ? source.indexOf(detailHeaderMatch[0])
        : -1;
      expect(wrapperIdx).toBeGreaterThan(-1);
      expect(detailWrapperIdx).toBeGreaterThan(-1);
      expect(detailHeaderIdx).toBeGreaterThan(-1);
      // Banner must sit between the detail wrapper opening and the header
      // opening — i.e. pinned at the top of the detail panel, above the
      // "Back" button + title row.
      expect(wrapperIdx).toBeGreaterThan(detailWrapperIdx);
      expect(wrapperIdx).toBeLessThan(detailHeaderIdx);
    });
  });
});
