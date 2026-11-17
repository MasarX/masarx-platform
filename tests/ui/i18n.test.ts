import { createUiTranslator } from "../../packages/ui/src/i18n";
import arMessages from "../../packages/config/messages/ar.json";
import enMessages from "../../packages/config/messages/en.json";
import portalEn from "../../apps/portal/messages/en.json";
import portalAr from "../../apps/portal/messages/ar.json";

describe("createUiTranslator", () => {
  it("keeps report, print-source and Portal activity keys and placeholders aligned", () => {
    const leaves = (value: unknown, prefix = ""): Record<string, string> =>
      typeof value === "string" ? { [prefix]: value }
        : Object.assign({}, ...Object.entries(value as Record<string, unknown>)
          .map(([key, child]) => leaves(child, prefix ? `${prefix}.${key}` : key)));
    for (const [english, arabic] of [
      [enMessages.ui.operationReport, arMessages.ui.operationReport],
      [enMessages.ui.resourceActions.printProgress.diagnostics.sources, arMessages.ui.resourceActions.printProgress.diagnostics.sources],
      [portalEn.observability.trace, portalAr.observability.trace],
      [portalEn.observability.workflowRun.provenance, portalAr.observability.workflowRun.provenance],
    ]) {
      const en = leaves(english);
      const ar = leaves(arabic);
      expect(Object.keys(ar).sort()).toEqual(Object.keys(en).sort());
      for (const key of Object.keys(en)) {
        expect(ar[key]?.match(/\{\w+\}/g) ?? []).toEqual(en[key]?.match(/\{\w+\}/g) ?? []);
      }
    }
  });
  it("preserves English fallback copy with valid RTL prefixes in repaired shared messages", () => {
    const t = createUiTranslator("ui", { locale: "ar", messages: arMessages });
    for (const [namespace, keys] of [
      ["contextStrip", ["copyAria"]],
      ["resourcePage.blocked", ["title", "action"]],
      ["resourceTable.paging", ["title"]],
    ] as const) {
      for (const key of keys) {
        const path = `${namespace}.${key}`;
        const english = path.split(".").reduce<unknown>((value, segment) =>
          (value as Record<string, unknown>)[segment], enMessages.ui) as string;
        const values = { label: "User", count: 3, total: 5 };
        expect(t(path, values)).toBe(`\u200F${english.replace(/\{(label|count|total)\}/g,
          (_, name: keyof typeof values) => String(values[name]))}`);
      }
    }
  });

  it("resolves translated shared labels, access hints and interpolated command summaries", () => {
    const t = createUiTranslator("ui", { locale: "ar", messages: arMessages });
    for (const [key, expected] of [
      ["appShell.layoutFullLabel", "العرض الكامل"],
      ["appShell.layoutContainedLabel", "العرض المحدود"],
      ["appShell.layoutFullAria", "التبديل إلى العرض الكامل"],
      ["appShell.layoutContainedAria", "التبديل إلى العرض المحدود"],
      ["contextStrip.signOut", "تسجيل الخروج"],
      ["contextStrip.actions.copy", "نسخ"],
      ["contextStrip.actions.copied", "تم النسخ"],
      ["contextStrip.actions.copyFailed", "تعذر النسخ"],
      ["contextStrip.actions.details", "التفاصيل"],
      ["contextStrip.actions.close", "إغلاق"],
      ["contextStrip.details.title", "تفاصيل السياق"],
      ["contextStrip.details.description", "معرّفات النطاق والإعدادات المحددة."],
      ["contextStrip.details.userId", "معرّف المستخدم"],
      ["contextStrip.details.orgId", "معرّف المؤسسة"],
      ["contextStrip.details.scopeType", "نوع النطاق"],
      ["contextStrip.details.scopeId", "معرّف النطاق"],
      ["contextStrip.details.settingsResolutionId", "معرّف تحديد الإعدادات"],
      ["commandCatalog.description", "دليل أوامر سير العمل المستند إلى سجل ui_command_registry."],
      ["commandCatalog.filters.searchLabel", "البحث في الأوامر"],
      ["commandCatalog.filters.searchPlaceholder", "ابحث بالاسم أو المفتاح أو سير العمل أو الصلاحية"],
      ["commandCatalog.filters.categoryLabel", "الفئة"],
      ["commandCatalog.filters.categoryAll", "جميع الفئات"],
      ["commandCatalog.filters.capabilityLabel", "الصلاحية"],
      ["commandCatalog.filters.capabilityAll", "جميع الصلاحيات"],
      ["commandCatalog.filters.capabilityNone", "لا تتطلب صلاحية"],
      ["commandCatalog.filters.accessLabel", "الوصول"],
      ["commandCatalog.filters.accessAll", "الكل"],
      ["commandCatalog.filters.accessAllowed", "مسموح"],
      ["commandCatalog.filters.accessMissing", "صلاحية مفقودة"],
      ["commandCatalog.filters.accessNone", "لا تتطلب صلاحية"],
      ["commandCatalog.summary.available", "الأوامر المتاحة: 3"],
      ["commandCatalog.summary.filtered", "عرض 3 من أصل 5 أمرًا"],
      ["commandCatalog.summary.filteredEmpty", "لا تطابق أي أوامر المرشحات الحالية."],
      ["commandCatalog.summary.capabilityBlocked", "تتطلب جميع الأوامر صلاحيات غير متاحة في هذا النطاق."],
      ["commandCatalog.fields.requiredCapability", "الصلاحية المطلوبة"],
      ["commandCatalog.fields.route", "المسار"],
      ["tracking.errors.title", "تهيئة التتبع غير متاحة"],
      ["tracking.errors.action", "تحقّق من إعدادات تهيئة التتبع."],
      ["tracking.errors.loadConfig", "تعذر تحميل تهيئة التتبع."],
      ["tracking.errors.missingConfig", "تهيئة التتبع مفقودة."],
      ["tracking.errors.missingResource", "تهيئة التتبع لا تتضمن مفتاح المورد."],
      ["tracking.errors.missingFilter", "تهيئة التتبع لا تتضمن مفتاح المرشح."],
    ]) expect(t(key, { label: "User", count: 3, total: 5 })).toBe(expected);
  });

  it("contains no malformed leading bidi-prefix encodings in shared Arabic messages", () => {
    const check = (value: unknown): void => {
      if (typeof value === "string") expect(value).not.toMatch(/^(?:\uFFFD|\u00E2\u20AC)/);
      else if (value && typeof value === "object") Object.values(value).forEach(check);
    };
    check(arMessages);
  });

  it("resolves the complete repaired Arabic labels, warnings and routing hints without fallback", () => {
    const t = createUiTranslator("ui", { locale: "ar", messages: arMessages });
    for (const [key, expected] of [
      ["ui.resourceTable.openMode.title", "طريقة الفتح"],
      ["ui.resourceTable.openMode.label", "فتح السجلات في"],
      ["ui.resourceTable.openMode.peek", "معاينة جانبية"],
      ["ui.resourceTable.openMode.full", "صفحة كاملة"],
      ["ui.resourceTable.openMode.modal", "معاينة وسطية"],
      ["ui.resourceTable.openMode.helper", "يحدد مكان فتح تفاصيل السجل عند اختياره."],
      ["ui.resourceTable.internalIds.title", "المعرّفات الداخلية"],
      ["ui.resourceTable.internalIds.toggle", "إظهار المعرّفات الداخلية"],
      ["ui.resourceTable.internalIds.helper", "عرض معرّفات UUID الداخلية كمعلومات ثانوية بجانب معرّفات الأعمال."],
      ["ui.accessPolicyRequest.unsavedWarning", "لديك تعديلات غير محفوظة على سياسة الوصول. هل تريد المغادرة؟"],
      ["ui.settingsRequest.unsavedWarning", "لديك تغييرات غير محفوظة في الإعدادات. هل تريد المغادرة؟"],
      ["ui.workflowStudio.create.unsavedWarning", "لديك تعديلات غير محفوظة على قالب سير العمل. هل تريد المغادرة؟"],
      ["ui.workflowStudio.steps.builder.editor.routing.hints.nextOperationSelf", "الانتقال إلى هذه الخطوة (حلقة تكرار)."],
      ["ui.workflowStudio.steps.builder.editor.routing.hints.nextOperationMissing", "لا توجد خطوة مطابقة في هذا القالب."],
    ]) expect(t(key.slice(3))).toBe(expected);
    expect(t("workflowStudio.steps.builder.editor.routing.hints.nextOperationTargets", {
      index: 3, label: "التسليم",
    })).toBe("الانتقال إلى الخطوة 3: التسليم.");
    expect(t("workflowStudio.steps.builder.editor.routing.hints.nextOperationMultiple", {
      indexes: "2، 4",
    })).toBe("تطابق عدة خطوات: 2، 4. قد يكون التوجيه ملتبسًا.");
  });

  it("renders repaired Arabic navigation and accessible labels without encoding corruption", () => {
    const t = createUiTranslator("ui.navigation", { locale: "ar", messages: arMessages });
    for (const [key, expected] of [
      ["nextStepsAccess", "تأكد من أن حسابك يملك صلاحية الوصول إلى هذا التطبيق."],
      ["nextStepsConnectivity", "تأكد من إمكانية الوصول إلى الخدمة."],
      ["searchLabel", "بحث"],
      ["searchPlaceholder", "ابحث…"],
      ["searchAria", "فتح البحث"],
      ["searchClearAria", "مسح البحث"],
      ["searchClearLabel", "مسح"],
      ["searchEmptyTitle", "لا توجد نتائج مطابقة"],
      ["searchEmptyDescription", "جرّب كلمة بحث أخرى أو تحقّق من نطاق وصولك."],
      ["favoritesLabel", "المفضلة"],
      ["recentsLabel", "الأخيرة"],
      ["pin", "تثبيت"],
      ["unpin", "إلغاء التثبيت"],
      ["pinAria", "إضافة إلى المفضلة"],
      ["unpinAria", "إزالة من المفضلة"],
      ["collapseLabel", "طي"],
      ["expandLabel", "توسيع"],
      ["collapseAria", "طي الشريط الجانبي"],
      ["expandAria", "توسيع الشريط الجانبي"],
      ["collapseAllLabel", "طي الكل"],
      ["expandAllLabel", "توسيع الكل"],
      ["openMobileLabel", "فتح القائمة"],
      ["openMobileAria", "فتح قائمة التنقل"],
      ["closeMobileLabel", "إغلاق"],
      ["closeMobileAria", "إغلاق قائمة التنقل"],
    ]) {
      expect(t(key)).toBe(expected);
      expect(t(key)).not.toMatch(/\uFFFD|\?{2,}/);
    }
    expect(t("searchResultsLabel", { count: 3 })).toBe("3 نتيجة");
    expect(t("collapseSectionAria", { section: "الإعدادات" })).toBe("طي قسم الإعدادات");
    expect(t("expandSectionAria", { section: "الإعدادات" })).toBe("توسيع قسم الإعدادات");
  });

  it("keeps English/Arabic leaf keys aligned in the four affected UI namespaces", () => {
    const leafKeys = (value: unknown, prefix = ""): string[] =>
      typeof value === "object" && value !== null
        ? Object.entries(value).flatMap(([key, child]) => leafKeys(child, prefix ? `${prefix}.${key}` : key))
        : [prefix];
    for (const namespace of ["resourceTable", "accessPolicyRequest", "settingsRequest", "workflowStudio"] as const) {
      const arabic = new Set(leafKeys(arMessages.ui[namespace]));
      expect(leafKeys(enMessages.ui[namespace]).filter(key => !arabic.has(key))).toEqual([]);
    }
  });

  it("uses provided locale and messages", () => {
    const t = createUiTranslator("ui.common", {
      locale: "ar",
      messages: arMessages,
    });

    expect(t("workflowFirst")).toBe("\u200FWorkflow-first");
  });

  it("localizes plain-language shipment search while retaining activity-reference access wording", () => {
    const en = createUiTranslator("ui.shipmentResource.search", { locale: "en", messages: enMessages });
    const ar = createUiTranslator("ui.shipmentResource.search", { locale: "ar", messages: arMessages });

    expect(en("title")).toBe("Shipment search");
    expect(ar("title")).toBe("البحث عن الشحنات");
    expect(ar("description")).not.toContain("مرجع النشاط");
    expect(ar("descriptionWithCorrelation")).toContain("مرجع النشاط");
    expect(ar("placeholder")).not.toContain("مرجع النشاط");
    expect(ar("placeholderWithCorrelation")).toContain("مرجع النشاط");
    expect(ar("submit")).toBe("البحث عن الشحنات");
    expect(ar("clear")).toBe("مسح البحث");
  });
  it("keeps shipment and preview presentation keys, placeholders and Arabic names aligned", () => {
    for (const [english, arabic] of [
      [enMessages.ui.shipmentPresentation, arMessages.ui.shipmentPresentation],
      [enMessages.ui.labelDesigner.preview, arMessages.ui.labelDesigner.preview],
    ]) {
      expect(Object.keys(english).sort()).toEqual(Object.keys(arabic).sort());
      for (const key of Object.keys(english)) {
        const en = (english as Record<string, string>)[key]!;
        const ar = (arabic as Record<string, string>)[key]!;
        expect(ar.match(/\{[^}]+\}/g)).toEqual(en.match(/\{[^}]+\}/g));
        expect(ar).toMatch(/[\u0600-\u06ff]/);
        expect(ar).not.toMatch(/\uFFFD/);
      }
    }
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

function flattenMessageLeaves(
  value: unknown,
  prefix = "",
  leaves: Record<string, string> = {}
): Record<string, string> {
  if (typeof value === "string") {
    leaves[prefix] = value;
    return leaves;
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`Invalid message leaf at ${prefix}`);
  }
  for (const [key, child] of Object.entries(value)) {
    flattenMessageLeaves(child, prefix ? `${prefix}.${key}` : key, leaves);
  }
  return leaves;
}

function messagePlaceholders(message: string): string[] {
  return Array.from(
    message.matchAll(/\{\s*([A-Za-z_][A-Za-z0-9_]*)\s*(?=[,}])/g),
    (match) => match[1]
  ).sort();
}

describe("shared UI message catalog parity", () => {
  it("has exact Arabic leaf and ICU placeholder coverage without replacement characters", () => {
    const english = flattenMessageLeaves(enMessages);
    const arabic = flattenMessageLeaves(arMessages);
    expect(Object.keys(arabic).sort()).toEqual(Object.keys(english).sort());
    for (const [key, value] of Object.entries(english)) {
      expect(arabic[key]).not.toContain("\uFFFD");
      expect(messagePlaceholders(arabic[key])).toEqual(messagePlaceholders(value));
    }
  });

  it("has no literal question-mark translation placeholders", () => {
    const garbled = Object.entries(flattenMessageLeaves(arMessages))
      .filter(([, value]) => /\?{2,}/.test(value)).map(([key]) => key);
    expect(garbled).toEqual([]);
  });
});
