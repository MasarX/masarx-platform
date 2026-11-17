import { expect, type Page } from "@playwright/test";
import { assertE2EMutationsAllowed } from "./mutations";
import { appendMutationManifestEntry } from "./mutation-manifest";

function resolveTemplateIdFromHref(href: string | null) {
  if (!href) return null;
  try {
    const parsed = new URL(href, "http://localhost");
    const id = parsed.searchParams.get("id");
    if (id) return id;

    const match = parsed.pathname.match(/\/workflows\/templates\/([^/]+)\/?$/);
    if (!match) return null;
    const value = decodeURIComponent(match[1] ?? "").trim();
    if (!value || value.toLowerCase() === "new") return null;
    return value;
  } catch {
    return null;
  }
}

function resolveTemplateIdFromUrl(rawUrl: string) {
  try {
    const parsed = new URL(rawUrl);
    const id = parsed.searchParams.get("id");
    if (id) return id;

    const match = parsed.pathname.match(/\/workflows\/templates\/([^/]+)\/?$/);
    if (!match) return null;
    const value = decodeURIComponent(match[1] ?? "").trim();
    if (!value || value.toLowerCase() === "new") return null;
    return value;
  } catch {
    return null;
  }
}

function buildWorkflowTemplateName(prefix: string) {
  const safePrefix = prefix.trim() || "e2e_workflow_template";
  return `${safePrefix}_${Date.now()}_${Math.floor(Math.random() * 10_000)}`;
}

async function collectWorkflowTemplateIdsFromList(page: Page, limit: number) {
  const links = page.locator(
    'table tbody tr a[href*="id="], table tbody tr a[href*="/workflows/templates/"]'
  );
  const total = await links.count();
  const max = Math.min(total, Math.max(0, limit));
  const ids: string[] = [];
  for (let index = 0; index < max; index += 1) {
    const href = await links.nth(index).getAttribute("href");
    const id = resolveTemplateIdFromHref(href);
    if (!id) continue;
    if (ids.includes(id)) continue;
    ids.push(id);
  }
  return ids;
}

async function openWorkflowTemplateStudio(params: {
  page: Page;
  basePath: string;
  templateId: string;
  testIdPrefix: string;
}) {
  const { page, basePath, templateId, testIdPrefix } = params;
  await page.goto(`${basePath}/workflows/templates/${encodeURIComponent(templateId)}`, {
    waitUntil: "domcontentloaded",
    timeout: 60_000,
  });

  const blockedStates = page.locator(
    `[data-testid="${testIdPrefix}-not-found"], [data-testid="${testIdPrefix}-resource-blocked"], [data-testid="${testIdPrefix}-workflow-template-studio-error"]`
  );
  await expect(
    page.locator(
      `[data-testid="${testIdPrefix}-workflow-template-studio-ready"], [data-testid="${testIdPrefix}-workflow-template-studio-error"], [data-testid="${testIdPrefix}-auth-required"], [data-testid="${testIdPrefix}-not-found"], [data-testid="${testIdPrefix}-resource-blocked"]`
    )
  ).toBeVisible({ timeout: 60_000 });
  if (await blockedStates.first().isVisible()) {
    throw new Error(
      `Resource not available for workflow template studio in ${testIdPrefix}; state=${(await blockedStates.first().getAttribute("data-testid")) ?? "unknown"}.`
    );
  }

  const ready = page.locator(
    `[data-testid="${testIdPrefix}-workflow-template-studio-ready"]`
  );
  return ready.isVisible();
}

async function focusWorkflowTemplateFlowView(params: { page: Page; testIdPrefix: string }) {
  const { page, testIdPrefix } = params;
  const studioTab = page.getByRole("tab", { name: /Studio/i });
  if (await studioTab.isVisible()) {
    await studioTab.click({ timeout: 20_000 });
    await expect(
      page.locator(
        `[data-testid="${testIdPrefix}-workflow-template-studio-ready"], [data-testid="${testIdPrefix}-workflow-template-studio-error"]`
      )
    ).toBeVisible({ timeout: 20_000 });
  }

  const flowTab = page.locator(
    `[data-testid="${testIdPrefix}-workflow-template-studio-steps-tab-flow"]`
  );
  if (await flowTab.isVisible()) {
    await flowTab.click({ timeout: 20_000 });
  }

  const paletteSearch = page.locator(
    `[data-testid="${testIdPrefix}-workflow-template-studio-steps-flow-palette-search"]`
  );
  try {
    await paletteSearch.waitFor({ state: "visible", timeout: 20_000 });
    return true;
  } catch {
    return false;
  }
}

async function hasWorkflowTemplateDisconnectControl(params: {
  page: Page;
  testIdPrefix: string;
}) {
  const { page, testIdPrefix } = params;
  const disconnectButton = page
    .locator(
      `[data-testid^="${testIdPrefix}-workflow-template-studio-steps-flow-step-clear-next-"]`
    )
    .first();
  if (!(await disconnectButton.count())) return false;
  return disconnectButton.isVisible();
}

export async function openWorkflowTemplateStudioWithDisconnect(params: {
  page: Page;
  basePath: string;
  testIdPrefix: string;
  maxCandidates?: number;
}) {
  const { page, basePath, testIdPrefix, maxCandidates } = params;
  const templatesUrl = `${basePath}/workflows/templates`;
  await page.goto(templatesUrl, { waitUntil: "domcontentloaded", timeout: 60_000 });

  await expect(
    page.locator(
      `[data-testid="${testIdPrefix}-workflow-templates-ready"], [data-testid="${testIdPrefix}-workflow-templates-error"], [data-testid="${testIdPrefix}-auth-required"]`
    )
  ).toBeVisible({ timeout: 60_000 });

  const ids = await collectWorkflowTemplateIdsFromList(
    page,
    Math.max(3, Math.min(maxCandidates ?? 20, 50))
  );
  if (ids.length === 0) {
    return { templateId: null, foundDisconnect: false };
  }

  let fallbackId: string | null = null;
  for (const id of ids) {
    fallbackId ??= id;
    const ready = await openWorkflowTemplateStudio({
      page,
      basePath,
      templateId: id,
      testIdPrefix,
    });
    if (!ready) continue;
    const flowReady = await focusWorkflowTemplateFlowView({ page, testIdPrefix });
    if (!flowReady) continue;
    const found = await hasWorkflowTemplateDisconnectControl({ page, testIdPrefix });
    if (found) {
      return { templateId: id, foundDisconnect: true };
    }
  }

  if (fallbackId) {
    await openWorkflowTemplateStudio({
      page,
      basePath,
      templateId: fallbackId,
      testIdPrefix,
    });
  }

  return { templateId: fallbackId, foundDisconnect: false };
}

export async function createWorkflowTemplateDraftViaUi(params: {
  page: Page;
  basePath: string;
  testIdPrefix: string;
  namePrefix?: string;
}) {
  const { page, basePath, testIdPrefix, namePrefix = "e2e_smoke_workflow" } = params;
  assertE2EMutationsAllowed({
    label: `${testIdPrefix}:workflow-template-draft`,
    details: "createWorkflowTemplateDraftViaUi() creates a workflow template draft via UI.",
  });
  const createTestIdPrefix = `${testIdPrefix}-workflow-template-create`;
  const studioTestIdPrefix = `${testIdPrefix}-workflow-template-studio`;

  await page.goto(`${basePath}/workflows/templates/new`, {
    waitUntil: "domcontentloaded",
    timeout: 60_000,
  });

  const nameInput = page
    .locator(`[data-testid="${createTestIdPrefix}-name"]:visible`)
    .first();
  await expect(nameInput).toBeVisible({ timeout: 60_000 });
  if (!(await nameInput.isEditable())) {
    throw new Error(`${createTestIdPrefix}-name is not editable.`);
  }

  const workflowName = buildWorkflowTemplateName(namePrefix);
  await nameInput.fill(workflowName);

  const submit = page
    .locator(`[data-testid="${createTestIdPrefix}-submit"]:visible`)
    .first();
  await expect(submit).toBeEnabled({ timeout: 20_000 });
  await submit.click({ timeout: 20_000 });

  const blockedStates = page.locator(
    `[data-testid="${testIdPrefix}-not-found"], [data-testid="${testIdPrefix}-resource-blocked"], [data-testid="${studioTestIdPrefix}-error"]`
  );
  await expect(
    page.locator(
      `[data-testid="${studioTestIdPrefix}-ready"], [data-testid="${studioTestIdPrefix}-error"], [data-testid="${testIdPrefix}-not-found"], [data-testid="${testIdPrefix}-resource-blocked"]`
    )
  ).toBeVisible({ timeout: 120_000 });
  if (await blockedStates.first().isVisible()) {
    throw new Error(
      `Resource not available for workflow template studio in ${testIdPrefix}; state=${(await blockedStates.first().getAttribute("data-testid")) ?? "unknown"}.`
    );
  }

  await expect(
    page.locator(`[data-testid="${studioTestIdPrefix}-ready"]`)
  ).toBeVisible({ timeout: 120_000 });

  await expect(page.getByRole("heading", { name: workflowName })).toBeVisible({
    timeout: 60_000,
  });

  const templateId = resolveTemplateIdFromUrl(page.url());
  if (!templateId) {
    throw new Error(`Could not resolve workflow template id from URL: ${page.url()}`);
  }

  appendMutationManifestEntry({
    kind: "workflow_template",
    id: templateId,
    label: `${testIdPrefix}:workflow-template-draft`,
    metadata: { workflow_name: workflowName },
  });

  return { templateId, workflowName };
}

export async function ensureWorkflowTemplateFlowHasStep(params: {
  page: Page;
  testIdPrefix: string;
}) {
  const { page, testIdPrefix } = params;
  assertE2EMutationsAllowed({
    label: `${testIdPrefix}:workflow-template-flow-edit`,
    details: "ensureWorkflowTemplateFlowHasStep() edits workflow template steps via UI.",
  });
  const flowTestIdPrefix = `${testIdPrefix}-workflow-template-studio-steps-flow`;
  const stepEditorDrawer = page.locator(
    `[data-testid="${flowTestIdPrefix}-step-editor-drawer"]`
  );
  const closeStepEditorIfOpen = async () => {
    if (!(await stepEditorDrawer.isVisible())) return;
    await page.keyboard.press("Escape");
    await expect(stepEditorDrawer).toBeHidden({ timeout: 20_000 });
  };
  const flowTab = page.locator(
    `[data-testid="${testIdPrefix}-workflow-template-studio-steps-tab-flow"]`
  );
  if (await flowTab.isVisible()) {
    await flowTab.click({ timeout: 20_000 });
  }

  await expect(
    page.locator(`[data-testid="${flowTestIdPrefix}-palette-search"]`)
  ).toBeVisible({ timeout: 60_000 });

  const connectFrom = page
    .locator(`[data-testid^="${flowTestIdPrefix}-connect-from-"]`)
    .first();

  if ((await connectFrom.count()) > 0) {
    if (await connectFrom.isVisible()) {
      await closeStepEditorIfOpen();
      return true;
    }
  }

  const firstPaletteItem = page
    .locator(`[data-testid^="${flowTestIdPrefix}-palette-item-"]`)
    .first();
  await expect(firstPaletteItem).toBeVisible({ timeout: 60_000 });
  await firstPaletteItem.locator("button").first().click({ timeout: 20_000 });

  const addModal = page.locator(`[data-testid="${flowTestIdPrefix}-add-modal"]`);
  await expect(addModal).toBeVisible({ timeout: 60_000 });

  const transitionField = page.locator(
    `[data-testid="${flowTestIdPrefix}-add-transition"]`
  );
  await expect(transitionField).toBeVisible({ timeout: 20_000 });
  const transitionValue = (await transitionField.inputValue()).trim();
  if (!transitionValue) {
    const tag = await transitionField.evaluate((el) => el.tagName.toLowerCase());
    if (tag === "select") {
      const values = await transitionField
        .locator("option")
        .evaluateAll((options) =>
          options.map((option) => option.getAttribute("value") || "")
        );
      const first = values.find((value) => value.trim().length > 0);
      if (first) {
        await transitionField.selectOption(first);
      }
    } else {
      await transitionField.fill("always");
    }
  }

  const addSubmit = page.locator(`[data-testid="${flowTestIdPrefix}-add-submit"]`);
  await expect(addSubmit).toBeEnabled({ timeout: 20_000 });
  await addSubmit.click({ timeout: 20_000 });

  await expect(addModal).toBeHidden({ timeout: 30_000 });
  await expect(connectFrom).toBeVisible({ timeout: 30_000 });
  await closeStepEditorIfOpen();
  return true;
}

export async function wheelZoomWorkflowTemplateFlowCanvas(params: {
  page: Page;
  testIdPrefix: string;
  deltaY: number;
}) {
  const { page, testIdPrefix, deltaY } = params;
  const canvasScroll = page.locator(
    `[data-testid="${testIdPrefix}-workflow-template-studio-steps-flow-canvas-scroll"]`
  );
  if (!(await canvasScroll.isVisible())) return false;

  const box = await canvasScroll.boundingBox();
  const eventInit: Record<string, unknown> = { deltaY, ctrlKey: true };
  if (box) {
    eventInit.clientX = box.x + box.width / 2;
    eventInit.clientY = box.y + box.height / 2;
  }
  await canvasScroll.dispatchEvent("wheel", eventInit);
  return true;
}

export async function keyboardZoomWorkflowTemplateFlowCanvas(params: {
  page: Page;
  key: string;
  ctrlKey?: boolean;
  metaKey?: boolean;
}) {
  const { page, key, ctrlKey, metaKey } = params;
  await page.evaluate(
    ({ resolvedKey, resolvedCtrlKey, resolvedMetaKey }) => {
      const event = new KeyboardEvent("keydown", {
        key: resolvedKey,
        ctrlKey: resolvedCtrlKey,
        metaKey: resolvedMetaKey,
        bubbles: true,
        cancelable: true,
      });
      window.dispatchEvent(event);
    },
    {
      resolvedKey: key,
      resolvedCtrlKey: ctrlKey ?? true,
      resolvedMetaKey: metaKey ?? false,
    }
  );
}
