import { spawnSync } from "node:child_process";
import { loadE2EEnv } from "./env";
import { assertE2EMutationsAllowed } from "./mutations";

type FixtureSummary = {
  support_cases: {
    timing_change: {
      id: string;
      change_summary: string;
    };
    applied_location_change: {
      id: string;
      change_summary: string;
    };
    pending_review_primary: {
      id: string;
      change_summary: string;
    };
    pending_review_secondary: {
      id: string;
      change_summary: string;
    };
  };
};

export function provisionCustomerShipmentChangeReviewFixtures(): FixtureSummary {
  loadE2EEnv();
  assertE2EMutationsAllowed({
    label: "customer-shipment-change-review",
    details: "This test provisions synthetic shipment change cases.",
  });
  const result = spawnSync(
    process.execPath,
    ["scripts/qa/provision-customer-shipment-change-review-fixtures.js"],
    {
      cwd: process.cwd(),
      encoding: "utf8",
    },
  );

  if (result.status !== 0) {
    throw new Error(
      result.stderr?.trim() ||
        result.stdout?.trim() ||
        "failed to provision customer shipment change review fixtures",
    );
  }

  return JSON.parse(result.stdout.trim()) as FixtureSummary;
}
