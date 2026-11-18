import * as fs from "node:fs";
import * as path from "node:path";
const app = fs.readFileSync(path.resolve(__dirname, "../../../apps/fieldops/App.tsx"), "utf8");
test("the operational app does not render raw detail, policy or storage-key dumps", () => {
  for (const text of ["mobile-detail-toggle-system", "showSystemDetails", "formatDetailValue", ">Policy context</Text>", ">Diagnostics policy row</Text>", ">Local keys</Text>"]) expect(app).not.toContain(text);
});
test("removing raw displays retains operational detail and support receipts", () => {
  for (const text of ["<RouteSurfaceDetailExtensions", "lastActionReceipt.recordedAt", "outboxStatsQuery.data", "Clear local data", "Queue ping"]) expect(app).toContain(text);
});
