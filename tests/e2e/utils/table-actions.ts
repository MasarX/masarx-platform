import { expect, type Locator, type Page } from "@playwright/test";

async function selectFirstOption(select: ReturnType<Page["locator"]>) {
  const values = await select.locator("option").evaluateAll((options) =>
    options.map((option) => option.getAttribute("value") || "")
  );
  const nextValue = values.find((value) => value.trim().length > 0);
  if (nextValue) {
    await select.selectOption(nextValue);
    return true;
  }
  return false;
}

export async function applyAndClearFirstFilter(params: {
  page: Page;
  testIdPrefix: string;
  filterKey?: string | null;
  filterValue?: string | null;
}) {
  const { page, testIdPrefix, filterKey, filterValue } = params;
  const builder = page.locator(
    `[data-testid="${testIdPrefix}-filter-builder"]`
  );
  if ((await builder.count()) === 0) return false;

  const fieldSelect = builder.locator(
    `[data-testid="${testIdPrefix}-filter-field"]`
  );
  if ((await fieldSelect.count()) > 0) {
    if (filterKey) {
      await fieldSelect.first().selectOption(filterKey);
    } else {
      const currentValue = await fieldSelect.first().inputValue();
      if (!currentValue) {
        await selectFirstOption(fieldSelect.first());
      }
    }
  }

  const valueInput = builder.locator(
    `[data-testid="${testIdPrefix}-filter-value"]`
  );
  if ((await valueInput.count()) > 0) {
    if (!filterValue) return false;
    await valueInput.first().fill(filterValue);
  } else {
    const combobox = builder.locator('[role="combobox"]').first();
    if ((await combobox.count()) === 0 || !filterValue) return false;
    await combobox.click();
    const searchbox = combobox.getByRole("searchbox");
    await searchbox.fill(filterValue);
    const option = combobox.locator("..").getByRole("option", {
      name: filterValue,
      exact: true,
    });
    await expect(option).toBeVisible();
    await option.click();
    if (await searchbox.isVisible()) await searchbox.press("Escape");
  }

  const applyButton = builder.locator(
    `[data-testid="${testIdPrefix}-filter-apply"]`
  );
  if ((await applyButton.count()) === 0) return false;
  if (await applyButton.first().isDisabled()) return false;
  await applyButton.first().click();
  await expect
    .poll(() => page.url())
    .toContain("filters=");

  const clearButton = builder.locator(
    `[data-testid="${testIdPrefix}-filter-clear"]`
  );
  if ((await clearButton.count()) > 0) {
    await clearButton.first().click();
    await expect
      .poll(() => page.url())
      .not.toContain("filters=");
  }
  return true;
}

export async function applyAndClearFirstSort(params: {
  page: Page;
  testIdPrefix: string;
}) {
  const { page, testIdPrefix } = params;
  const sortSelect = page.locator(
    `[data-testid="${testIdPrefix}-sort-add"]`
  );
  if ((await sortSelect.count()) === 0) return false;
  const selected = await selectFirstOption(sortSelect.first());
  if (!selected) return false;
  const sortPill = page.locator(
    `[data-testid="${testIdPrefix}-view-pill-sort"]`
  );
  if ((await sortPill.count()) > 0) {
    await expect(sortPill).toBeVisible();
  }
  const clearButton = page.locator(
    `[data-testid="${testIdPrefix}-sort-clear"]`
  );
  if ((await clearButton.count()) > 0 && !(await clearButton.first().isDisabled())) {
    await clearButton.first().click();
    await expect(sortPill).toHaveCount(0);
  }
  return true;
}

export async function applyAndClearFirstGroup(params: {
  page: Page;
  testIdPrefix: string;
}) {
  const { page, testIdPrefix } = params;
  const groupSelect = page.locator(
    `[data-testid="${testIdPrefix}-group-add"]`
  );
  if ((await groupSelect.count()) === 0) return false;
  const selected = await selectFirstOption(groupSelect.first());
  if (!selected) return false;
  const groupPill = page.locator(
    `[data-testid="${testIdPrefix}-view-pill-group"]`
  );
  if ((await groupPill.count()) > 0) {
    await expect(groupPill).toBeVisible();
  }
  const collapseAll = page.locator(
    `[data-testid="${testIdPrefix}-group-collapse-all"]`
  );
  if ((await collapseAll.count()) > 0 && !(await collapseAll.first().isDisabled())) {
    await collapseAll.first().click();
  }
  const expandAll = page.locator(
    `[data-testid="${testIdPrefix}-group-expand-all"]`
  );
  if ((await expandAll.count()) > 0 && !(await expandAll.first().isDisabled())) {
    await expandAll.first().click();
  }
  const clearButton = page.locator(
    `[data-testid="${testIdPrefix}-group-clear"]`
  );
  if ((await clearButton.count()) > 0 && !(await clearButton.first().isDisabled())) {
    await clearButton.first().click();
    await expect(groupPill).toHaveCount(0);
  }
  return true;
}

export async function applyViewLifecycle(params: {
  page: Page;
  testIdPrefix: string;
}) {
  const { page, testIdPrefix } = params;
  const panel = page.locator(
    `[data-testid="${testIdPrefix}-views-panel"]`
  );
  if ((await panel.count()) === 0) return false;
  await expect(panel).toBeVisible();

  const viewSelect = page.locator(
    `[data-testid="${testIdPrefix}-view-select"]`
  );
  if ((await viewSelect.count()) > 0) {
    await expect(viewSelect.first()).toBeVisible();
  }

  const viewMenu = page.locator(
    `[data-testid="${testIdPrefix}-view-menu"]`
  );
  if ((await viewMenu.count()) > 0 && !(await viewMenu.first().isDisabled())) {
    await viewMenu.first().click();
    const renameItem = page.locator(
      `[data-testid="${testIdPrefix}-view-menu-rename"]`
    );
    if ((await renameItem.count()) > 0) {
      await renameItem.first().click();
      const saveInput = page.locator(
        `[data-testid="${testIdPrefix}-view-save-name"]`
      );
      await expect(saveInput).toBeVisible();
      const saveToggle = page.locator(
        `[data-testid="${testIdPrefix}-view-save-toggle"]`
      );
      if ((await saveToggle.count()) > 0) {
        await saveToggle.first().click();
      }
    }
  }

  if ((await viewMenu.count()) > 0 && !(await viewMenu.first().isDisabled())) {
    await viewMenu.first().click();
    const duplicateItem = page.locator(
      `[data-testid="${testIdPrefix}-view-menu-duplicate"]`
    );
    if ((await duplicateItem.count()) > 0) {
      await duplicateItem.first().click();
      const saveInput = page.locator(
        `[data-testid="${testIdPrefix}-view-save-name"]`
      );
      await expect(saveInput).toBeVisible();
      await expect(saveInput).not.toHaveValue("");
      const saveToggle = page.locator(
        `[data-testid="${testIdPrefix}-view-save-toggle"]`
      );
      if ((await saveToggle.count()) > 0) {
        await saveToggle.first().click();
      }
    }
  }

  if ((await viewMenu.count()) > 0 && !(await viewMenu.first().isDisabled())) {
    await viewMenu.first().click();
    const setDefaultItem = page.locator(
      `[data-testid="${testIdPrefix}-view-menu-set-default"]`
    );
    if ((await setDefaultItem.count()) > 0) {
      await expect(setDefaultItem.first()).toBeVisible();
    }
  }

  if ((await viewMenu.count()) > 0 && !(await viewMenu.first().isDisabled())) {
    await viewMenu.first().click();
    const deleteItem = page.locator(
      `[data-testid="${testIdPrefix}-view-menu-delete"]`
    );
    if ((await deleteItem.count()) > 0) {
      await deleteItem.first().click();
      const deleteDialog = page.locator(
        `[data-testid="${testIdPrefix}-view-delete-confirm-dialog"]`
      );
      if ((await deleteDialog.count()) > 0) {
        await expect(deleteDialog).toBeVisible();
        await page
          .locator(
            `[data-testid="${testIdPrefix}-view-delete-confirm-cancel"]`
          )
          .click();
        await expect(deleteDialog).toHaveCount(0);
      }
    }
  }

  const viewReset = page.locator(
    `[data-testid="${testIdPrefix}-view-reset"]`
  );
  if ((await viewReset.count()) > 0 && !(await viewReset.first().isDisabled())) {
    await viewReset.first().click();
  }

  return true;
}

export async function verifyExportPanel(params: {
  page: Page;
  testIdPrefix: string;
}) {
  const { page, testIdPrefix } = params;
  const panel = page.locator(
    `[data-testid="${testIdPrefix}-export-panel"]`
  );
  if ((await panel.count()) === 0) return false;
  await expect(panel).toBeVisible();
  const excelButton = page.locator(
    `[data-testid="${testIdPrefix}-export-excel"]`
  );
  const csvButton = page.locator(
    `[data-testid="${testIdPrefix}-export-csv"]`
  );
  if ((await excelButton.count()) > 0) {
    await expect(excelButton).toBeVisible();
  }
  if ((await csvButton.count()) > 0) {
    await expect(csvButton).toBeVisible();
  }
  return true;
}

export async function selectFirstTableRow(page: Page) {
  const rowCheckboxes = page.locator("tbody input[type='checkbox']");
  if ((await rowCheckboxes.count()) === 0) return false;
  await rowCheckboxes.first().check();
  return true;
}

export async function ensureBulkActionVisible(params: {
  page: Page;
  actionKey: string;
  testIdPrefix: string;
}) {
  const { page, actionKey, testIdPrefix } = params;
  const bulkActionsTestIdPrefix = resolveBulkActionsTestIdPrefix(testIdPrefix);
  let container = page.locator(`[data-testid="${bulkActionsTestIdPrefix}"]`);
  if ((await container.count()) === 0) {
    const hasSelection = await selectFirstTableRow(page);
    if (hasSelection) {
      container = page.locator(`[data-testid="${bulkActionsTestIdPrefix}"]`);
      await expect(container).toBeVisible();
    }
  }
  let action = container.locator(`[data-action-key="${actionKey}"]`);
  if ((await action.count()) === 0) {
    action = page.getByTestId(`${bulkActionsTestIdPrefix}-menu-action-${actionKey}`);
    if (await action.isVisible()) return action;
    const menuTrigger = container.getByTestId(`${bulkActionsTestIdPrefix}-menu`);
    if ((await menuTrigger.count()) === 0) return null;
    if ((await menuTrigger.getAttribute("data-state")) !== "open") {
      await menuTrigger.click();
    }
    await expect(menuTrigger).toHaveAttribute("data-state", "open");
    await expect(menuTrigger).toHaveAttribute("aria-controls", /.+/);
    const menuId = await menuTrigger.getAttribute("aria-controls");
    await expect(page.locator(`[id="${menuId}"][role="menu"]`)).toBeVisible();
  } else {
    const menuTrigger = container.getByTestId(`${bulkActionsTestIdPrefix}-menu`);
    if ((await menuTrigger.count()) > 0 &&
        (await menuTrigger.getAttribute("data-state")) === "open") {
      await page.keyboard.press("Escape");
      await expect(menuTrigger).toHaveAttribute("data-state", "closed");
    }
  }
  if ((await action.count()) === 0) return null;
  await expect(action.first()).toBeVisible();
  return action.first();
}

export const resolveBulkActionsTestIdPrefix = (tableTestIdPrefix: string) => {
  const trimmed = tableTestIdPrefix?.trim();
  if (!trimmed) return "bulk-actions";
  return `${trimmed}-bulk-actions`;
};

export async function openFirstSingleLineInlineEditor(
  page: Page,
): Promise<{ cell: Locator; control: Locator } | null> {
  const cells = page.locator(
    '#main-content tbody td[data-editable="true"]:not(:has(a)):visible',
  );
  const count = Math.min(await cells.count(), 12);
  for (let index = 0; index < count; index += 1) {
    const cell = cells.nth(index);
    await cell.dblclick();
    const control = cell.locator(
      'input:not([type="checkbox"]):not([type="hidden"]):not([readonly]), select',
    ).first();
    try {
      await expect(control).toBeVisible({ timeout: 3_000 });
      return { cell, control };
    } catch {
      await page.keyboard.press("Escape");
    }
  }
  return null;
}

export async function attemptInlineEdit(page: Page) {
  const editor = await openFirstSingleLineInlineEditor(page);
  if (!editor) return false;
  await page.keyboard.press("Escape");
  await expect(editor.control).toHaveCount(0);
  return true;
}

export async function applyAndClearSearch(params: {
  page: Page;
  testIdPrefix: string;
  value?: string;
}) {
  const { page, testIdPrefix, value } = params;
  const searchInput = page.locator(
    `[data-testid="${testIdPrefix}-table-search"]`
  );
  if ((await searchInput.count()) === 0) return false;
  await searchInput.first().fill(value ?? `e2e-${Date.now()}`);
  const clearButton = page.locator(
    `[data-testid="${testIdPrefix}-table-search-clear"]`
  );
  if ((await clearButton.count()) === 0) return false;
  await clearButton.first().click();
  await expect(searchInput.first()).toHaveValue("");
  return true;
}

export async function exercisePagination(params: {
  page: Page;
  testIdPrefix: string;
}) {
  const { page, testIdPrefix } = params;
  const nextButton = page.locator(
    `[data-testid="${testIdPrefix}-table-page-next"]`
  );
  if ((await nextButton.count()) === 0) return false;
  if (await nextButton.first().isDisabled()) return false;
  await nextButton.first().click();
  const prevButton = page.locator(
    `[data-testid="${testIdPrefix}-table-page-prev"]`
  );
  if ((await prevButton.count()) > 0 && !(await prevButton.first().isDisabled())) {
    await prevButton.first().click();
  }
  return true;
}
