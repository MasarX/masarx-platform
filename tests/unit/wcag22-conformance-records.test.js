const fs = require("node:fs");
const path = require("node:path");

// The #301 contract: every core screen has a record for each WCAG 2.2 AA criterion axe cannot check.
const RECORDS_FILE = "docs/product/ux/wcag22-conformance.json";
const CRITERIA = [
  "keyboard-focus-order", // 2.1.1, 2.4.3, 2.4.7
  "focus-not-obscured", // 2.4.11
  "reflow-320", // 1.4.10
  "text-spacing", // 1.4.12
  "accessible-authentication", // 3.3.8
  "consistent-help", // 3.2.6
  "redundant-entry", // 3.3.7
  "status-messages", // 4.1.3
  "reduced-motion", // 2.2.2 and DESIGN.md section 9
];
// Slice 9 screens; slice 8 adds the Console V2 core screens here.
const REQUIRED = {
  landing: CRITERIA,
  "public-tracking": CRITERIA,
  "portal-tracking": CRITERIA,
  "fieldops-trips": CRITERIA,
  "fieldops-stop": CRITERIA,
  "fieldops-pod": CRITERIA,
  "print-progress-widget": ["reduced-motion"],
};
const ISSUE_URL = /^https:\/\/github\.com\/MasarX\/masarx-platform\/issues\/\d+$/;

function conformanceProblems(doc, required, root) {
  const problems = [];
  const screens = (doc && doc.screens) || {};
  for (const [screen, criteria] of Object.entries(required)) {
    const records = screens[screen] && screens[screen].records;
    if (!records) {
      problems.push(`${screen}: missing screen`);
      continue;
    }
    for (const criterion of criteria) {
      const record = records[criterion];
      const at = `${screen}/${criterion}`;
      if (!record) { problems.push(`${at}: missing record`); continue; }
      if (!["pass", "fail", "na"].includes(record.status)) problems.push(`${at}: status must be pass, fail or na`);
      if (typeof record.evidence !== "string" || record.evidence.trim().length < 10) problems.push(`${at}: blank evidence`);
      if (record.status === "fail" && !ISSUE_URL.test(record.issue || "")) problems.push(`${at}: a fail needs its issue link`);
      if (record.status !== "fail" && record.issue !== undefined) problems.push(`${at}: only a fail carries an issue`);
      const spec = /^ci: (\S+)/.exec(record.evidence || "");
      if (spec && !fs.existsSync(path.join(root, spec[1]))) problems.push(`${at}: evidence spec ${spec[1]} not found`);
    }
    for (const criterion of Object.keys(records)) {
      if (!criteria.includes(criterion)) problems.push(`${screen}/${criterion}: unknown criterion`);
    }
  }
  return problems;
}

const root = path.resolve(__dirname, "../..");
const doc = JSON.parse(fs.readFileSync(path.join(root, RECORDS_FILE), "utf8"));

test("every core screen has a complete WCAG 2.2 AA conformance record", () => {
  expect(conformanceProblems(doc, REQUIRED, root)).toEqual([]);
});

test("the record check fails on a missing record or a blank criterion", () => {
  const broken = JSON.parse(JSON.stringify(doc));
  delete broken.screens["fieldops-pod"].records["reflow-320"];
  broken.screens.landing.records["text-spacing"].evidence = " ";
  delete broken.screens["portal-tracking"].records["status-messages"].status;
  broken.screens["fieldops-trips"].records["reduced-motion"] = { status: "fail", evidence: "manual check found looping motion" };
  delete broken.screens["fieldops-stop"];
  expect(conformanceProblems(broken, REQUIRED, root)).toEqual([
    "landing/text-spacing: blank evidence",
    "portal-tracking/status-messages: status must be pass, fail or na",
    "fieldops-trips/reduced-motion: a fail needs its issue link",
    "fieldops-stop: missing screen",
    "fieldops-pod/reflow-320: missing record",
  ]);
});
