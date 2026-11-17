import type { Page } from "@playwright/test";
import enMessages from "../../../packages/config/messages/en.json";
import arMessages from "../../../packages/config/messages/ar.json";

// The E2E bundler supports JSON default imports; mirror that shape in the CommonJS unit runner.
jest.mock("../../../packages/config/messages/en.json", () => ({
  __esModule: true,
  default: jest.requireActual("../../../packages/config/messages/en.json"),
}));
jest.mock("../../../packages/config/messages/ar.json", () => ({
  __esModule: true,
  default: jest.requireActual("../../../packages/config/messages/ar.json"),
}));

const mockVisible = jest.fn();
const mockEnabled = jest.fn();
const mockHidden = jest.fn();
jest.mock("@playwright/test", () => ({
  expect: () => ({
    toBeVisible: mockVisible,
    toBeEnabled: mockEnabled,
    toBeHidden: mockHidden,
  }),
}));

import { closeWorkflowTemplateFlowStepEditor, workflowStepEnabledLabel } from "../../e2e/utils/workflow-studio";

test.each(["en", "ar"] as const)("%s matches the enabled checkbox's complete accessible label", (locale) => {
  const fields = (locale === "en" ? enMessages : arMessages).ui.workflowStudio.steps.builder.add.fields;
  const name = `${fields.enabled} ${fields.enabledHint}`;
  const matcher = workflowStepEnabledLabel();
  expect(matcher.test(name)).toBe(true);
  expect(matcher.test(fields.enabled)).toBe(false);
  expect(matcher.test(`${name} extra`)).toBe(false);
  expect(matcher.test(name.replace(/\.$/, "!"))).toBe(false);
  expect(matcher.test(`${fields.manual} ${fields.manualHint}`)).toBe(false);
});

function drawerPage(locale: "en" | "ar", visible = true) {
  const closeName = (locale === "en" ? enMessages : arMessages).ui.workflowStudio.steps.builder.editor.close;
  const click = jest.fn().mockResolvedValue(undefined);
  const close = { click };
  const getByRole = jest.fn((_role: string, options: { name: string; exact: boolean }) => ({
    matched: options.name === closeName && options.exact,
    or(other: { matched: boolean }) {
      if (!this.matched && !other.matched) throw new Error("localized close not found");
      return close;
    },
  }));
  const drawer = { isVisible: jest.fn().mockResolvedValue(visible), getByRole };
  const page = {
    getByTestId: jest.fn().mockReturnValue(drawer),
    keyboard: { press: jest.fn() },
  };
  return { page, drawer, click, getByRole };
}

beforeEach(() => {
  jest.clearAllMocks();
  mockVisible.mockResolvedValue(undefined);
  mockEnabled.mockResolvedValue(undefined);
  mockHidden.mockResolvedValue(undefined);
});

test.each(["en", "ar"] as const)("%s waits for the pending save before localized dismissal", async (locale) => {
  const { page, click, getByRole } = drawerPage(locale);
  let finishSave!: () => void;
  mockEnabled.mockImplementation(() => new Promise<void>((resolve) => { finishSave = resolve; }));
  const closing = closeWorkflowTemplateFlowStepEditor(page as unknown as Page, "portal");
  // Allow visibility and enabled assertions to reach the intentionally pending save.
  await new Promise<void>((resolve) => setImmediate(resolve));
  expect(mockEnabled).toHaveBeenCalledWith({ timeout: 20_000 });
  expect(click).not.toHaveBeenCalled();
  expect(page.keyboard.press).not.toHaveBeenCalled();
  finishSave();
  await closing;
  expect(getByRole).toHaveBeenCalledWith("button", { name: enMessages.ui.workflowStudio.steps.builder.editor.close, exact: true });
  expect(getByRole).toHaveBeenCalledWith("button", { name: arMessages.ui.workflowStudio.steps.builder.editor.close, exact: true });
  expect(click).toHaveBeenCalledTimes(1);
  expect(mockHidden).toHaveBeenCalledWith({ timeout: 20_000 });
  expect(page.getByTestId).toHaveBeenCalledWith("portal-workflow-template-studio-steps-flow-step-editor-drawer");
});

test("an already closed drawer needs no dismissal", async () => {
  const { page, getByRole, click } = drawerPage("en", false);
  await closeWorkflowTemplateFlowStepEditor(page as unknown as Page, "console");
  expect(getByRole).not.toHaveBeenCalled();
  expect(click).not.toHaveBeenCalled();
});

test.each(["missing close", "save never settles"])("%s fails without an unsafe Escape fallback", async (reason) => {
  const { page, click } = drawerPage("ar");
  (reason === "missing close" ? mockVisible : mockEnabled).mockRejectedValue(new Error(reason));
  await expect(closeWorkflowTemplateFlowStepEditor(page as unknown as Page, "portal")).rejects.toThrow(reason);
  expect(click).not.toHaveBeenCalled();
  expect(page.keyboard.press).not.toHaveBeenCalled();
  expect(mockHidden).not.toHaveBeenCalled();
});

test("a drawer that stays open after clicking is still a failure", async () => {
  const { page, click } = drawerPage("ar");
  mockHidden.mockRejectedValue(new Error("still open"));
  await expect(closeWorkflowTemplateFlowStepEditor(page as unknown as Page, "portal")).rejects.toThrow("still open");
  expect(click).toHaveBeenCalledTimes(1);
});
