import { expect, type Locator, type Page, type Response } from "@playwright/test";

export const SHIPMENTS_PRINT_ACTION_KEY = "shipments.print_labels";

export type PrintActionResult = {
  workflowRunId: string;
  requestPayload: Record<string, unknown> | null;
  selectionIds: string[];
  fallbackObserved: boolean;
  progressObserved: boolean;
  downloadObserved: boolean;
  evidencePage: Page;
};

export type PrintProgressWidgetSurfaceState =
  | "expanded-active"
  | "expanded-terminal"
  | "minimized"
  | "missing";

function normalizeSelectionIds(payload: Record<string, unknown> | null) {
  if (!payload) return [] as string[];
  const rawIds = payload.p_selection_ids;
  if (Array.isArray(rawIds)) {
    return rawIds
      .map((value) => (typeof value === "string" ? value.trim() : ""))
      .filter(Boolean);
  }
  if (typeof rawIds === "string") {
    return rawIds
      .split(",")
      .map((value) => value.trim())
      .filter(Boolean);
  }
  const rawId = payload.p_selection_id;
  if (typeof rawId === "string" && rawId.trim()) return [rawId.trim()];
  return [] as string[];
}

function parseSelectionCount(payload: Record<string, unknown> | null, fallback: number) {
  if (!payload) return fallback;
  const raw = payload.p_selection_count;
  const parsed =
    typeof raw === "number"
      ? raw
      : typeof raw === "string"
        ? Number.parseInt(raw, 10)
        : Number.NaN;
  if (!Number.isFinite(parsed)) return fallback;
  return Math.max(0, Math.floor(parsed));
}

function parseRpcRequestPayload(response: Response) {
  const request = response.request();
  const parseRecord = (value: unknown) =>
    value && typeof value === "object" && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : null;
  try {
    const parsed = request.postDataJSON();
    const asRecord = parseRecord(parsed);
    if (asRecord) return asRecord;
  } catch {
    // Fallback to raw postData parse below.
  }
  try {
    const raw = request.postData() ?? "";
    if (!raw.trim()) return null;
    const parsed = JSON.parse(raw);
    return parseRecord(parsed);
  } catch {
    return null;
  }
}

export function isRetriablePrintProgressControlError(error: unknown) {
  const message = error instanceof Error ? error.message : String(error ?? "");
  return /detached from the DOM|element is not attached|Target page, context or browser has been closed/i.test(
    message
  );
}

export async function waitForPrintProgressWidgetSurfaceState(params: {
  page: Pick<Page, "waitForTimeout">;
  progressWidget: Pick<Locator, "isVisible" | "getByRole">;
  minimizedWidget: Pick<Locator, "isVisible">;
  timeoutMs?: number;
  pollIntervalMs?: number;
}): Promise<PrintProgressWidgetSurfaceState> {
  const {
    page,
    progressWidget,
    minimizedWidget,
    timeoutMs = 10_000,
    pollIntervalMs = 250,
  } = params;
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    if (await minimizedWidget.isVisible().catch(() => false)) {
      return "minimized";
    }
    if (await progressWidget.isVisible().catch(() => false)) {
      if (
        await progressWidget
          .getByRole("button", { name: "Hide" })
          .isVisible()
          .catch(() => false)
      ) {
        return "expanded-active";
      }
      if (
        await progressWidget
          .getByRole("button", { name: "Dismiss" })
          .isVisible()
          .catch(() => false)
      ) {
        return "expanded-terminal";
      }
    }
    await page.waitForTimeout(pollIntervalMs);
  }

  if (await minimizedWidget.isVisible().catch(() => false)) {
    return "minimized";
  }
  if (await progressWidget.isVisible().catch(() => false)) {
    return "expanded-terminal";
  }
  return "missing";
}

export async function clickPrintProgressControl(params: {
  page: Pick<Page, "waitForTimeout">;
  control: Pick<Locator, "click">;
  timeoutMs?: number;
  pollIntervalMs?: number;
  successProbe?: () => Promise<boolean>;
}) {
  const {
    page,
    control,
    timeoutMs = 20_000,
    pollIntervalMs = 250,
    successProbe,
  } = params;
  const deadline = Date.now() + timeoutMs;
  let lastError: unknown = null;

  while (Date.now() < deadline) {
    try {
      await control.click({ timeout: Math.max(1_000, Math.min(5_000, deadline - Date.now())) });
      return;
    } catch (error) {
      lastError = error;
      const recovered = successProbe ? await successProbe().catch(() => false) : false;
      if (recovered) {
        return;
      }
      if (!isRetriablePrintProgressControlError(error)) {
        throw error;
      }
      await page.waitForTimeout(pollIntervalMs);
    }
  }

  if (successProbe && (await successProbe().catch(() => false))) {
    return;
  }
  throw lastError instanceof Error
    ? lastError
    : new Error("Timed out while interacting with the print progress control.");
}

export async function runPrintLabelsAction(params: {
  page: Page;
  actionButton: Locator;
  bulkActionsTestIdPrefix: string;
  expectedSelectionCount: number;
  expectedSelectionId?: string | null;
  contextLabel: string;
  actionKey?: string;
}) {
  const {
    page,
    actionButton,
    bulkActionsTestIdPrefix,
    expectedSelectionCount,
    expectedSelectionId,
    contextLabel,
    actionKey = SHIPMENTS_PRINT_ACTION_KEY,
  } = params;

  await actionButton.click({ timeout: 20_000 });
  const confirmDialog = page.locator(
    `[data-testid="${bulkActionsTestIdPrefix}-confirm-dialog"]`
  );
  await expect(confirmDialog).toBeVisible();

  const eventTimeoutMs = 25_000;
  const rpcResponsePromise = page.waitForResponse(
    async (response) => {
      if (!response.url().includes("/rpc/ui_execute_command_v1")) return false;
      if (response.request().method() !== "POST") return false;
      const postData = response.request().postData() ?? "";
      return postData.includes(actionKey);
    },
    { timeout: 60_000 }
  );
  const maybeNewPagePromise = page.context()
    .waitForEvent("page", { timeout: eventTimeoutMs })
    .catch(() => null);
  const downloadObservedPromise = page
    .waitForEvent("download", { timeout: eventTimeoutMs })
    .then(() => true)
    .catch(() => false);

  await page
    .locator(`[data-testid="${bulkActionsTestIdPrefix}-confirm-submit"]`)
    .click({ timeout: 20_000 });

  const rpcResponse = await rpcResponsePromise;
  const requestPayload = parseRpcRequestPayload(rpcResponse);
  if (!requestPayload || requestPayload.p_action_key !== actionKey) {
    throw new Error(`Invalid print command request payload for ${contextLabel}.`);
  }
  const selectionIds = normalizeSelectionIds(requestPayload);
  const selectionCount = parseSelectionCount(requestPayload, selectionIds.length);
  expect(selectionCount).toBe(expectedSelectionCount);
  if (selectionIds.length < expectedSelectionCount) {
    throw new Error(`Missing selection IDs in print request payload for ${contextLabel}.`);
  }
  if (expectedSelectionId && !selectionIds.includes(expectedSelectionId)) {
    throw new Error(
      `Expected selection id ${expectedSelectionId} missing from print payload for ${contextLabel}.`
    );
  }

  const rpcPayload = await rpcResponse.json().catch(() => null);
  const workflowRunId =
    rpcPayload && typeof rpcPayload.workflow_run_id === "string"
      ? rpcPayload.workflow_run_id.trim()
      : "";
  if (!workflowRunId) {
    throw new Error(`Missing workflow_run_id in print command response for ${contextLabel}.`);
  }

  const progressWidget = page.locator(
    `[data-testid="${bulkActionsTestIdPrefix}-print-progress"]`
  );
  await expect(progressWidget).toBeVisible({ timeout: 60_000 });
  await expect(progressWidget).toContainText(
    expectedSelectionCount === 1
      ? "Printing label"
      : `Printing ${expectedSelectionCount} labels`
  );
  await expect(progressWidget).not.toContainText("Activity reference:");

  const supportDetailsButton = progressWidget.getByRole("button", {
    name: "Support details",
  });
  await expect(supportDetailsButton).toBeVisible();
  await supportDetailsButton.click({ timeout: 20_000 });
  await expect(progressWidget).toContainText(`Activity reference: ${workflowRunId}`);

  const hideButton = progressWidget.getByRole("button", { name: "Hide" });
  const minimizedWidget = page.locator(
    `[data-testid="${bulkActionsTestIdPrefix}-print-progress-minimized"]`
  );
  let progressSurfaceLost = false;
  const initialSurfaceState = await waitForPrintProgressWidgetSurfaceState({
    page,
    progressWidget,
    minimizedWidget,
    timeoutMs: 20_000,
  });

  if (initialSurfaceState === "expanded-active") {
    await clickPrintProgressControl({
      page,
      control: hideButton,
      successProbe: async () =>
        (await minimizedWidget.isVisible().catch(() => false)) ||
        !(await progressWidget.isVisible().catch(() => false)) ||
        (await progressWidget
          .getByRole("button", { name: "Dismiss" })
          .isVisible()
          .catch(() => false)),
    });
  }

  const postHideSurfaceState = await waitForPrintProgressWidgetSurfaceState({
    page,
    progressWidget,
    minimizedWidget,
    timeoutMs: 20_000,
  });
  let fallbackObserved = false;
  let progressObserved = false;
  let downloadObserved = false;
  let evidencePage = page;
  if (postHideSurfaceState === "minimized") {
    progressObserved = true;
  } else if (postHideSurfaceState === "missing") {
    progressSurfaceLost = true;
  }
  const firstEvent = await Promise.race([
    maybeNewPagePromise.then((nextPage) =>
      nextPage ? ({ kind: "page" as const, page: nextPage }) : null
    ),
    downloadObservedPromise.then((observed) =>
      observed ? ({ kind: "download" as const }) : null
    ),
    page.waitForTimeout(eventTimeoutMs).then(() => null),
  ]);
  const maybeNewPage = firstEvent?.kind === "page" ? firstEvent.page : null;
  if (firstEvent?.kind === "download") {
    downloadObserved = true;
  }
  if (await progressWidget.isVisible().catch(() => false)) {
    progressObserved = true;
  }
  if (maybeNewPage) {
    await maybeNewPage
      .waitForLoadState("domcontentloaded", { timeout: 60_000 })
      .catch(() => null);
    const targetUrl = maybeNewPage.url();
    if (targetUrl.includes(`/workflows/runs/${workflowRunId}`) && targetUrl.includes("#outputs")) {
      throw new Error(`Unexpected print fallback redirect observed for ${contextLabel}.`);
    }
    if (/^(https?:\/\/|about:blank)/i.test(targetUrl)) {
      downloadObserved = true;
      evidencePage = page;
      await maybeNewPage.close().catch(() => null);
    }
  }
  await page.waitForTimeout(250);
  expect(page.url()).not.toContain(`/workflows/runs/${workflowRunId}#outputs`);
  if (progressSurfaceLost && !(progressObserved || downloadObserved)) {
    throw new Error(`Print progress widget disappeared before completion evidence for ${contextLabel}.`);
  }
  expect(progressObserved || downloadObserved).toBeTruthy();

  return {
    workflowRunId,
    requestPayload,
    selectionIds,
    fallbackObserved,
    progressObserved,
    downloadObserved,
    evidencePage,
  } satisfies PrintActionResult;
}
