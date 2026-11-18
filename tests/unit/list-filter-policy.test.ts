// Verify that filter choices follow the resolved list filter policy.

import {
  STATIC_LIST_FILTER,
  normalizeListFilterPolicy,
  applyFilterPredicate,
  type ListFilterPolicyValue,
} from "../../apps/fieldops/src/list-filter-policy";

type TaskItem = { id: string; status?: string | null };

const SAMPLE: TaskItem[] = [
  { id: "t1", status: "open" },
  { id: "t2", status: "assigned" },
  { id: "t3", status: "queued" },
  { id: "t4", status: "in_progress" },
  { id: "t5", status: "en_route" },
  { id: "t6", status: "arrived" },
  { id: "t7", status: "completed" },
  { id: "t8", status: "done" },
  { id: "t9", status: "closed" },
  { id: "t10", status: "failed" },
  { id: "t11", status: "exception" },
  { id: "t12", status: "rejected" },
];

describe("list_filter_policy helpers", () => {
  describe("STATIC_LIST_FILTER (mirror of global seed)", () => {
    test("has version 1", () => {
      expect(STATIC_LIST_FILTER.version).toBe(1);
    });
    test("has exactly 5 filters (All/Open/In progress/Done/Failed)", () => {
      expect(STATIC_LIST_FILTER.filters).toHaveLength(5);
    });
    test("first filter is 'all' and is marked default", () => {
      const allFilter = STATIC_LIST_FILTER.filters[0]!;
      expect(allFilter.key).toBe("all");
      expect(allFilter.label_en).toBe("All");
      expect(allFilter.label_ar).toBe("الكل");
      expect(allFilter.default).toBe(true);
      expect(allFilter.predicate).toBeUndefined();
    });
    test("'open' filter matches open/assigned/queued statuses", () => {
      const openFilter = STATIC_LIST_FILTER.filters.find((f) => f.key === "open")!;
      expect(openFilter.label_en).toBe("Open");
      expect(openFilter.label_ar).toBe("مفتوحة");
      expect(openFilter.predicate?.status_in).toEqual(["open", "assigned", "queued"]);
    });
    test("'in_progress' filter matches in_progress/en_route/arrived statuses", () => {
      const ipFilter = STATIC_LIST_FILTER.filters.find((f) => f.key === "in_progress")!;
      expect(ipFilter.label_en).toBe("In progress");
      expect(ipFilter.label_ar).toBe("جاري");
      expect(ipFilter.predicate?.status_in).toEqual(["in_progress", "en_route", "arrived"]);
    });
    test("'done' filter matches completed/done/closed statuses", () => {
      const doneFilter = STATIC_LIST_FILTER.filters.find((f) => f.key === "done")!;
      expect(doneFilter.label_en).toBe("Done");
      expect(doneFilter.label_ar).toBe("تم");
      expect(doneFilter.predicate?.status_in).toEqual(["completed", "done", "closed"]);
    });
    test("'failed' filter matches failed/exception/rejected statuses", () => {
      const failedFilter = STATIC_LIST_FILTER.filters.find((f) => f.key === "failed")!;
      expect(failedFilter.label_en).toBe("Failed");
      expect(failedFilter.label_ar).toBe("فشل");
      expect(failedFilter.predicate?.status_in).toEqual(["failed", "exception", "rejected"]);
    });
  });

  describe("applyFilterPredicate", () => {
    test("undefined predicate (the 'all' filter) is pass-through", () => {
      const result = applyFilterPredicate(SAMPLE, undefined);
      expect(result).toHaveLength(SAMPLE.length);
      expect(result.map((i) => i.id)).toEqual(SAMPLE.map((i) => i.id));
    });
    test("empty status_in array is pass-through (operator misconfig safety)", () => {
      const result = applyFilterPredicate(SAMPLE, { status_in: [] });
      expect(result).toHaveLength(SAMPLE.length);
    });
    test("'open' predicate filters to open/assigned/queued items", () => {
      const openPred = STATIC_LIST_FILTER.filters.find((f) => f.key === "open")!.predicate;
      const result = applyFilterPredicate(SAMPLE, openPred);
      expect(result.map((i) => i.id).sort()).toEqual(["t1", "t2", "t3"]);
    });
    test("'in_progress' predicate filters to in_progress/en_route/arrived items", () => {
      const ipPred = STATIC_LIST_FILTER.filters.find((f) => f.key === "in_progress")!.predicate;
      const result = applyFilterPredicate(SAMPLE, ipPred);
      expect(result.map((i) => i.id).sort()).toEqual(["t4", "t5", "t6"]);
    });
    test("'done' predicate filters to completed/done/closed items", () => {
      const donePred = STATIC_LIST_FILTER.filters.find((f) => f.key === "done")!.predicate;
      const result = applyFilterPredicate(SAMPLE, donePred);
      expect(result.map((i) => i.id).sort()).toEqual(["t7", "t8", "t9"]);
    });
    test("'failed' predicate filters to failed/exception/rejected items", () => {
      const failPred = STATIC_LIST_FILTER.filters.find((f) => f.key === "failed")!.predicate;
      const result = applyFilterPredicate(SAMPLE, failPred);
      expect(result.map((i) => i.id).sort()).toEqual(["t10", "t11", "t12"]);
    });
    test("predicate with no matches returns empty array", () => {
      const result = applyFilterPredicate(SAMPLE, { status_in: ["nope"] });
      expect(result).toEqual([]);
    });
    test("predicate is case-insensitive (UPPERCASE statuses normalized)", () => {
      const items: TaskItem[] = [
        { id: "a", status: "OPEN" },
        { id: "b", status: "Open" },
        { id: "c", status: "open" },
        { id: "d", status: "completed" },
      ];
      const result = applyFilterPredicate(items, { status_in: ["open"] });
      expect(result.map((i) => i.id)).toEqual(["a", "b", "c"]);
    });
    test("trims whitespace around status before matching", () => {
      const items: TaskItem[] = [
        { id: "a", status: "  open  " },
        { id: "b", status: "completed" },
      ];
      const result = applyFilterPredicate(items, { status_in: ["open"] });
      expect(result.map((i) => i.id)).toEqual(["a"]);
    });
    test("excludes items with null/undefined/empty status from non-pass-through filter", () => {
      const items: TaskItem[] = [
        { id: "a", status: "open" },
        { id: "b", status: null },
        { id: "c", status: undefined },
        { id: "d" },
        { id: "e", status: "" },
        { id: "f", status: "   " },
      ];
      const result = applyFilterPredicate(items, { status_in: ["open"] });
      expect(result.map((i) => i.id)).toEqual(["a"]);
    });
    test("preserves input order in the filtered output", () => {
      const items: TaskItem[] = [
        { id: "z", status: "open" },
        { id: "a", status: "completed" },
        { id: "m", status: "open" },
      ];
      const result = applyFilterPredicate(items, { status_in: ["open"] });
      expect(result.map((i) => i.id)).toEqual(["z", "m"]);
    });
    test("returns a new array (does not mutate the input)", () => {
      const result = applyFilterPredicate(SAMPLE, undefined);
      expect(result).not.toBe(SAMPLE);
      expect(result).toEqual(SAMPLE);
    });
    test("empty input list yields empty output", () => {
      expect(applyFilterPredicate([], { status_in: ["open"] })).toEqual([]);
      expect(applyFilterPredicate([], undefined)).toEqual([]);
    });
  });

  describe("normalizeListFilterPolicy", () => {
    test("returns STATIC_LIST_FILTER for null / undefined / non-object", () => {
      expect(normalizeListFilterPolicy(null)).toEqual(STATIC_LIST_FILTER);
      expect(normalizeListFilterPolicy(undefined)).toEqual(STATIC_LIST_FILTER);
      expect(normalizeListFilterPolicy("string")).toEqual(STATIC_LIST_FILTER);
      expect(normalizeListFilterPolicy(123)).toEqual(STATIC_LIST_FILTER);
    });
    test("falls back to STATIC seed when filters array is empty", () => {
      const result = normalizeListFilterPolicy({ version: 1, filters: [] });
      expect(result.filters).toEqual(STATIC_LIST_FILTER.filters);
    });
    test("falls back to STATIC seed when filters is not an array", () => {
      const result = normalizeListFilterPolicy({ version: 1, filters: "not-an-array" });
      expect(result.filters).toEqual(STATIC_LIST_FILTER.filters);
    });
    test("preserves valid filters and lowercases status_in entries", () => {
      const result = normalizeListFilterPolicy({
        version: 2,
        filters: [
          { key: "all", label_en: "All", label_ar: "الكل", default: true },
          {
            key: "review",
            label_en: "Needs review",
            label_ar: "يحتاج مراجعة",
            predicate: { status_in: ["NEEDS_REVIEW", "Pending"] },
          },
        ],
      });
      expect(result.version).toBe(2);
      expect(result.filters).toHaveLength(2);
      expect(result.filters[1]!.predicate?.status_in).toEqual(["needs_review", "pending"]);
    });
    test("drops malformed filter entries (missing key / labels / non-object)", () => {
      const result = normalizeListFilterPolicy({
        version: 1,
        filters: [
          { key: "all", label_en: "All", label_ar: "الكل", default: true },
          { key: "", label_en: "Empty key", label_ar: "م" }, // empty key
          { label_en: "No key", label_ar: "م" }, // missing key
          { key: "no_en", label_ar: "م" }, // missing label_en
          { key: "no_ar", label_en: "x" }, // missing label_ar
          { key: "ok", label_en: "OK", label_ar: "م" },
          "garbage",
          null,
        ],
      });
      expect(result.filters.map((f) => f.key)).toEqual(["all", "ok"]);
    });
    test("drops empty status_in arrays from predicates", () => {
      const result = normalizeListFilterPolicy({
        version: 1,
        filters: [
          {
            key: "x",
            label_en: "X",
            label_ar: "x",
            predicate: { status_in: [] },
          },
        ],
      });
      expect(result.filters[0]!.predicate).toBeUndefined();
    });
    test("preserves the default flag only when boolean", () => {
      const result = normalizeListFilterPolicy({
        version: 1,
        filters: [
          { key: "a", label_en: "A", label_ar: "أ", default: true },
          { key: "b", label_en: "B", label_ar: "ب", default: "yes" }, // wrong type
          { key: "c", label_en: "C", label_ar: "ج" }, // missing
        ],
      });
      expect(result.filters[0]!.default).toBe(true);
      expect(result.filters[1]!.default).toBeUndefined();
      expect(result.filters[2]!.default).toBeUndefined();
    });
    test("uses default version=1 when version field is missing or invalid", () => {
      const result = normalizeListFilterPolicy({
        filters: [{ key: "all", label_en: "All", label_ar: "الكل", default: true }],
      });
      expect(result.version).toBe(1);
    });
    test("respects per-tenant override (custom 'urgent' filter)", () => {
      const tenantOverride: ListFilterPolicyValue = {
        version: 1,
        filters: [
          { key: "all", label_en: "All", label_ar: "الكل", default: true },
          {
            key: "urgent",
            label_en: "Urgent",
            label_ar: "عاجل",
            predicate: { status_in: ["overdue", "exception"] },
          },
        ],
      };
      const items: TaskItem[] = [
        { id: "a", status: "open" },
        { id: "b", status: "overdue" },
        { id: "c", status: "exception" },
      ];
      const result = applyFilterPredicate(items, tenantOverride.filters[1]!.predicate);
      expect(result.map((i) => i.id)).toEqual(["b", "c"]);
    });
  });
});
