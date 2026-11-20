// Verify that sort choices follow the resolved list sort policy.

import {
  STATIC_LIST_SORT,
  normalizeListSortPolicy,
  applySort,
  type ListSortPolicyValue,
} from "../../apps/fieldops/src/list-sort-policy";

type TaskItem = {
  id: string;
  due_at?: string | null;
  priority?: number | null;
  distance_m?: number | null;
};

const SAMPLE: TaskItem[] = [
  { id: "early-high-near", due_at: "2026-04-25T08:00:00Z", priority: 90, distance_m: 100 },
  { id: "mid-low-far", due_at: "2026-04-25T12:00:00Z", priority: 20, distance_m: 5000 },
  { id: "late-mid-mid", due_at: "2026-04-25T16:00:00Z", priority: 50, distance_m: 1500 },
  { id: "missing-due", due_at: null, priority: 70, distance_m: 800 },
  { id: "missing-priority", due_at: "2026-04-25T10:00:00Z", priority: null, distance_m: 600 },
  { id: "missing-distance", due_at: "2026-04-25T14:00:00Z", priority: 40, distance_m: null },
];

describe("list_sort_policy helpers", () => {
  describe("STATIC_LIST_SORT (mirror of global seed)", () => {
    test("has version 1", () => {
      expect(STATIC_LIST_SORT.version).toBe(1);
    });
    test("default_sort_key is 'due_asc'", () => {
      expect(STATIC_LIST_SORT.default_sort_key).toBe("due_asc");
    });
    test("has exactly 4 sorts (due_asc/due_desc/priority_desc/distance_asc)", () => {
      expect(STATIC_LIST_SORT.sorts).toHaveLength(4);
      expect(STATIC_LIST_SORT.sorts.map((s) => s.key)).toEqual([
        "due_asc",
        "due_desc",
        "priority_desc",
        "distance_asc",
      ]);
    });
    test("due_asc maps to field=due_at + direction=asc with bilingual labels", () => {
      const s = STATIC_LIST_SORT.sorts.find((x) => x.key === "due_asc")!;
      expect(s.field).toBe("due_at");
      expect(s.direction).toBe("asc");
      expect(s.label_en).toBe("Due ↑");
      expect(s.label_ar).toBe("الاستحقاق ↑");
    });
    test("due_desc maps to field=due_at + direction=desc", () => {
      const s = STATIC_LIST_SORT.sorts.find((x) => x.key === "due_desc")!;
      expect(s.field).toBe("due_at");
      expect(s.direction).toBe("desc");
    });
    test("priority_desc maps to field=priority + direction=desc", () => {
      const s = STATIC_LIST_SORT.sorts.find((x) => x.key === "priority_desc")!;
      expect(s.field).toBe("priority");
      expect(s.direction).toBe("desc");
    });
    test("distance_asc maps to field=distance_m + direction=asc", () => {
      const s = STATIC_LIST_SORT.sorts.find((x) => x.key === "distance_asc")!;
      expect(s.field).toBe("distance_m");
      expect(s.direction).toBe("asc");
    });
  });

  describe("applySort (the 4 default sort keys)", () => {
    test("due_asc orders earliest due first; nulls last", () => {
      const result = applySort(SAMPLE, "due_asc", STATIC_LIST_SORT);
      expect(result.map((i) => i.id)).toEqual([
        "early-high-near",
        "missing-priority",
        "mid-low-far",
        "missing-distance",
        "late-mid-mid",
        "missing-due", // null goes last
      ]);
    });
    test("due_desc orders latest due first; nulls last", () => {
      const result = applySort(SAMPLE, "due_desc", STATIC_LIST_SORT);
      expect(result.map((i) => i.id)).toEqual([
        "late-mid-mid",
        "missing-distance",
        "mid-low-far",
        "missing-priority",
        "early-high-near",
        "missing-due", // null goes last
      ]);
    });
    test("priority_desc orders highest priority first; nulls last", () => {
      const result = applySort(SAMPLE, "priority_desc", STATIC_LIST_SORT);
      expect(result.map((i) => i.id)).toEqual([
        "early-high-near", // 90
        "missing-due", // 70
        "late-mid-mid", // 50
        "missing-distance", // 40
        "mid-low-far", // 20
        "missing-priority", // null goes last
      ]);
    });
    test("distance_asc orders closest first; nulls last", () => {
      const result = applySort(SAMPLE, "distance_asc", STATIC_LIST_SORT);
      expect(result.map((i) => i.id)).toEqual([
        "early-high-near", // 100
        "missing-priority", // 600
        "missing-due", // 800
        "late-mid-mid", // 1500
        "mid-low-far", // 5000
        "missing-distance", // null goes last
      ]);
    });
  });

  describe("applySort (fallback / edge cases)", () => {
    test("unknown sortKey falls back to default_sort_key", () => {
      const expected = applySort(SAMPLE, "due_asc", STATIC_LIST_SORT);
      const result = applySort(SAMPLE, "nope_does_not_exist", STATIC_LIST_SORT);
      expect(result.map((i) => i.id)).toEqual(expected.map((i) => i.id));
    });
    test("null/undefined/empty sortKey falls back to default_sort_key", () => {
      const expected = applySort(SAMPLE, "due_asc", STATIC_LIST_SORT);
      expect(applySort(SAMPLE, null, STATIC_LIST_SORT).map((i) => i.id)).toEqual(
        expected.map((i) => i.id),
      );
      expect(applySort(SAMPLE, undefined, STATIC_LIST_SORT).map((i) => i.id)).toEqual(
        expected.map((i) => i.id),
      );
      expect(applySort(SAMPLE, "", STATIC_LIST_SORT).map((i) => i.id)).toEqual(
        expected.map((i) => i.id),
      );
    });
    test("returns a new array (does not mutate the input)", () => {
      const result = applySort(SAMPLE, "due_asc", STATIC_LIST_SORT);
      expect(result).not.toBe(SAMPLE);
      expect(SAMPLE.map((i) => i.id)).toEqual([
        "early-high-near",
        "mid-low-far",
        "late-mid-mid",
        "missing-due",
        "missing-priority",
        "missing-distance",
      ]); // input unchanged
    });
    test("empty input list yields empty output", () => {
      expect(applySort([], "due_asc", STATIC_LIST_SORT)).toEqual([]);
    });
    test("policy with zero sorts returns input unchanged", () => {
      const empty: ListSortPolicyValue = {
        version: 1,
        default_sort_key: "due_asc",
        sorts: [],
      };
      const result = applySort(SAMPLE, "due_asc", empty);
      expect(result.map((i) => i.id)).toEqual(SAMPLE.map((i) => i.id));
    });
    test("NaN values sort to the end (treated as missing)", () => {
      const items = [
        { id: "a", priority: 50 },
        { id: "b", priority: NaN },
        { id: "c", priority: 80 },
      ];
      const result = applySort(items, "priority_desc", STATIC_LIST_SORT);
      expect(result.map((i) => i.id)).toEqual(["c", "a", "b"]);
    });
    test("respects per-tenant override (custom default_sort_key)", () => {
      const tenantOverride: ListSortPolicyValue = {
        version: 1,
        default_sort_key: "distance_asc",
        sorts: [...STATIC_LIST_SORT.sorts],
      };
      const expected = applySort(SAMPLE, "distance_asc", STATIC_LIST_SORT);
      // Passing null sortKey now hits the tenant default = distance_asc
      const result = applySort(SAMPLE, null, tenantOverride);
      expect(result.map((i) => i.id)).toEqual(expected.map((i) => i.id));
    });
  });

  describe("normalizeListSortPolicy", () => {
    test("returns STATIC_LIST_SORT for null / undefined / non-object", () => {
      expect(normalizeListSortPolicy(null)).toEqual(STATIC_LIST_SORT);
      expect(normalizeListSortPolicy(undefined)).toEqual(STATIC_LIST_SORT);
      expect(normalizeListSortPolicy("string")).toEqual(STATIC_LIST_SORT);
      expect(normalizeListSortPolicy(123)).toEqual(STATIC_LIST_SORT);
    });
    test("falls back to STATIC seed when sorts array is empty", () => {
      const result = normalizeListSortPolicy({ version: 1, default_sort_key: "x", sorts: [] });
      expect(result.sorts).toEqual(STATIC_LIST_SORT.sorts);
      expect(result.default_sort_key).toBe(STATIC_LIST_SORT.default_sort_key);
    });
    test("falls back to STATIC seed when sorts is not an array", () => {
      const result = normalizeListSortPolicy({
        version: 1,
        default_sort_key: "x",
        sorts: "not-an-array",
      });
      expect(result.sorts).toEqual(STATIC_LIST_SORT.sorts);
    });
    test("preserves valid sorts with all required fields", () => {
      const result = normalizeListSortPolicy({
        version: 2,
        default_sort_key: "stop_asc",
        sorts: [
          {
            key: "stop_asc",
            label_en: "Stop ↑",
            label_ar: "محطة ↑",
            field: "stop_index",
            direction: "asc",
          },
        ],
      });
      expect(result.version).toBe(2);
      expect(result.default_sort_key).toBe("stop_asc");
      expect(result.sorts).toHaveLength(1);
      expect(result.sorts[0]!.field).toBe("stop_index");
    });
    test("drops malformed sort entries (missing key/labels/field)", () => {
      const result = normalizeListSortPolicy({
        version: 1,
        default_sort_key: "due_asc",
        sorts: [
          { key: "due_asc", label_en: "Due ↑", label_ar: "x", field: "due_at", direction: "asc" },
          { key: "", label_en: "x", label_ar: "x", field: "x", direction: "asc" }, // empty key
          { key: "no_en", label_ar: "x", field: "x", direction: "asc" }, // missing label_en
          { key: "no_ar", label_en: "x", field: "x", direction: "asc" }, // missing label_ar
          { key: "no_field", label_en: "x", label_ar: "x", direction: "asc" }, // missing field
          { key: "ok", label_en: "OK", label_ar: "م", field: "f", direction: "desc" },
          "garbage",
          null,
        ],
      });
      expect(result.sorts.map((s) => s.key)).toEqual(["due_asc", "ok"]);
    });
    test("coerces invalid direction to 'asc'", () => {
      const result = normalizeListSortPolicy({
        version: 1,
        default_sort_key: "x",
        sorts: [
          { key: "x", label_en: "X", label_ar: "x", field: "due_at", direction: "sideways" },
        ],
      });
      expect(result.sorts[0]!.direction).toBe("asc");
    });
    test("rewrites default_sort_key to first sort when it doesn't match any entry", () => {
      const result = normalizeListSortPolicy({
        version: 1,
        default_sort_key: "nonexistent",
        sorts: [
          { key: "due_asc", label_en: "Due ↑", label_ar: "x", field: "due_at", direction: "asc" },
        ],
      });
      expect(result.default_sort_key).toBe("due_asc");
    });
    test("rewrites missing default_sort_key to first sort", () => {
      const result = normalizeListSortPolicy({
        version: 1,
        sorts: [
          { key: "alpha", label_en: "A", label_ar: "أ", field: "name", direction: "asc" },
        ],
      });
      expect(result.default_sort_key).toBe("alpha");
    });
    test("preserves valid default_sort_key when it matches", () => {
      const result = normalizeListSortPolicy({
        version: 1,
        default_sort_key: "priority_desc",
        sorts: [
          { key: "due_asc", label_en: "Due ↑", label_ar: "x", field: "due_at", direction: "asc" },
          { key: "priority_desc", label_en: "P↓", label_ar: "x", field: "priority", direction: "desc" },
        ],
      });
      expect(result.default_sort_key).toBe("priority_desc");
    });
    test("uses default version=1 when version field is missing or invalid", () => {
      const result = normalizeListSortPolicy({
        default_sort_key: "x",
        sorts: [
          { key: "x", label_en: "X", label_ar: "x", field: "f", direction: "asc" },
        ],
      });
      expect(result.version).toBe(1);
    });
    test("normalized output is fully usable by applySort", () => {
      const policy = normalizeListSortPolicy({
        version: 1,
        default_sort_key: "priority_desc",
        sorts: [
          {
            key: "priority_desc",
            label_en: "P↓",
            label_ar: "أ↓",
            field: "priority",
            direction: "desc",
          },
        ],
      });
      const items = [
        { id: "a", priority: 10 },
        { id: "b", priority: 90 },
        { id: "c", priority: 50 },
      ];
      const result = applySort(items, "priority_desc", policy);
      expect(result.map((i) => i.id)).toEqual(["b", "c", "a"]);
    });
  });
});
