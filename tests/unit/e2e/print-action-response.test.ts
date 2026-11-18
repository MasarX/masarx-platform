import type { Locator, Page, Response } from "@playwright/test";
import { runPrintLabelsAction } from "../../e2e/utils/print-action";

jest.mock("@playwright/test", () => ({
  expect: (actual: unknown) => ({
    toBeVisible: async () => undefined,
    toBe: (expected: unknown) => expect(actual).toBe(expected),
  }),
}));

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function responseFor(payload: Record<string, unknown>, workflowRunId?: string) {
  const request = {
    method: jest.fn(() => "POST"),
    postDataJSON: jest.fn(() => payload),
    postData: jest.fn(() => JSON.stringify(payload)),
  };
  return {
    request: jest.fn(() => request),
    url: jest.fn(() => "https://example.test/rpc/ui_execute_command_v1"),
    json: jest.fn(async () => ({ workflow_run_id: workflowRunId })),
  } as unknown as Response;
}

function harness() {
  const rpc = deferred<Response>();
  const confirm = deferred<void>();
  const actionButton = { click: jest.fn(async () => undefined) };
  const confirmButton = { click: jest.fn(() => confirm.promise) };
  const context = { waitForEvent: jest.fn(async () => null) };
  const page = {
    locator: jest.fn((selector: string) => {
      if (selector === '[data-testid="print-confirm-dialog"]') return {};
      if (selector === '[data-testid="print-confirm-submit"]') return confirmButton;
      throw new Error(`Unexpected locator: ${selector}`);
    }),
    waitForResponse: jest.fn<Promise<Response>, [(response: Response) => Promise<boolean>, { timeout: number }]>(() => rpc.promise),
    context: jest.fn(() => context),
    waitForEvent: jest.fn(async () => undefined),
  };
  const run = () => runPrintLabelsAction({
    page: page as unknown as Page,
    actionButton: actionButton as unknown as Locator,
    bulkActionsTestIdPrefix: "print",
    expectedSelectionCount: 2,
    contextLabel: "synthetic shipments",
  });
  return { rpc, confirm, actionButton, confirmButton, context, page, run };
}

const flush = () => new Promise<void>((resolve) => setImmediate(resolve));

test("handles a late RPC rejection after confirm fails without leaving it unobserved", async () => {
  const h = harness();
  // Keep the pre-fix self-check safe while separately tracking the helper's handler.
  void h.rpc.promise.catch(() => undefined);
  const rpcThen = jest.spyOn(h.rpc.promise, "then");
  const clickFailure = new Error("confirm click timed out");
  const result = h.run();
  const rejection = expect(result).rejects.toBe(clickFailure);
  await flush();
  expect(h.confirmButton.click).toHaveBeenCalledWith({ timeout: 20_000 });
  h.confirm.reject(clickFailure);
  await rejection;
  h.rpc.reject(new Error("page.waitForResponse: Test ended"));
  await flush();
  expect(rpcThen.mock.calls.some(([, onRejected]) => typeof onRejected === "function")).toBe(true);
});

test("propagates an RPC failure while the confirm click is still pending", async () => {
  const h = harness();
  const rpcFailure = new Error("RPC response wait failed");
  const result = h.run();
  const rejection = expect(result).rejects.toBe(rpcFailure);
  await flush();
  h.rpc.reject(rpcFailure);
  await rejection;
  h.confirm.resolve(undefined);
  await flush();
});

test.each([
  {
    payload: { p_action_key: "other_action" },
    reason: "Invalid print command request payload",
  },
  {
    payload: { p_action_key: "shipments.print_labels", p_selection_count: 2, p_selection_ids: ["shipment-1"] },
    reason: "Missing selection IDs in print request payload",
  },
  {
    payload: { p_action_key: "shipments.print_labels", p_selection_count: 2, p_selection_ids: ["shipment-1", "shipment-2"] },
    reason: "Missing workflow_run_id in print command response",
  },
])("keeps request validation after a successful click/response pair: $reason", async ({ payload, reason }) => {
  const h = harness();
  const response = responseFor(payload);
  const result = h.run();
  const rejection = expect(result).rejects.toThrow(reason);
  await flush();
  h.confirm.resolve(undefined);
  h.rpc.resolve(response);
  await rejection;
  expect(response.request().postDataJSON).toHaveBeenCalled();
  expect(h.page.waitForResponse).toHaveBeenCalledWith(expect.any(Function), { timeout: 60_000 });
  expect(h.context.waitForEvent).toHaveBeenCalledWith("page", { timeout: 25_000 });
  expect(h.page.waitForEvent).toHaveBeenCalledWith("download", { timeout: 25_000 });
  expect(h.page.waitForResponse.mock.invocationCallOrder[0]).toBeLessThan(h.confirmButton.click.mock.invocationCallOrder[0]);
  const matcher = h.page.waitForResponse.mock.calls[0][0] as (candidate: Response) => Promise<boolean>;
  const matchingResponse = responseFor({ p_action_key: "shipments.print_labels" });
  await expect(matcher(matchingResponse)).resolves.toBe(true);
  await expect(matcher(responseFor({ p_action_key: "other_action" }))).resolves.toBe(false);
  jest.spyOn(matchingResponse.request(), "method").mockReturnValue("GET");
  await expect(matcher(matchingResponse)).resolves.toBe(false);
});
