import type { UiNavigation, UiTrackingRegistry } from "@masarx/api";
import { createUiTranslator, localizeNavigation, resolveRowDisplayText } from "../../packages/ui/src/i18n";
import { resolveTrackingConfig } from "../../packages/ui/src/tracking-config";

describe("row-driven display localization", () => {
  it("localizes section and nested item labels without changing navigation authority", () => {
    const navigation: UiNavigation = {
      app: "portal",
      sections: [{
        id: "shipments",
        label: "Shipments",
        label_ar: "الشحنات",
        items: [{
          id: "portal-tracking",
          label: "Tracking",
          label_ar: "التتبع",
          href: "/portal/tracking",
          capability: "shipments.read",
          items: [{
            id: "nested",
            label: "Nested",
            label_ar: "متداخل",
            href: "/portal/nested",
          }],
        }],
      }],
    };

    const arabic = localizeNavigation(navigation, "ar-SA");
    expect(arabic.sections[0].label).toBe("الشحنات");
    expect(arabic.sections[0].items[0]).toMatchObject({
      id: "portal-tracking",
      label: "التتبع",
      href: "/portal/tracking",
      capability: "shipments.read",
      items: [{ id: "nested", label: "متداخل", href: "/portal/nested" }],
    });
    expect(localizeNavigation(navigation, "en").sections[0].items[0].label).toBe("Tracking");
    expect(navigation.sections[0].items[0].label).toBe("Tracking");
  });

  it("keeps English on missing, malformed, or unsupported Arabic metadata", () => {
    expect(resolveRowDisplayText("Tracking", " ", "ar")).toBe("Tracking");
    expect(resolveRowDisplayText("Tracking", { ar: "التتبع" }, "ar")).toBe("Tracking");
    expect(resolveRowDisplayText("Tracking", "التتبع", "fr")).toBe("Tracking");
    expect(resolveRowDisplayText("Tracking", "التتبع", "arbitrary")).toBe("Tracking");
  });

  it("localizes only public tracking presentation fields, not lookup keys", () => {
    const registry: UiTrackingRegistry = {
      resource_key: "shipments",
      filter_key: "tracking_number",
      param_key: "tracking_number",
      title: "Tracking",
      title_ar: "التتبع",
      description: "Find a shipment.",
      description_ar: "ابحث عن شحنة.",
      results_description: "Results",
      results_description_ar: "النتائج",
      empty: "Enter a number.",
      empty_ar: "أدخل رقمًا.",
      form: {
        label: "Tracking number",
        label_ar: "رقم التتبع",
        placeholder: "Enter tracking number",
        placeholder_ar: "أدخل رقم التتبع",
        search_label: "Search",
        search_label_ar: "بحث",
        clear_label: "Clear",
        clear_label_ar: "مسح",
      },
    };

    const arabic = resolveTrackingConfig(registry, "ar");
    expect(arabic.error).toBeNull();
    expect(arabic.config).toMatchObject({
      resourceKey: "shipments",
      filterKey: "tracking_number",
      paramKey: "tracking_number",
      title: "التتبع",
      description: "ابحث عن شحنة.",
      resultsDescription: "النتائج",
      empty: "أدخل رقمًا.",
      form: {
        label: "رقم التتبع",
        placeholder: "أدخل رقم التتبع",
        searchLabel: "بحث",
        clearLabel: "مسح",
      },
    });
    expect(resolveTrackingConfig(registry, "en").config?.title).toBe("Tracking");
    expect(resolveTrackingConfig({ ...registry, title_ar: "  " }, "ar").config?.title).toBe("Tracking");
  });
  it("localizes bounded resource and accessibility presentation without changing placeholders", () => {
    const shell = createUiTranslator("ui.appShell", { locale: "ar" });
    const page = createUiTranslator("ui.resourcePage", { locale: "ar" });
    const actions = createUiTranslator("ui.resourceActions", { locale: "ar" });
    const detail = createUiTranslator("ui.resourceDetail", { locale: "ar" });
    const table = createUiTranslator("ui.resourceTable", { locale: "ar" });
    expect(shell("breadcrumb")).toBe("مسار التنقل");
    expect(page("actions.import")).toBe("استيراد");
    expect(page("actions.configured", { count: 2 })).toBe("الأوامر المهيأة: 2");
    expect(page("actions.available", { count: 1 })).toBe("الأوامر المتاحة: 1");
    expect(page("actions.blocked", { count: 1 })).toBe("الأوامر المحجوبة: 1");
    expect(page("summary.range", { start: 1, end: 2, total: 3 })).toBe("عرض 1–2 من 3");
    expect(actions("actionsMenu")).toBe("مزيد من الإجراءات");
    expect(detail("sections.general")).toBe("عام");
    expect(table("summary.label", { total: 3 })).toBe("الملخص (3)");
    expect(table("views.disabled")).toBe("إدارة طرق العرض غير متاحة لنطاق صلاحيتك.");
    expect(createUiTranslator("ui.appShell", { locale: "en" })("breadcrumb")).toBe("Breadcrumb");
  });
});
