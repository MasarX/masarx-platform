import { QueryClient } from "@tanstack/react-query";
import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { BulkActions, type BulkActionDefinition } from "../../packages/ui/src/bulk-actions";
import {
  parseBatchResultReadback,
  requiresBatchResultEvidence
} from "../../packages/ui/src/bulk-action-result-readback";
import { setUiReporter } from "../../packages/ui/src/reporting";
import { renderWithIntl } from "./test-utils";

const rpcMock = jest.fn();

jest.mock("@masarx/api", () => ({
  ...jest.requireActual("@masarx/api"),
  createUiClient: () => ({ rpc: rpcMock })
}));

jest.mock("@masarx/auth/browser", () => ({
  createBrowserClient: () => ({
    auth: {
      getSession: jest.fn().mockResolvedValue({
        data: { session: { access_token: "token-123" } },
        error: null
      })
    }
  })
}));

const action: BulkActionDefinition = {
  key: "shipments.delete",
  label: "Delete shipments",
  resourceKey: "shipments",
  selection: { mode: "multi", min_count: 1 },
  execution: {
    type: "rpc",
    rpc: "ui_execute_shipment_batch_operation_v1",
    result_contract: "batch_items_v1",
    params: { operation: "cancel" }
  }
};

const selectedIds = ["shp-1", "shp-2"];

const item = (id: string, overrides: Record<string, unknown> = {}) => ({
  selection_id: id,
  status: "cancelled",
  ok: true,
  ...overrides
});

const runAction = async (result: Record<string, unknown>) => {
  rpcMock.mockResolvedValueOnce(result);
  const user = userEvent.setup();
  renderWithIntl(
    <BulkActions actions={[action]} selectedIds={selectedIds} testIdPrefix="shipments" />
  );
  await user.click(screen.getByRole("button", { name: action.label }));
  await user.click(await screen.findByRole("button", { name: "Confirm" }));
  return screen.findByTestId("shipments-bulk-actions-result");
};

beforeEach(() => {
  rpcMock.mockReset();
  setUiReporter(jest.fn());
});

afterEach(() => {
  setUiReporter(null);
  jest.restoreAllMocks();
});

test("shows verified totals and per-item outcomes for a full batch success", async () => {
  const invalidateSpy = jest.spyOn(QueryClient.prototype, "invalidateQueries");
  const readback = await runAction({
    status: "cancelled",
    count: 2,
    success_count: 2,
    failure_count: 0,
    already_processed_count: 0,
    items: [item("shp-1"), item("shp-2")]
  });

  expect(within(readback).getByText("Delete shipments: Completed")).toBeInTheDocument();
  expect(within(readback).getByTestId("shipments-bulk-actions-result-summary")).toHaveTextContent(
    "Total 2 · Successful 2 · Failed 0 · Already processed 0"
  );
  expect(within(readback).getByTestId("shipments-bulk-actions-result-item-shp-1")).toHaveAttribute(
    "data-outcome",
    "success"
  );
  await waitFor(() =>
    expect(invalidateSpy).toHaveBeenCalledWith({
      queryKey: ["resource", "shipments"],
      refetchType: "active"
    })
  );
});

test("publishes committed results before refresh and preserves them when refresh fails", async () => {
  const reporter = jest.fn();
  setUiReporter(reporter);
  const readback = jest.fn();
  const refresh = jest.fn(async () => {
    throw new Error("Rows unavailable");
  });
  rpcMock.mockResolvedValueOnce({ status: "cancelled", count: 2, success_count: 2,
    failure_count: 0, already_processed_count: 0, items: [item("shp-1"), item("shp-2")] });
  const user = userEvent.setup();
  renderWithIntl(<BulkActions actions={[action]} selectedIds={selectedIds}
    testIdPrefix="shipments" onSuccess={refresh} onBatchResultReadbackChange={readback} />);
  await user.click(screen.getByRole("button", { name: action.label }));
  await user.click(await screen.findByRole("button", { name: "Confirm" }));
  await waitFor(() => expect(refresh).toHaveBeenCalledTimes(1));
  const committedIndex = readback.mock.calls.findIndex(([result]) => result?.success === 2 && result?.failure === 0);
  expect(committedIndex).toBeGreaterThanOrEqual(0);
  expect(readback.mock.invocationCallOrder[committedIndex]).toBeLessThan(refresh.mock.invocationCallOrder[0]);
  expect(await screen.findByTestId("shipments-bulk-actions-result-item-shp-1")).toHaveAttribute("data-outcome", "success");
  await waitFor(() => expect(reporter.mock.calls.map(([event]) => event.type)).toContain("ui.bulk_action.readback.refresh_error"));
  expect(reporter.mock.calls.map(([event]) => event.type)).not.toContain("ui.bulk_action.result.failed");
});

test("reports accepted queued items without a completion event or success count", async () => {
  const reporter = jest.fn();
  setUiReporter(reporter);
  const readback = await runAction({
    status: "queued",
    count: 2,
    success_count: 0,
    failure_count: 0,
    already_processed_count: 0,
    queued_count: 2,
    items: selectedIds.map((id) => item(id, {
      status: "queued", workflow_status: "pending", workflow_run_id: `run-${id}`
    }))
  });
  expect(within(readback).getByText("Delete shipments: Queued — not yet completed")).toBeInTheDocument();
  expect(within(readback).getByTestId("shipments-bulk-actions-result-summary"))
    .toHaveTextContent("Successful 0 · Failed 0 · Already processed 0 · Queued 2");
  for (const id of selectedIds) {
    expect(within(readback).getByTestId(`shipments-bulk-actions-result-item-${id}`))
      .toHaveAttribute("data-outcome", "queued");
  }
  const eventTypes = reporter.mock.calls.map(([event]) => event.type);
  expect(eventTypes).toContain("ui.bulk_action.result.queued");
  expect(eventTypes).not.toContain("ui.bulk_action.success");
  expect(eventTypes).not.toContain("ui.bulk_action.undo.ready");
});

test.each(["pending", "in_progress", "running", "waiting"])(
  "keeps completed and %s items in disjoint counters", (workflowStatus) => {
    const parsed = parseBatchResultReadback({
      actionKey: action.key, actionLabel: action.label, selectedIds,
      result: {
        status: "queued", count: 2, success_count: 1, queued_count: 1,
        failure_count: 0, already_processed_count: 0,
        items: [item("shp-1"), item("shp-2", {
          status: "queued", workflow_run_id: "owned-run", workflow_status: workflowStatus
        })]
      }
    });
    expect(parsed.malformedReason).toBeNull();
    expect(parsed.success).toBe(1);
    expect(parsed.queued).toBe(1);
    expect(parsed.items.map((entry) => entry.outcome)).toEqual(["success", "queued"]);
  }
);

test.each([
  { workflow_run_id: "", workflow_status: "pending" },
  { workflow_run_id: "owned-run", workflow_status: "completed" },
  { workflow_run_id: "owned-run", workflow_status: "failed" },
  { workflow_run_id: "owned-run", workflow_status: "pending", ok: false },
  { workflow_run_id: "owned-run", workflow_status: "pending", error: { code: "failed" } }
])("rejects contradictory queued evidence %#", (evidence) => {
  const parsed = parseBatchResultReadback({
    actionKey: action.key, actionLabel: action.label, selectedIds,
    result: {
      status: "queued", count: 2, success_count: 1, queued_count: 1,
      failure_count: 0, already_processed_count: 0,
      items: [item("shp-1"), item("shp-2", { status: "queued", ...evidence })]
    }
  });
  expect(parsed.malformedReason).toBe("item_outcome_contradiction");
  expect(parsed.success).toBe(0);
});

test("a failed selection plus queued work is partial, not completed or wholly failed", async () => {
  const readback = await runAction({
    status: "partial", count: 2, success_count: 0, queued_count: 1,
    failure_count: 1, already_processed_count: 0,
    items: [
      item("shp-1", { status: "queued", workflow_run_id: "owned-run", workflow_status: "waiting" }),
      item("shp-2", { status: "blocked", ok: false, error: { code: "shipment_not_visible" } })
    ]
  });
  expect(within(readback).getByText(/Some items failed; queued work is not yet completed/)).toBeInTheDocument();
  expect(within(readback).getByTestId("shipments-bulk-actions-result-item-shp-1"))
    .toHaveAttribute("data-outcome", "queued");
  expect(within(readback).getByTestId("shipments-bulk-actions-result-item-shp-2"))
    .toHaveAttribute("data-outcome", "failed");
});

test("fails closed on a partial result and never reports failed IDs as successful", async () => {
  const reporter = jest.fn();
  setUiReporter(reporter);
  const readback = await runAction({
    status: "partial",
    count: 2,
    success_count: 1,
    failure_count: 1,
    already_processed_count: 0,
    items: [
      item("shp-1"),
      item("shp-2", {
        status: "shipment_not_visible",
        ok: false,
        error: { code: "shipment_not_visible" }
      })
    ]
  });

  expect(within(readback).getByText(/Partially completed/)).toBeInTheDocument();
  const failedItem = within(readback).getByTestId("shipments-bulk-actions-result-item-shp-2");
  expect(failedItem).toHaveAttribute("data-outcome", "failed");
  expect(within(failedItem).getByText("Failed")).toBeInTheDocument();
  expect(within(failedItem).getByText("The shipment is no longer available.")).toBeInTheDocument();
  expect(within(failedItem).queryByText("shipment_not_visible")).toBeNull();
  const eventTypes = reporter.mock.calls.map(([event]) => event.type);
  expect(eventTypes).toContain("ui.bulk_action.result.failed");
  expect(eventTypes).not.toContain("ui.bulk_action.success");
});

test("shows every failed item for a fully failed batch", async () => {
  const readback = await runAction({
    status: "failed",
    count: 2,
    success_count: 0,
    failure_count: 2,
    already_processed_count: 0,
    items: selectedIds.map((id) =>
      item(id, {
        status: "blocked",
        ok: false,
        error: { code: "blocked" }
      })
    )
  });

  expect(within(readback).getByText(/Delete shipments: Failed/)).toBeInTheDocument();
  expect(within(readback).queryByText("blocked")).toBeNull();
  expect(within(readback).getAllByText("This record could not be processed.")).toHaveLength(2);
  selectedIds.forEach((id) => {
    expect(
      within(readback).getByTestId(`shipments-bulk-actions-result-item-${id}`)
    ).toHaveAttribute("data-outcome", "failed");
  });
});

test("accepts the canonical idempotent already-processed payload", async () => {
  const readback = await runAction({
    status: "already_processed",
    count: 2,
    success_count: 0,
    failure_count: 0,
    already_processed_count: 2,
    items: selectedIds.map((id) =>
      item(id, {
        status: "already_processed",
        already_processed: true
      })
    )
  });

  expect(within(readback).getByText("Delete shipments: Already processed")).toBeInTheDocument();
  expect(within(readback).getByTestId("shipments-bulk-actions-result-summary")).toHaveTextContent(
    "Successful 0 · Failed 0 · Already processed 2"
  );
  selectedIds.forEach((id) => {
    expect(
      within(readback).getByTestId(`shipments-bulk-actions-result-item-${id}`)
    ).toHaveAttribute("data-outcome", "already_processed");
  });
});

test("rejects malformed aggregate evidence without showing success and still refreshes", async () => {
  const reporter = jest.fn();
  setUiReporter(reporter);
  const invalidateSpy = jest.spyOn(QueryClient.prototype, "invalidateQueries");
  const readback = await runAction({
    status: "cancelled",
    count: 2,
    success_count: 2,
    failure_count: 0,
    already_processed_count: 0,
    items: [item("shp-1")]
  });

  expect(within(readback).getByText(/Result could not be verified/)).toBeInTheDocument();
  expect(within(readback).getByRole("alert")).toHaveTextContent("No success was reported");
  await waitFor(() =>
    expect(invalidateSpy).toHaveBeenCalledWith({
      queryKey: ["resource", "shipments"],
      refetchType: "active"
    })
  );
  const eventTypes = reporter.mock.calls.map(([event]) => event.type);
  expect(eventTypes).toContain("ui.bulk_action.result.malformed");
  expect(eventTypes).not.toContain("ui.bulk_action.success");
});

test("batch evidence parsing is enabled only by the typed result contract", () => {
  expect(
    requiresBatchResultEvidence({
      type: "rpc",
      result_contract: "batch_items_v1"
    })
  ).toBe(true);
  expect(requiresBatchResultEvidence({ type: "rpc" })).toBe(false);
  expect(requiresBatchResultEvidence(null)).toBe(false);
});

test("completed RPC mutations refresh their resource without opting into batch parsing", async () => {
  const invalidateSpy = jest.spyOn(QueryClient.prototype, "invalidateQueries");
  const genericAction: BulkActionDefinition = {
    ...action,
    key: "shipments.generic",
    label: "Update shipments",
    execution: {
      type: "rpc",
      rpc: "ui_execute_generic_v1"
    }
  };
  rpcMock.mockResolvedValueOnce({ ok: true });
  const user = userEvent.setup();
  renderWithIntl(
    <BulkActions actions={[genericAction]} selectedIds={selectedIds} testIdPrefix="shipments" />
  );

  await user.click(screen.getByRole("button", { name: genericAction.label }));
  await user.click(await screen.findByRole("button", { name: "Confirm" }));

  await waitFor(() =>
    expect(invalidateSpy).toHaveBeenCalledWith({
      queryKey: ["resource", "shipments"],
      refetchType: "active"
    })
  );
  expect(screen.queryByTestId("shipments-bulk-actions-result")).toBeNull();
});

test.each([
  {
    name: "success carrying an error",
    status: "cancelled",
    summary: { success_count: 2, failure_count: 0, already_processed_count: 0 },
    conflictingItem: item("shp-2", {
      error: { code: "server_secret_detail" }
    })
  },
  {
    name: "already-processed record carrying an error",
    status: "already_processed",
    summary: { success_count: 1, failure_count: 0, already_processed_count: 1 },
    conflictingItem: item("shp-2", {
      status: "already_processed",
      already_processed: true,
      error: { code: "server_secret_detail" }
    })
  },
  {
    name: "failed record without an error code",
    status: "partial",
    summary: { success_count: 1, failure_count: 1, already_processed_count: 0 },
    conflictingItem: item("shp-2", { status: "failed", ok: false })
  },
  {
    name: "ok record carrying a failed status",
    status: "cancelled",
    summary: { success_count: 2, failure_count: 0, already_processed_count: 0 },
    conflictingItem: item("shp-2", { status: "failed", ok: true })
  },
  {
    name: "ok record carrying an already-processed status without its discriminator",
    status: "cancelled",
    summary: { success_count: 2, failure_count: 0, already_processed_count: 0 },
    conflictingItem: item("shp-2", {
      status: "already_processed",
      ok: true,
      already_processed: false
    })
  },
  {
    name: "ok record carrying a blocked status",
    status: "cancelled",
    summary: { success_count: 2, failure_count: 0, already_processed_count: 0 },
    conflictingItem: item("shp-2", { status: "blocked", ok: true })
  },
  {
    name: "cancelled record carrying an unfinished workflow",
    status: "cancelled",
    summary: { success_count: 2, failure_count: 0, already_processed_count: 0 },
    conflictingItem: item("shp-2", { workflow_status: "pending" })
  }
])("rejects the item outcome contradiction: $name", ({ status, summary, conflictingItem }) => {
  const parsed = parseBatchResultReadback({
    actionKey: action.key,
    actionLabel: action.label,
    selectedIds,
    result: {
      status,
      count: 2,
      ...summary,
      items: [item("shp-1"), conflictingItem]
    }
  });

  expect(parsed.malformedReason).toBe("item_outcome_contradiction");
  expect(parsed.success).toBe(0);
});

test("rejects aggregate statuses outside the terminal result contract", () => {
  const parsed = parseBatchResultReadback({
    actionKey: action.key,
    actionLabel: action.label,
    selectedIds,
    result: {
      status: "processing",
      count: 2,
      success_count: 2,
      failure_count: 0,
      already_processed_count: 0,
      items: [item("shp-1"), item("shp-2")]
    }
  });

  expect(parsed.malformedReason).toBe("missing_summary_evidence");
  expect(parsed.success).toBe(0);
});

test("rejects per-item evidence that contradicts successful aggregate counts", async () => {
  const readback = await runAction({
    status: "cancelled",
    count: 2,
    success_count: 2,
    failure_count: 0,
    already_processed_count: 0,
    items: [
      item("shp-1"),
      item("shp-2", {
        status: "blocked",
        ok: false,
        error: { code: "blocked" }
      })
    ]
  });

  expect(within(readback).getByText(/Result could not be verified/)).toBeInTheDocument();
  expect(within(readback).getByTestId("shipments-bulk-actions-result-item-shp-2")).toHaveAttribute(
    "data-outcome",
    "failed"
  );
});
