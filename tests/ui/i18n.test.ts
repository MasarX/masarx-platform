import { createUiTranslator } from "../../packages/ui/src/i18n";
import arMessages from "../../packages/config/messages/ar.json";

describe("createUiTranslator", () => {
  it("uses provided locale and messages", () => {
    const t = createUiTranslator("ui.common", {
      locale: "ar",
      messages: arMessages,
    });

    expect(t("workflowFirst")).toBe("\u200FWorkflow-first");
  });

  it("resolves workflow studio run-inspector replay labels in default messages", () => {
    const t = createUiTranslator("ui.workflowStudio");

    expect(t("steps.flow.runInspector.logs.step.replayFromStep")).toBe(
      "Replay from step"
    );
    expect(t("steps.flow.runInspector.logs.step.replayModalTitle")).toBe(
      "Replay workflow from failed step"
    );
    expect(t("steps.flow.runInspector.logs.step.replayModalDescription")).toBe(
      "Start a new run using this run payload and mark replay provenance for the selected failed step."
    );
  });

  it("resolves workflow studio run-inspector replay labels in Arabic messages", () => {
    const t = createUiTranslator("ui.workflowStudio", {
      locale: "ar",
      messages: arMessages,
    });

    expect(t("steps.flow.runInspector.logs.step.replayFromStep")).toBe(
      "إعادة التشغيل من هذه الخطوة"
    );
    expect(t("steps.flow.runInspector.logs.step.replayModalTitle")).toBe(
      "إعادة تشغيل سير العمل من خطوة فاشلة"
    );
    expect(t("steps.flow.runInspector.logs.step.replayModalDescription")).toBe(
      "ابدأ تشغيلًا جديدًا باستخدام حمولة التشغيل الحالية مع تسجيل سياق الإعادة للخطوة الفاشلة المحددة."
    );
  });
});
