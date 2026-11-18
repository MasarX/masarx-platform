import type { Page } from "@playwright/test";
import * as en from "../../../packages/config/messages/en.json";
import * as ar from "../../../packages/config/messages/ar.json";
import { formatJsonForUi } from "../../../packages/ui/src/workflow-run-logs-model";
import { waitForOperationReport } from "../../e2e/utils/resource-import";

jest.mock("@playwright/test", () => ({
  expect: (actual: unknown) => ({
    toBe: (expected: unknown) => expect(actual).toBe(expected),
    toEqual: (expected: unknown) => expect(actual).toEqual(expected),
    toMatch: (expected: RegExp) => expect(actual).toMatch(expected),
    toHaveLength: (expected: number) => expect(actual).toHaveLength(expected),
    toHaveJSProperty: async (name: string, expected: unknown) => expect(actual).toHaveProperty(name, expected),
    toBeVisible: async () => expect(actual).toHaveProperty("visible", true),
    toContainText: async (expected: string) => expect(actual).toHaveProperty("text", expect.stringContaining(expected)),
  }),
}));

const identity = { id: "4d1fbd36-6b6e-4c35-acc4-5e3ad9043830", organization_id: "22222222-2222-4222-8222-222222222222",
  scope_context: { tenant: "22222222-2222-4222-8222-222222222222" } };
const targetId = "33333333-3333-4333-8333-333333333333";

function harness(messages = en.ui.operationReport, initiallyOpen = false) {
  const run = { ...identity, status: "completed", created_count: 1, failed_count: 0, rows: [{ row_number: 1,
    execution_status: "succeeded", mapped_row: { recipient_id: targetId },
    related_nodes: [{ node_key: "recipient", execution_status: "succeeded", target_record_id: targetId, reference_field: "recipient_id" }],
  }] };
  const disclosure = (label: string) => {
    let open = initiallyOpen;
    const summary = { visible: true, click: jest.fn(async () => { open = true; }) };
    const pre = { get visible() { return open; }, text: formatJsonForUi({ ...identity, status: "completed", created_count: 1, password: "synthetic-secret" }) };
    return { label, summary, pre, get open() { return open; }, getAttribute: jest.fn(async () => open ? "" : null),
      locator: jest.fn((selector: string) => selector === "summary" ? summary : selector === "pre" ? pre
        : { text: "Review the imported records in the destination table or import history." }),
    };
  };
  const report = disclosure(messages.reportDetails);
  const result = disclosure(messages.resultDetails);
  const post = jest.fn(async () => ({ ok: () => true, status: () => 200, json: async () => run }));
  const page = { url: () => "https://masarx.example.test/console/resources/shipments", request: { post },
    locator: (selector: string) => selector === "summary"
      ? { filter: ({ hasText }: { hasText: RegExp }) => hasText }
      : { filter: ({ has }: { has: RegExp }) => has.test(report.label) ? report : has.test(result.label) ? result : null },
  } as unknown as Page;
  return { run, report, result, post, execute: () => waitForOperationReport(page, identity, { createdCount: 1, relatedNodes: ["recipient"] }) };
}

test.each([
  ["en", false, en.ui.operationReport], ["en", true, en.ui.operationReport],
  ["ar", false, ar.ui.operationReport], ["ar", true, ar.ui.operationReport],
] as const)("reads the exact authorized run without closing an open disclosure (%s, initiallyOpen=%s)", async (_locale, initiallyOpen, messages) => {
  const h = harness(messages, initiallyOpen);
  await h.execute();
  expect(h.report.summary.click).toHaveBeenCalledTimes(initiallyOpen ? 0 : 1);
  expect(h.result.summary.click).toHaveBeenCalledTimes(initiallyOpen ? 0 : 1);
  expect(h.result.pre.text).toContain('[redacted]');
  expect(h.result.pre.text).not.toContain(identity.id);
  expect(h.result.pre.text).not.toContain(identity.organization_id);
  expect(h.post).toHaveBeenCalledWith("https://masarx.example.test/api/resource-import", {
    headers: { origin: "https://masarx.example.test" }, data: { action: "get_run", run_id: identity.id },
  });
});

test("rejects runtime support JSON that exposes raw run and organization IDs", async () => {
  const h = harness();
  h.result.pre.text = JSON.stringify({ ...identity, status: "completed", created_count: 1 }, null, 2);
  await expect(h.execute()).rejects.toThrow();
});

test.each(["id", "organization_id", "scope_context", "status", "created_count", "failed_count"])("rejects stale or mismatched %s even if the UI still displays completed", async (field) => {
  const h = harness();
  Object.assign(h.run, { [field]: field === "scope_context" ? { tenant: "foreign" } : field.endsWith("count") ? 9 : "mismatched" });
  await expect(h.execute()).rejects.toThrow();
});

test.each(["queued", "echoed", "wrong-reference"])("rejects a %s related-node result instead of treating echoed schema as execution", async (state) => {
  const h = harness();
  const node = h.run.rows[0]!.related_nodes[0]!;
  if (state === "queued") node.execution_status = "queued";
  if (state === "echoed") node.target_record_id = "";
  if (state === "wrong-reference") h.run.rows[0]!.mapped_row.recipient_id = "foreign";
  await expect(h.execute()).rejects.toThrow();
});
