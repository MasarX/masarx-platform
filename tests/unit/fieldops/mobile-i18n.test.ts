import {
  AR_STRINGS,
  EN_STRINGS,
  getFieldOpsStrings,
} from "../../../apps/fieldops/src/i18n";

function leafEntries(value: Record<string, unknown>, prefix = ""): [string, unknown][] {
  return Object.entries(value).flatMap(([key, child]) => {
    const path = prefix ? `${prefix}.${key}` : key;
    return child && typeof child === "object" && !Array.isArray(child)
      ? leafEntries(child as Record<string, unknown>, path)
      : [[path, child] as [string, unknown]];
  });
}

describe("FieldOps typed locale catalogs", () => {
  test.each(["en", "ar"] as const)("preserves action formatter inputs in %s", (locale) => {
    const strings = getFieldOpsStrings(locale);
    const value = "QA-علي-001";
    for (const result of [
      strings.actionFeedback.queueReference(value),
      strings.actionFeedback.lastUpdate(value),
      strings.actionFeedback.retryAt(value),
    ]) expect(result).toContain(value);
    for (const result of [
      strings.actionFeedback.selectedCount(17), strings.actionFeedback.attempts(17),
      strings.actionAccessibility.pending(17),
    ]) expect(result).toContain("17");
    const routeLoad = strings.actionAccessibility.routeLoad(17, 23, 41);
    for (const count of ["17", "23", "41"]) expect(routeLoad).toContain(count);
    const statement = strings.actionFeedback.incidentStatement("type-A", "summary-B");
    for (const value of ["type-A", "summary-B"]) expect(statement).toContain(value);
    const details = strings.actionFeedback.incidentDetails("task-A", "pending", "event-B", 17, "stop-C", "active");
    for (const value of ["task-A", "pending", "event-B", "17", "stop-C", "active"]) expect(details).toContain(value);
  });
  test.each([
    ["cameraUnavailable","Camera unavailable","الكاميرا غير متاحة"],
    ["permissionRequired","Camera permission required.","يلزم إذن الكاميرا."],
    ["permissionDenied","Camera permission was denied. Open settings to grant camera access.","تم رفض إذن الكاميرا. افتح الإعدادات للسماح بالوصول إلى الكاميرا."],
    ["permissionPrompt","Grant camera access to scan barcodes.","اسمح بالوصول إلى الكاميرا لمسح الباركود."],
    ["openSettings","Open settings","فتح الإعدادات"],
    ["grantPermission","Grant permission","منح الإذن"],
    ["lastQueued","Last queued scan","آخر مسح مُدرج"],
    ["queuedOnline","Queued and ready to sync","مُدرج وجاهز للمزامنة"],
    ["queuedOffline","Queued offline for retry","مُدرج دون اتصال لإعادة المحاولة"],
    ["context","Context:","السياق:"],
  ] as const)("preserves bilingual operational scan message %s", (key, en, ar) => {
    expect(getFieldOpsStrings("en").scan[key]).toBe(en);
    expect(getFieldOpsStrings("ar").scan[key]).toBe(ar);
    expect(ar).toMatch(/[\u0600-\u06ff]/);
    expect(ar).not.toBe(en);
  });
  test("keeps English and Arabic catalogs in exact parity", () => {
    const en = new Map(leafEntries(EN_STRINGS));
    const ar = new Map(leafEntries(AR_STRINGS));
    expect([...ar.keys()].sort()).toEqual([...en.keys()].sort());
    for (const [path, value] of en) {
      expect({ path, type: typeof ar.get(path) }).toEqual({ path, type: typeof value });
      expect(["string", "function"]).toContain(typeof value);
      if (typeof value === "string") {
        expect(value.trim()).not.toBe("");
        expect((ar.get(path) as string).trim()).not.toBe("");
      }
    }
    expect([...en].filter(([, value]) => typeof value === "function").map(([path]) => path).sort()).toEqual([
      "actionAccessibility.pending", "actionAccessibility.routeLoad",
      "actionFeedback.attempts", "actionFeedback.incidentDetails", "actionFeedback.incidentStatement",
      "actionFeedback.lastUpdate", "actionFeedback.queueReference",
      "actionFeedback.retryAt", "actionFeedback.selectedCount",
      "detail.accuracy", "detail.recipient", "detail.reference",
      "outbox.pending", "realMap.excluded", "realMap.group",
      "returnActions.scan", "returnActions.serverState", "route.closeoutRoute", "route.subtitle",
      "scan.acceptedReturn", "scan.selectReturn",
      "taskControls.formatCount", "taskControls.page", "taskControls.totalCount", "tasks.itemsCount",
      "wallet.available", "wallet.balance", "wallet.payouts", "wallet.recorded", "wallet.reserved",
    ]);
  });

  test.each([0, 1, 2, 11, 1000, 1234567])("preserves task control formatter semantics for %i", (count) => {
    expect(EN_STRINGS.taskControls.totalCount(count)).toBe(`Matching tasks: ${count}`);
    expect(EN_STRINGS.taskControls.page(count)).toBe(`Page ${count}`);
    expect(EN_STRINGS.taskControls.formatCount(count)).toBe(count.toLocaleString("en"));
    const localized = count.toLocaleString("ar");
    expect(AR_STRINGS.taskControls.totalCount(count)).toBe(`المهام المطابقة: ${localized}`);
    expect(AR_STRINGS.taskControls.page(count)).toBe(`الصفحة ${localized}`);
    expect(AR_STRINGS.taskControls.formatCount(count)).toBe(localized);
  });

  test.each(["en", "ar"] as const)("localizes wallet and return boundaries in %s", locale => {
    const strings = getFieldOpsStrings(locale);
    for (const text of [strings.wallet.title, strings.wallet.invalidCurrency,
      strings.wallet.requested, strings.wallet.summaryWarning,
      strings.returnActions.queued, strings.returnActions.otpDisabled,
      strings.scan.returnPreserveFailed, strings.actionFeedback.incidentUnavailable]) {
      expect(text.trim()).not.toBe("");
      if (locale === "ar") expect(text).toMatch(/[\u0600-\u06ff]/);
    }
    expect(strings.wallet.balance("SAR", "1.2345")).toContain("1.2345");
    expect(strings.wallet.recorded("task-1")).toContain("task-1");
    expect(strings.scan.selectReturn("BAR-1", "Q-1")).toContain("Q-1");
    expect(strings.returnActions.serverState("returned", "review", "task-2")).toContain("task-2");
  });

  test("resolves a deterministic catalog", () => {
    expect(getFieldOpsStrings("en").more.title).toBe("More");
    expect(getFieldOpsStrings("ar").more.title).toBe("المزيد");
  });

  test.each([0, 1, 2, 3, 11, 100])("preserves count %i in both locale formatters", (count) => {
    expect(EN_STRINGS.tasks.itemsCount(count)).toBe(`${count} item${count === 1 ? "" : "s"}`);
    expect(EN_STRINGS.route.subtitle(count)).toBe(`${count} stop${count === 1 ? "" : "s"}`);
    for (const locale of ["en", "ar"] as const) {
      const strings = getFieldOpsStrings(locale);
      for (const formatted of [
        strings.tasks.itemsCount(count), strings.route.subtitle(count), strings.outbox.pending(count),
        strings.realMap.excluded(count), strings.realMap.group(count),
      ]) {
        expect(formatted.trim().length).toBeGreaterThan(String(count).length);
        expect(formatted).toContain(String(count));
      }
    }
    expect(AR_STRINGS.outbox.pending(count)).toBe(`قيد الانتظار: ${count}`);
  });

  test.each([
    [1, "1 عنصر", "1 محطة"],
    [2, "2 عنصران", "2 محطتان"],
    [3, "3 عناصر", "3 محطات"],
  ])("keeps selected Arabic count copy for %i", (count, items, stops) => {
    expect(AR_STRINGS.tasks.itemsCount(count as number)).toBe(items);
    expect(AR_STRINGS.route.subtitle(count as number)).toBe(stops);
  });

  test.each(["ABC-001", "علي", "A&B <001>", ""])("preserves identifiers and names verbatim: %s", (value) => {
    expect(EN_STRINGS.detail.reference(value)).toBe(`Reference: ${value}`);
    expect(AR_STRINGS.detail.reference(value)).toBe(`المرجع: ${value}`);
    expect(EN_STRINGS.detail.recipient(value)).toBe(`Recipient: ${value}`);
    expect(AR_STRINGS.detail.recipient(value)).toBe(`المستلم: ${value}`);
  });

  test.each([0, 5, 2.5, 1000])("preserves accuracy %s without rounding", (meters) => {
    expect(EN_STRINGS.detail.accuracy(meters)).toBe(`Accuracy: +/-${meters}m`);
    expect(AR_STRINGS.detail.accuracy(meters)).toBe(`الدقة: ±${meters} م`);
  });

  test("names clear-dead as non-retriable entries, not pending work", () => {
    expect(EN_STRINGS.outbox.clearDead).toBe("Clear dead");
    expect(AR_STRINGS.outbox.clearDead).toBe("مسح الإدخالات غير القابلة لإعادة المحاولة");
  });

  test("keeps current self-KYC and display preference copy", () => {
    expect(EN_STRINGS.selfKyc.subtitle).toBe("Submit your own evidence. Submission is not approval.");
    expect(AR_STRINGS.selfKyc.subtitle).toBe("أرسل أدلتك الخاصة. الإرسال لا يعني الموافقة.");
    expect(EN_STRINGS.more.subtitle).toBe("Policy-driven shell controls");
    expect(AR_STRINGS.more.subtitle).toBe("إعدادات واجهة التشغيل حسب السياسة");
    expect(EN_STRINGS.auth.signInFailed).toBe("Sign-in failed");
    expect(AR_STRINGS.auth.signInFailed).toBe("تعذر تسجيل الدخول");
  });
});
