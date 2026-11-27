// Arabic coverage for the FieldOps delivery path: trips, stop, POD, pickup detail, tasks,
// loader scan, damage hold and end of route (issue #302). The screens are not rendered here;
// this checks the catalogs, the pure label helpers, and the screens' source through the i18n
// literal guard.
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { AR_STRINGS, EN_STRINGS } from "../../../apps/fieldops/src/i18n";
import { MOBILE_V2_DAMAGE_HOLD_DEFAULT_CATEGORIES, damageSeverityLabel } from "../../../apps/fieldops/src/mobile-v2-damage-hold-policy";
import { loaderActionLabel } from "../../../apps/fieldops/src/mobile-v2-loader-policy";
import { MOBILE_V2_POD_DEFAULT_POLICY, resolveMobileV2PodFailReasonLabel } from "../../../apps/fieldops/src/mobile-v2-pod-policy";
import { getMobileV2RouteGroupLabel, getMobileV2TaskGroupLabel } from "../../../apps/fieldops/src/mobile-v2-tasks-views";

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { scanSource } = require("../../../scripts/tooling/i18n-literal-guard");

const ARABIC = /[؀-ۿ]/;
const GROUPS = [
  "trips",
  "stop",
  "pickupDetail",
  "pod",
  "tasksScreen",
  "taskViews",
  "loaderScan",
  "damageHold",
  "eor",
  "composer",
  "routeStopDetail",
] as const;
const DELIVERY_FILES = [
  "mobile-v2-trips-screen.tsx",
  "mobile-v2-stop-screen.tsx",
  "mobile-v2-pod-screen.tsx",
  "mobile-v2-pod-policy.ts",
  "mobile-v2-pickup-detail-screen.tsx",
  "mobile-v2-pickup-policy.ts",
  "mobile-v2-tasks-screen.tsx",
  "mobile-v2-tasks-views.ts",
  "mobile-v2-loader-scan-screen.tsx",
  "mobile-v2-loader-policy.ts",
  "mobile-v2-sheet-damage-hold.tsx",
  "mobile-v2-damage-hold-policy.ts",
  "mobile-v2-eor-screen.tsx",
];
const SRC = resolve(__dirname, "../../../apps/fieldops/src");

function placeholders(value: string) {
  return (value.match(/\{\w+\}/g) ?? []).sort();
}

function leaves(value: unknown, prefix = ""): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
    const path = prefix ? `${prefix}.${key}` : key;
    if (child !== null && typeof child === "object") Object.assign(out, leaves(child, path));
    else out[path] = child as string;
  }
  return out;
}

describe("FieldOps delivery path catalog", () => {
  test.each(GROUPS)("%s has the same keys and placeholders in English and Arabic", (group) => {
    const en = leaves(EN_STRINGS[group]);
    const ar = leaves(AR_STRINGS[group]);
    expect(Object.keys(ar).sort()).toEqual(Object.keys(en).sort());
    for (const key of Object.keys(en)) {
      expect({ key, type: typeof en[key] }).toEqual({ key, type: "string" });
      expect({ key, arabic: ARABIC.test(ar[key]) }).toEqual({ key, arabic: true });
      expect({ key, placeholders: placeholders(ar[key]) }).toEqual({ key, placeholders: placeholders(en[key]) });
    }
  });

  test("keeps the English the screens showed before", () => {
    expect(EN_STRINGS.trips.myTrip).toBe("My trip");
    expect(EN_STRINGS.trips.trailerSeal).toBe("Trailer seal");
    expect(EN_STRINGS.pod.commit).toBe("Commit POD");
    expect(EN_STRINGS.pod.reasonParcelDamaged).toBe("Parcel damaged");
    expect(EN_STRINGS.stop.verifiedLocation).toBe("Verified location");
    expect(EN_STRINGS.stop.startDelivery).toBe("Start delivery");
    expect(EN_STRINGS.pickupDetail.scanParcelBarcode).toBe("Scan parcel barcode");
    expect(EN_STRINGS.taskViews.groupNone).toBe("No grouping");
    expect(EN_STRINGS.tasksScreen.allClearTitle).toBe("All clear");
    expect(EN_STRINGS.loaderScan.tapToScan).toBe("Tap to scan");
    expect(EN_STRINGS.damageHold.quarantineCta).toBe("Quarantine · notify supervisor");
    expect(EN_STRINGS.eor.handBack).toBe("Hand back & end shift");
  });

  test("uses the agreed Arabic terms", () => {
    expect(AR_STRINGS.trips.myTrip).toBe("رحلتي");
    expect(AR_STRINGS.trips.trailerSeal).toBe("ختم المقطورة");
    expect(AR_STRINGS.pod.commit).toBe("اعتماد إثبات التسليم");
    expect(AR_STRINGS.pod.reasonParcelDamaged).toBe("الطرد تالف");
    expect(AR_STRINGS.stop.verifiedLocation).toBe("موقع تم التحقق منه");
    expect(AR_STRINGS.stop.startDelivery).toBe("بدء التسليم");
    expect(AR_STRINGS.pickupDetail.scanParcelBarcode).toBe("مسح باركود الطرد");
    expect(AR_STRINGS.taskViews.groupNone).toBe("بدون تجميع");
    expect(AR_STRINGS.tasksScreen.allClearTitle).toBe("لا شيء معلّق");
    expect(AR_STRINGS.loaderScan.tapToScan).toBe("اضغط للمسح");
    expect(AR_STRINGS.damageHold.quarantineCta).toBe("عزل · إبلاغ المشرف");
    expect(AR_STRINGS.eor.handBack).toBe("التسليم وإنهاء الوردية");
  });
});

describe("delivery path label helpers", () => {
  const sort = { key: "sort", label: EN_STRINGS.loaderScan.actions.sort, icon: "split" } as const;
  const wet = MOBILE_V2_DAMAGE_HOLD_DEFAULT_CATEGORIES.find((c) => c.id === "wet")!;
  const damaged = MOBILE_V2_POD_DEFAULT_POLICY.failReasons.find((r) => r.code === "parcel_damaged")!;

  test("show built-in defaults in Arabic", () => {
    expect(getMobileV2RouteGroupLabel("window", AR_STRINGS)).toBe("النافذة الزمنية");
    expect(getMobileV2TaskGroupLabel("none", AR_STRINGS)).toBe(AR_STRINGS.taskViews.groupNone);
    expect(loaderActionLabel(sort, AR_STRINGS)).toBe("فرز");
    expect(damageSeverityLabel(wet, AR_STRINGS)).toBe("مبلل / يتسرب");
    expect(resolveMobileV2PodFailReasonLabel(damaged, AR_STRINGS)).toBe("الطرد تالف");
  });

  test("keep English for existing callers", () => {
    expect(getMobileV2RouteGroupLabel("window")).toBe("Time window");
    expect(loaderActionLabel(sort)).toBe("Sort");
    expect(damageSeverityLabel(wet)).toBe("Wet / leaking");
    expect(resolveMobileV2PodFailReasonLabel(damaged)).toBe("Parcel damaged");
  });

  test("show labels from a policy row as written", () => {
    expect(loaderActionLabel({ ...sort, label: "Cross-dock" }, AR_STRINGS)).toBe("Cross-dock");
    expect(damageSeverityLabel({ ...wet, label: "Soaked" }, AR_STRINGS)).toBe("Soaked");
    expect(resolveMobileV2PodFailReasonLabel({ ...damaged, label: "Box torn" }, AR_STRINGS)).toBe("Box torn");
  });
});

describe("delivery path screens", () => {
  test.each(DELIVERY_FILES)("%s holds no English literals", (file) => {
    const source = readFileSync(resolve(SRC, file), "utf8");
    expect(scanSource(source, file).map((f: { text: string }) => f.text)).toEqual([]);
  });

  test("the preview passes the active locale to every delivery screen", () => {
    const preview = readFileSync(resolve(SRC, "mobile-v2-preview-screen.tsx"), "utf8");
    for (const tag of [
      "MobileV2TripsScreen",
      "MobileV2TripDetailScreen",
      "MobileV2StopScreen",
      "MobileV2PodScreen",
      "MobileV2PickupDetailScreen",
      "MobileV2TasksScreen",
      "MobileV2LoaderScanScreen",
      "MobileV2DamageHoldSheet",
      "MobileV2EorScreen",
    ]) {
      expect({ tag, wired: new RegExp(`<${tag}\\s+theme=\\{ctx\\.theme\\}\\s+locale=\\{ctx\\.locale\\}`).test(preview) })
        .toEqual({ tag, wired: true });
    }
  });
});
