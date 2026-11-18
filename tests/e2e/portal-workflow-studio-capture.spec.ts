import { test, expect } from "@playwright/test";
import { loadDemoContext } from "./utils/demo-accounts";
import { signInWithPassword } from "./utils/auth";
import { getPortalBasePath } from "./utils/base-paths";
import {
  openWorkflowTemplateStudioWithDisconnect,
  wheelZoomWorkflowTemplateFlowCanvas,
  workflowStepEnabledLabel,
  workflowStepEditorCloseLabel,
} from "./utils/workflow-studio";
import {
  captureFullPage,
  focusWithTab,
  isCaptureEnabled,
  resolveEvidencePath,
} from "./utils/evidence";

const demoContext = loadDemoContext();
const captureEnabled = isCaptureEnabled();

test.describe("portal workflow studio screenshots", () => {
  test.skip(!captureEnabled, "Set E2E_CAPTURE_UI=1 to enable screenshot capture.");

  test("captures workflow templates and studio pages", async ({ page }) => {
    test.setTimeout(300_000);
    const evidenceGroup = "ui-workflow-studio";
    const evidencePath = (...segments: string[]) =>
      resolveEvidencePath(evidenceGroup, ...segments);
    const basePath = getPortalBasePath();
    await page.goto(basePath || "/", { waitUntil: "domcontentloaded" });

    const missingEnv = page.locator('[data-testid="portal-missing-env"]');
    if (await missingEnv.isVisible()) {
      await captureFullPage(page, evidencePath("portal-missing-env.png"));
      return;
    }

    const authGate = page.locator('[data-testid="portal-auth-required"]');
    const user = demoContext.users.find((entry) => entry.scope_type === "client");
    if (user && demoContext.password && (await authGate.isVisible())) {
      await signInWithPassword(page, user.email, demoContext.password);
    }

    await page.goto(`${basePath}/workflows/templates`, {
      waitUntil: "domcontentloaded",
      timeout: 60_000,
    });

    await expect(
      page.locator(
        '[data-testid="portal-workflow-templates-ready"], [data-testid="portal-workflow-templates-error"], [data-testid="portal-auth-required"]'
      )
    ).toBeVisible();

    await captureFullPage(page, evidencePath("portal-workflow-templates.png"));

    const templatesPropertiesButton = page.getByRole("button", {
      name: "Properties",
    });
    if (await templatesPropertiesButton.isVisible()) {
      await templatesPropertiesButton.click({ timeout: 20_000 });
      await expect(page.getByTestId("table-columns-search")).toBeVisible();
      await captureFullPage(
        page,
        evidencePath("portal-workflow-templates-properties.png")
      );
    }

    await page.goto(`${basePath}/workflows/overlaps`, {
      waitUntil: "domcontentloaded",
      timeout: 60_000,
    });

    await expect(
      page.locator("#main-content").getByTestId("portal-workflow-overlaps-ready")
    ).toBeVisible();

    await captureFullPage(page, evidencePath("portal-workflow-overlaps.png"));

    await page.goto(`${basePath}/workflows/templates/new`, {
      waitUntil: "domcontentloaded",
      timeout: 60_000,
    });

    await expect(
      page.locator(
        '[data-testid="portal-workflow-template-create-name"], [data-testid="portal-auth-required"]'
      )
    ).toBeVisible();

    await captureFullPage(page, evidencePath("portal-workflow-template-create.png"));

    await page.goto(`${basePath}/workflows/templates`, {
      waitUntil: "domcontentloaded",
      timeout: 60_000,
    });

    const templatesReady = page.locator('[data-testid="portal-workflow-templates-ready"]');
    await expect(
      page.locator(
        '[data-testid="portal-workflow-templates-ready"], [data-testid="portal-workflow-templates-error"], [data-testid="portal-auth-required"]'
      )
    ).toBeVisible();
    if (!(await templatesReady.isVisible())) return;

    await openWorkflowTemplateStudioWithDisconnect({
      page,
      basePath,
      testIdPrefix: "portal",
    });

    await expect(
      page.locator(
        '[data-testid="portal-workflow-template-studio-ready"], [data-testid="portal-workflow-template-studio-error"], [data-testid="portal-auth-required"]'
      )
    ).toBeVisible();

    await captureFullPage(page, evidencePath("portal-workflow-template-studio.png"));

    const triggersTab = page.getByRole("tab", { name: /Triggers/i });
    if (await triggersTab.isVisible()) {
      await triggersTab.click({ timeout: 20_000 });
      await expect(
        page.locator(
          '[data-testid="portal-workflow-template-studio-triggers-ready"], [data-testid="portal-workflow-template-studio-triggers-error"]'
        )
      ).toBeVisible();
      await captureFullPage(
        page,
        evidencePath("portal-workflow-template-studio-triggers.png")
      );

      const scheduleCreateButton = page.locator(
        '[data-testid="portal-workflow-template-studio-triggers-schedules-new"]'
      );
      if (await scheduleCreateButton.isVisible()) {
        if (await scheduleCreateButton.isEnabled()) {
          await scheduleCreateButton.click({ timeout: 20_000 });
          await expect(
            page.locator(
              '[data-testid="portal-workflow-template-studio-triggers-schedules-editor-modal"]'
            )
          ).toBeVisible();
          await captureFullPage(
            page,
            evidencePath("portal-workflow-template-studio-schedule-trigger-modal.png"
            )
          );
          await page.keyboard.press("Escape");
          await expect(
            page.locator(
              '[data-testid="portal-workflow-template-studio-triggers-schedules-editor-modal"]'
            )
          ).toBeHidden();
        }
      }

      const workflowRunTriggersPanel = page.locator(
        '[data-testid="portal-workflow-template-studio-triggers-workflow-runs"]'
      );
      if (await workflowRunTriggersPanel.isVisible()) {
        await workflowRunTriggersPanel.scrollIntoViewIfNeeded();
        await captureFullPage(
          page,
          evidencePath("portal-workflow-template-studio-workflow-run-triggers.png"
          )
        );

        const createOutgoing = page.locator(
          '[data-testid="portal-workflow-template-studio-triggers-workflow-runs-outgoing-new"]'
        );
        const createIncoming = page.locator(
          '[data-testid="portal-workflow-template-studio-triggers-workflow-runs-incoming-new"]'
        );

        if ((await createOutgoing.isVisible()) && (await createOutgoing.isEnabled())) {
          await createOutgoing.click({ timeout: 20_000 });
        } else if (
          (await createIncoming.isVisible()) &&
          (await createIncoming.isEnabled())
        ) {
          await createIncoming.click({ timeout: 20_000 });
        }

        const workflowRunEditor = page.locator(
          '[data-testid="portal-workflow-template-studio-triggers-workflow-runs-editor"]'
        );
        if (await workflowRunEditor.isVisible()) {
          await captureFullPage(
            page,
            evidencePath("portal-workflow-template-studio-workflow-run-trigger-modal.png"
            )
          );
          await page.keyboard.press("Escape");
          await expect(workflowRunEditor).toBeHidden({ timeout: 20_000 });
        }
      }
    }

    const testRunButton = page.locator(
      '[data-testid="portal-workflow-template-studio-actions-test-run"]'
    );
    if (await testRunButton.isVisible()) {
      if (await testRunButton.isEnabled()) {
        await testRunButton.click({ timeout: 20_000 });
        await expect(
          page.locator(
            '[data-testid="portal-workflow-template-studio-actions-test-run-modal"]'
          )
        ).toBeVisible();
        await captureFullPage(
          page,
          evidencePath("portal-workflow-template-studio-test-run-modal.png")
        );

        const submitRun = page.locator(
          '[data-testid="portal-workflow-template-studio-actions-test-run-submit"]'
        );
        const templateUrl = page.url();
        if (await submitRun.isVisible()) {
          if (await submitRun.isEnabled()) {
            await submitRun.click({ timeout: 20_000 });
            try {
              await page.waitForURL(/\/workflows\/runs\//, { timeout: 60_000 });
            } catch {
              await page.keyboard.press("Escape");
            }

            await page.goto(templateUrl, { waitUntil: "domcontentloaded", timeout: 60_000 });
            await expect(
              page.locator(
                '[data-testid="portal-workflow-template-studio-ready"], [data-testid="portal-workflow-template-studio-error"], [data-testid="portal-auth-required"]'
              )
            ).toBeVisible({ timeout: 60_000 });
          } else {
            await page.keyboard.press("Escape");
          }
        } else {
          await page.keyboard.press("Escape");
        }
      }
    }

    const studioTab = page.getByRole("tab", { name: /Studio/i });
    if (await studioTab.isVisible()) {
      await studioTab.click({ timeout: 20_000 });
      await expect(
        page.locator(
          '[data-testid="portal-workflow-template-studio-ready"], [data-testid="portal-workflow-template-studio-error"]'
        )
      ).toBeVisible({ timeout: 20_000 });
    } else if (page.url().includes("#")) {
      await page.goto(page.url().split("#")[0], {
        waitUntil: "domcontentloaded",
        timeout: 60_000,
      });
      await expect(
        page.locator(
          '[data-testid="portal-workflow-template-studio-ready"], [data-testid="portal-workflow-template-studio-error"]'
        )
      ).toBeVisible({ timeout: 20_000 });
    }

    const flowTab = page.locator(
      '[data-testid="portal-workflow-template-studio-steps-tab-flow"]'
    );
    if (await flowTab.isVisible()) {
      await flowTab.click({ timeout: 20_000 });
    }
    const paletteSearch = page.locator(
      '[data-testid="portal-workflow-template-studio-steps-flow-palette-search"]'
    );
    if (await paletteSearch.isVisible()) {
      await paletteSearch.scrollIntoViewIfNeeded();
      await expect(paletteSearch).toBeVisible({ timeout: 20_000 });

      const paletteList = page.locator(
        '[data-testid="portal-workflow-template-studio-steps-flow-palette-list"]'
      );
      await expect(paletteList).toBeVisible({ timeout: 20_000 });

      const paletteReady = paletteList
        .locator(
          '[data-testid^="portal-workflow-template-studio-steps-flow-palette-item-"]'
        )
        .first()
        .or(paletteList.getByText("No matching operations."))
        .or(paletteList.getByText("Operation library unavailable."));

      await expect(paletteReady).toBeVisible({ timeout: 20_000 });
      await captureFullPage(
        page,
        evidencePath("portal-workflow-template-studio-steps-flow.png")
      );

      const flowCanvasScroll = page.locator(
        '[data-testid="portal-workflow-template-studio-steps-flow-canvas-scroll"]'
      );
      if (await flowCanvasScroll.isVisible()) {
        await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur?.());
        const focusedCanvas = await focusWithTab(page, flowCanvasScroll);
        if (focusedCanvas) {
          await captureFullPage(
            page,
            evidencePath("portal-workflow-template-studio-steps-flow-canvas-focused.png"
            )
          );
          const firstFlowStepCard = page
            .locator(
              '[data-testid^="portal-workflow-template-studio-steps-flow-step-card-"]'
            )
            .first();
          if (await firstFlowStepCard.isVisible()) {
            const focusedStep = await focusWithTab(page, firstFlowStepCard, 20);
            if (focusedStep) {
              await captureFullPage(
                page,
                evidencePath("portal-workflow-template-studio-steps-flow-step-focused.png"
                )
              );
            }
          }
        }
      }

      const connectFrom = page
        .locator(
          '[data-testid^="portal-workflow-template-studio-steps-flow-connect-from-"]'
        )
        .first();
      const connectTo = page
        .locator(
          '[data-testid^="portal-workflow-template-studio-steps-flow-connect-to-"]'
        )
        .nth(1);
      if ((await connectFrom.isVisible()) && (await connectTo.isVisible())) {
        await connectFrom.scrollIntoViewIfNeeded();
        await connectFrom.focus();
        await page.keyboard.press("Enter");
        await expect(connectTo).toBeEnabled({ timeout: 20_000 });
        await connectTo.focus();
        await captureFullPage(
          page,
          evidencePath("portal-workflow-template-studio-steps-flow-connect-keyboard.png"
          )
        );
        await page.keyboard.press("Escape");
        await expect(connectTo).toBeDisabled({ timeout: 20_000 });
      }

      const zoomOut = page.locator(
        '[data-testid="portal-workflow-template-studio-steps-flow-zoom-out"]'
      );
      const zoomValue = page.locator(
        '[data-testid="portal-workflow-template-studio-steps-flow-zoom-value"]'
      );
      if (await zoomValue.isVisible()) {
        await zoomValue.hover({ timeout: 20_000 });
        await expect(page.getByRole("tooltip")).toBeVisible({ timeout: 10_000 });
        await captureFullPage(
          page,
          evidencePath("portal-workflow-template-studio-steps-flow-zoom-shortcuts.png"
          )
        );
        await page.mouse.move(0, 0);
      }
      if (await zoomOut.isVisible()) {
        await zoomOut.click({ timeout: 20_000 });
        await expect(zoomValue).toHaveText("90%");
        await captureFullPage(
          page,
          evidencePath("portal-workflow-template-studio-steps-flow-zoomed.png"
          )
        );
        if (await zoomValue.isEnabled()) {
          await zoomValue.click({ timeout: 20_000 });
          await expect(zoomValue).toHaveText("100%");
        }
      }

      const wheelZoomed = await wheelZoomWorkflowTemplateFlowCanvas({
        page,
        testIdPrefix: "portal",
        deltaY: -120,
      });
      if (wheelZoomed) {
        await expect(zoomValue).toHaveText("110%");
        await captureFullPage(
          page,
          evidencePath("portal-workflow-template-studio-steps-flow-wheel-zoomed.png"
          )
        );
        if (await zoomValue.isEnabled()) {
          await zoomValue.click({ timeout: 20_000 });
          await expect(zoomValue).toHaveText("100%");
        }
      }

      const disconnectButton = page
        .locator(
          '[data-testid^="portal-workflow-template-studio-steps-flow-step-clear-next-"]'
        )
        .first();
      if (await disconnectButton.isVisible()) {
        const disconnectTestId = await disconnectButton.getAttribute("data-testid");
        if (disconnectTestId) {
          await disconnectButton.click({ timeout: 20_000 });
          const confirmDialog = page.locator(
            `[data-testid="${disconnectTestId}-confirm-dialog"]`
          );
          await expect(confirmDialog).toBeVisible({ timeout: 20_000 });
          await captureFullPage(
            page,
            evidencePath("portal-workflow-template-studio-steps-flow-disconnect-confirm.png"
            )
          );
          const confirmSubmit = page.locator(
            `[data-testid="${disconnectTestId}-confirm-submit"]`
          );
          const undoButton = page.locator(
            '[data-testid="portal-workflow-template-studio-steps-flow-undo"]'
          );
          const redoButton = page.locator(
            '[data-testid="portal-workflow-template-studio-steps-flow-redo"]'
          );
          if (await confirmSubmit.isVisible()) {
            await confirmSubmit.click({ timeout: 20_000 });
            await expect(confirmDialog).toBeHidden({ timeout: 20_000 });
            if (await undoButton.isVisible()) {
              await expect(undoButton).toBeEnabled({ timeout: 20_000 });
              await captureFullPage(
                page,
                evidencePath("portal-workflow-template-studio-steps-flow-routing-undo.png"
                )
              );
              await undoButton.click({ timeout: 20_000 });
              await expect(redoButton).toBeEnabled({ timeout: 20_000 });
              await captureFullPage(
                page,
                evidencePath("portal-workflow-template-studio-steps-flow-routing-redo.png"
                )
              );
            }
          } else {
            await page.keyboard.press("Escape");
            await expect(confirmDialog).toBeHidden({ timeout: 20_000 });
          }
        }
      }

      const flowStepCard = page
        .locator(
          '[data-testid^="portal-workflow-template-studio-steps-flow-step-card-"]'
        )
        .first();
      if (await flowStepCard.isVisible()) {
        await flowStepCard.click({ timeout: 20_000 });
        const flowStepEditorDrawer = page.locator(
          '[data-testid="portal-workflow-template-studio-steps-flow-step-editor-drawer"]'
        );
        await expect(flowStepEditorDrawer).toBeVisible({ timeout: 20_000 });
        const operationInput = page.locator(
          '[data-testid="portal-workflow-template-studio-steps-flow-step-editor-operation"]'
        );
        await expect(operationInput).toBeVisible({ timeout: 20_000 });
        await expect(operationInput).toHaveValue(/\S+/, { timeout: 20_000 });
        await captureFullPage(
          page,
          evidencePath("portal-workflow-template-studio-step-editor-flow.png")
        );

        const enabledCheckbox = flowStepEditorDrawer.getByRole("checkbox", {
          name: workflowStepEnabledLabel(),
        });
        await expect(enabledCheckbox).toBeVisible({ timeout: 20_000 });
        if (await enabledCheckbox.isVisible()) {
          const initialEnabled = await enabledCheckbox.isChecked();
          await enabledCheckbox.setChecked(!initialEnabled);

          const saveStepButton = page.locator(
            '[data-testid="portal-workflow-template-studio-steps-flow-step-editor-save"]'
          );
          if (await saveStepButton.isVisible()) {
            if (await saveStepButton.isEnabled({ timeout: 20_000 })) {
              await captureFullPage(
                page,
                evidencePath("portal-workflow-template-studio-step-editor-flow-save.png"
                )
              );
              await saveStepButton.click({ timeout: 20_000 });
              await expect(saveStepButton).toBeEnabled({ timeout: 20_000 });
              const closeButton = flowStepEditorDrawer.getByRole("button", {
                name: workflowStepEditorCloseLabel(),
                exact: true,
              });
              await expect(closeButton).toBeVisible({ timeout: 20_000 });
              await expect(closeButton).toBeEnabled({ timeout: 20_000 });
              await closeButton.click({ timeout: 20_000 });
              await expect(flowStepEditorDrawer).toBeHidden({ timeout: 20_000 });

              const undoButton = page.locator(
                '[data-testid="portal-workflow-template-studio-steps-flow-undo"]'
              );
              const redoButton = page.locator(
                '[data-testid="portal-workflow-template-studio-steps-flow-redo"]'
              );
              if (await undoButton.isVisible()) {
                await expect(undoButton).toBeEnabled({ timeout: 20_000 });
                await captureFullPage(
                  page,
                  evidencePath("portal-workflow-template-studio-step-editor-flow-save-undo.png"
                  )
                );
                await undoButton.click({ timeout: 20_000 });
                await expect(redoButton).toBeEnabled({ timeout: 20_000 });
                await captureFullPage(
                  page,
                  evidencePath("portal-workflow-template-studio-step-editor-flow-save-redo.png"
                  )
                );
              }
            } else {
              await page.keyboard.press("Escape");
              await expect(flowStepEditorDrawer).toBeHidden({ timeout: 20_000 });
            }
          }
        } else {
          await page.keyboard.press("Escape");
          await expect(flowStepEditorDrawer).toBeHidden({ timeout: 20_000 });
        }
      }

      const triggersOpen = page.locator(
        '[data-testid="portal-workflow-template-studio-steps-flow-triggers-card-open"]'
      );
      if (await triggersOpen.isVisible()) {
        await triggersOpen.click({ timeout: 20_000 });
        await expect(
          page.locator(
            '[data-testid="portal-workflow-template-studio-steps-flow-triggers-card-drawer"]'
          )
        ).toBeVisible({ timeout: 20_000 });
        await captureFullPage(
          page,
          evidencePath("portal-workflow-template-studio-triggers-drawer.png")
        );
        await page.keyboard.press("Escape");
        await expect(
          page.locator(
            '[data-testid="portal-workflow-template-studio-steps-flow-triggers-card-drawer"]'
          )
        ).toBeHidden({ timeout: 20_000 });
      }

      const runPreviewSelect = page.locator(
        '[data-testid="portal-workflow-template-studio-steps-flow-run-preview-select"]'
      );
      if (await runPreviewSelect.isVisible()) {
        if (await runPreviewSelect.isEnabled()) {
          const values = await runPreviewSelect
            .locator("option")
            .evaluateAll((options) =>
              options.map((option) => option.getAttribute("value") || "")
            );
          const selected = values.find((value) => value.trim().length > 0);
          if (selected) {
            await runPreviewSelect.selectOption(selected);
          }
        }
        await captureFullPage(
          page,
          evidencePath("portal-workflow-template-studio-steps-flow-run-preview.png"
          )
        );

        const runInspectorOpen = page.locator(
          '[data-testid="portal-workflow-template-studio-steps-flow-run-preview-inspect"]'
        );
        if (await runInspectorOpen.isVisible()) {
          await runInspectorOpen.click({ timeout: 20_000 });
           await expect(
             page.locator(
               '[data-testid="portal-workflow-template-studio-steps-flow-run-inspector-drawer"]'
             )
           ).toBeVisible({ timeout: 20_000 });
           await expect(
             page.locator(
               '[data-testid="portal-workflow-template-studio-steps-flow-run-inspector-provenance"]'
             )
           ).toBeVisible({ timeout: 20_000 });
           await captureFullPage(
             page,
             evidencePath("portal-workflow-template-studio-steps-flow-run-inspector.png"
            )
          );

          const runInspectorLogsPanel = page.locator(
            '[data-testid="portal-workflow-template-studio-steps-flow-run-inspector-logs"]'
          );
          if (await runInspectorLogsPanel.isVisible()) {
            await runInspectorLogsPanel.scrollIntoViewIfNeeded();
            const logsTabSimple = runInspectorLogsPanel.locator(
              '[data-testid="portal-workflow-template-studio-steps-flow-run-inspector-logs-tab-simple"]'
            );
            if (await logsTabSimple.isVisible()) {
              await logsTabSimple.click({ timeout: 20_000 });
            }

            const simpleStep = runInspectorLogsPanel
              .locator(
                '[data-testid^="portal-workflow-template-studio-steps-flow-run-inspector-logs-simple-step-"]'
              )
              .first();
            const simpleEmpty = runInspectorLogsPanel.locator(
              '[data-testid="portal-workflow-template-studio-steps-flow-run-inspector-logs-simple-empty"]'
            );
            await expect(simpleEmpty.or(simpleStep)).toBeVisible({ timeout: 20_000 });
            await captureFullPage(
              page,
              evidencePath("portal-workflow-template-studio-steps-flow-run-inspector-logs-simple.png"
              )
            );
          }

          const runInspectorStepCard = page
            .locator(
              '[data-testid^="portal-workflow-template-studio-steps-flow-run-inspector-step-card-"]'
            )
            .first();
          if (await runInspectorStepCard.isVisible()) {
            await runInspectorStepCard.evaluate((element) => {
              if (element instanceof HTMLElement) element.click();
            });
            await captureFullPage(
              page,
              evidencePath("portal-workflow-template-studio-steps-flow-run-inspector-step-filter.png"
              )
            );
          }

          const runInspectorLogsAdvancedTab = page.locator(
            '[data-testid="portal-workflow-template-studio-steps-flow-run-inspector-logs-tab-advanced"]'
          );
          if (await runInspectorLogsAdvancedTab.isVisible()) {
            await runInspectorLogsAdvancedTab.click({ timeout: 20_000 });
            await expect(
              page.locator(
                '[data-testid="portal-workflow-template-studio-steps-flow-run-inspector-logs-filter-search"]'
              )
            ).toBeVisible({ timeout: 20_000 });
            await expect(
              page.locator(
                '[data-testid="portal-workflow-template-studio-steps-flow-run-inspector-logs-action-copy-json"]'
              )
            ).toBeVisible({ timeout: 20_000 });
            await expect(
              page.locator(
                '[data-testid="portal-workflow-template-studio-steps-flow-run-inspector-logs-action-download-json"]'
              )
            ).toBeVisible({ timeout: 20_000 });
            await captureFullPage(
              page,
              evidencePath("portal-workflow-template-studio-steps-flow-run-inspector-logs-advanced.png"
              )
            );
          }

          await page.keyboard.press("Escape");
          await expect(
            page.locator(
              '[data-testid="portal-workflow-template-studio-steps-flow-run-inspector-drawer"]'
            )
          ).toBeHidden({ timeout: 20_000 });
        }
      }
    }

    const builderTab = page.locator(
      '[data-testid="portal-workflow-template-studio-steps-tab-builder"]'
    );
    if (await builderTab.isVisible()) {
      await builderTab.click({ timeout: 20_000 });
    }

    const builderAddStepButton = page.locator(
      '[data-testid="portal-workflow-template-studio-steps-builder-add"]'
    );
    if (await builderAddStepButton.isVisible()) {
      await builderAddStepButton.scrollIntoViewIfNeeded();
      await expect(builderAddStepButton).toBeVisible({ timeout: 20_000 });
      await captureFullPage(
        page,
        evidencePath("portal-workflow-template-studio-steps-builder.png")
      );
    }

    const firstStepCard = page
      .locator(
        '[data-testid^="portal-workflow-template-studio-steps-builder-step-card-"]'
      )
      .first();
    if (await firstStepCard.isVisible()) {
      await firstStepCard.click({ timeout: 20_000 });
      await expect(
        page.locator(
          '[data-testid="portal-workflow-template-studio-steps-builder-step-editor-drawer"]'
        )
      ).toBeVisible();
      await captureFullPage(
        page,
        evidencePath("portal-workflow-template-studio-step-editor.png")
      );

      const routingPanel = page.locator(
        '[data-testid="portal-workflow-template-studio-steps-builder-step-editor-routing"]'
      );
      if (await routingPanel.isVisible()) {
        await routingPanel.evaluate((el) => {
          if (el instanceof HTMLDetailsElement) el.open = true;
        });
        await captureFullPage(
          page,
          evidencePath("portal-workflow-template-studio-step-editor-routing.png"
          )
        );

        const routingCondition = page.locator(
          '[data-testid="portal-workflow-template-studio-steps-builder-step-editor-routing-condition"]'
        );
        if (await routingCondition.isVisible()) {
          await expect(routingCondition).toBeVisible({ timeout: 20_000 });
          if (await routingCondition.isEditable()) {
            await routingCondition.fill("{ invalid-json");
            await captureFullPage(
              page,
              evidencePath("portal-workflow-template-studio-step-editor-routing-invalid.png"
              )
            );
          }
        }

        // Keep later sections within the drawer viewport.
        await routingPanel.evaluate((el) => {
          if (el instanceof HTMLDetailsElement) el.open = false;
        });
      }

      const metadataPanel = page.locator(
        '[data-testid="portal-workflow-template-studio-steps-builder-step-editor-metadata"]'
      );
      if (await metadataPanel.isVisible()) {
        await metadataPanel.evaluate((el) => {
          if (el instanceof HTMLDetailsElement) el.open = true;
        });
        const schemaLoading = page.locator(
          '[data-testid="portal-workflow-template-studio-steps-builder-step-editor-metadata-schema-loading"]'
        );
        await expect(schemaLoading).toBeHidden({ timeout: 60_000 });
        await captureFullPage(
          page,
          evidencePath("portal-workflow-template-studio-step-editor-metadata.png"
          )
        );

        const jsonModeButton = page.locator(
          '[data-testid="portal-workflow-template-studio-steps-builder-step-editor-metadata-mode-json"]'
        );
        if (await jsonModeButton.isVisible()) {
          await jsonModeButton.click({ timeout: 20_000 });
        }

        const metadataText = page.locator(
          '[data-testid="portal-workflow-template-studio-steps-builder-step-editor-metadata-text"]'
        );
        await expect(metadataText).toBeVisible({ timeout: 20_000 });
        if (await metadataText.isEditable()) {
          await metadataText.fill("{ invalid-json");
          await captureFullPage(
            page,
            evidencePath("portal-workflow-template-studio-step-editor-metadata-invalid.png"
            )
          );
        }
      }

      await page.keyboard.press("Escape");
      await expect(
        page.locator(
          '[data-testid="portal-workflow-template-studio-steps-builder-step-editor-drawer"]'
        )
      ).toBeHidden();
    }

    const addStepButton = page.locator(
      '[data-testid="portal-workflow-template-studio-steps-builder-add"]'
    );
    if (await addStepButton.isVisible()) {
      if (await addStepButton.isEnabled()) {
        await addStepButton.click({ timeout: 20_000 });
        await expect(
          page.locator(
            '[data-testid="portal-workflow-template-studio-steps-builder-add-modal"]'
          )
        ).toBeVisible();
        await captureFullPage(
          page,
          evidencePath("portal-workflow-template-studio-add-step-modal.png")
        );
        await page.keyboard.press("Escape");
        await expect(
          page.locator(
            '[data-testid="portal-workflow-template-studio-steps-builder-add-modal"]'
          )
        ).toBeHidden();
      }
    }
  });
});
