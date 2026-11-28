import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const app = readFileSync(resolve(__dirname, "../../apps/fieldops/App.tsx"), "utf8");

test("scopes each live poll to the receiving signed-in delivery or displayed route", () => {
  expect(app).toMatch(/queryKey: \["contactless-signing-result", signingTenantId, sessionUserId, selectedResourceId\][\s\S]*?enabled: Boolean\(signingScope\) && contactlessSigningAvailable\.data === true[\s\S]*?pending_customer_sign_events_v1/);
  expect(app).toMatch(/queryKey: \["route", "pending-stop-offers", manifestRouteRunId, displayedRouteScope, sessionUserId\][\s\S]*?routeExecutionManifestQuery\.data[\s\S]*?pending_mid_route_stops_v1/);
  expect(app).toMatch(/!drivingModeLocked && routeOfferUiMode !== "suppressed" && \(pendingRouteOffers\.data/);
});
