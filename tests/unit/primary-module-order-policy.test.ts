// Verify the configured navigation order and its seed-compatible fallback.

import {
  STATIC_PRIMARY_MODULE_ORDER,
  STATIC_PRIMARY_MODULE_ORDER_WITH_SETTLEMENTS,
  STATIC_PRIMARY_MODULE_ORDER_POLICY,
  normalizePrimaryModuleOrderPolicy,
  resolvePrimaryModuleOrder,
  type PrimaryModuleOrderPolicyValue,
  type PrimaryModuleKey,
} from "../../apps/fieldops/src/primary-module-order-policy";

// The static fallback must remain aligned with the seeded navigation order.
const HISTORICAL_PRIMARY_MODULE_HINT_ORDER: readonly PrimaryModuleKey[] = [
  "home",
  "tasks",
  "route",
  "scan",
  "location",
  "outbox",
  "more",
] as const;

// EXACT historical with-settlements branch that lived at apps/fieldops/App.tsx:738.
const HISTORICAL_PRIMARY_MODULE_HINT_ORDER_WITH_SETTLEMENTS: readonly PrimaryModuleKey[] = [
  "home",
  "tasks",
  "route",
  "scan",
  "location",
  "outbox",
  "settlements",
  "more",
] as const;

describe("primary_module_order_policy helpers", () => {
  describe("STATIC_PRIMARY_MODULE_ORDER (mirror of historical literal)", () => {
    test("matches the historical PRIMARY_MODULE_HINT_ORDER literal exactly", () => {
      expect([...STATIC_PRIMARY_MODULE_ORDER]).toEqual([
        ...HISTORICAL_PRIMARY_MODULE_HINT_ORDER,
      ]);
    });

    test("with-settlements matches the historical with-settlements branch exactly", () => {
      expect([...STATIC_PRIMARY_MODULE_ORDER_WITH_SETTLEMENTS]).toEqual([
        ...HISTORICAL_PRIMARY_MODULE_HINT_ORDER_WITH_SETTLEMENTS,
      ]);
    });

    test("with-settlements is the same as the base order with `settlements` inserted before `more`", () => {
      const base = [...STATIC_PRIMARY_MODULE_ORDER];
      const moreIdx = base.indexOf("more");
      const expected = [...base.slice(0, moreIdx), "settlements", "more"];
      expect([...STATIC_PRIMARY_MODULE_ORDER_WITH_SETTLEMENTS]).toEqual(expected);
    });

    test("STATIC_PRIMARY_MODULE_ORDER_POLICY exposes both arrays + version=1", () => {
      expect(STATIC_PRIMARY_MODULE_ORDER_POLICY.version).toBe(1);
      expect(STATIC_PRIMARY_MODULE_ORDER_POLICY.order).toEqual([
        ...HISTORICAL_PRIMARY_MODULE_HINT_ORDER,
      ]);
      expect(STATIC_PRIMARY_MODULE_ORDER_POLICY.order_with_settlements).toEqual([
        ...HISTORICAL_PRIMARY_MODULE_HINT_ORDER_WITH_SETTLEMENTS,
      ]);
    });
  });

  describe("resolvePrimaryModuleOrder (drop-in replacement for the App.tsx helper)", () => {
    test("includeSettlements=false returns the base STATIC order when no policy is supplied", () => {
      const result = resolvePrimaryModuleOrder(false);
      expect(result).toEqual([...HISTORICAL_PRIMARY_MODULE_HINT_ORDER]);
    });

    test("includeSettlements=true returns the with-settlements STATIC order when no policy is supplied", () => {
      const result = resolvePrimaryModuleOrder(true);
      expect(result).toEqual([
        ...HISTORICAL_PRIMARY_MODULE_HINT_ORDER_WITH_SETTLEMENTS,
      ]);
    });

    test("explicit STATIC_PRIMARY_MODULE_ORDER_POLICY produces identical output to the no-policy path", () => {
      expect(resolvePrimaryModuleOrder(false, STATIC_PRIMARY_MODULE_ORDER_POLICY)).toEqual(
        resolvePrimaryModuleOrder(false),
      );
      expect(resolvePrimaryModuleOrder(true, STATIC_PRIMARY_MODULE_ORDER_POLICY)).toEqual(
        resolvePrimaryModuleOrder(true),
      );
    });

    test("null policy falls through to STATIC seed (defensive)", () => {
      expect(resolvePrimaryModuleOrder(false, null)).toEqual([
        ...HISTORICAL_PRIMARY_MODULE_HINT_ORDER,
      ]);
      expect(resolvePrimaryModuleOrder(true, null)).toEqual([
        ...HISTORICAL_PRIMARY_MODULE_HINT_ORDER_WITH_SETTLEMENTS,
      ]);
    });

    test("returns a fresh array each call (caller can mutate without poisoning the seed)", () => {
      const a = resolvePrimaryModuleOrder(false);
      const b = resolvePrimaryModuleOrder(false);
      expect(a).toEqual(b);
      expect(a).not.toBe(b);
      // Mutating one return value must NOT mutate the underlying seed.
      a.pop();
      expect(resolvePrimaryModuleOrder(false)).toEqual([
        ...HISTORICAL_PRIMARY_MODULE_HINT_ORDER,
      ]);
    });

    test("honors a per-tenant override (settlements before route)", () => {
      const override: PrimaryModuleOrderPolicyValue = {
        version: 1,
        order: ["settlements", "tasks", "route", "more"],
        order_with_settlements: ["settlements", "tasks", "route", "outbox", "more"],
      };
      expect(resolvePrimaryModuleOrder(false, override)).toEqual([
        "settlements",
        "tasks",
        "route",
        "more",
      ]);
      expect(resolvePrimaryModuleOrder(true, override)).toEqual([
        "settlements",
        "tasks",
        "route",
        "outbox",
        "more",
      ]);
    });
  });

  describe("normalizePrimaryModuleOrderPolicy (defensive parse)", () => {
    test("returns STATIC seed for null / undefined / non-object inputs", () => {
      const expected = STATIC_PRIMARY_MODULE_ORDER_POLICY;
      expect(normalizePrimaryModuleOrderPolicy(null)).toEqual(expected);
      expect(normalizePrimaryModuleOrderPolicy(undefined)).toEqual(expected);
      expect(normalizePrimaryModuleOrderPolicy("string")).toEqual(expected);
      expect(normalizePrimaryModuleOrderPolicy(123)).toEqual(expected);
      expect(normalizePrimaryModuleOrderPolicy(true)).toEqual(expected);
    });

    test("normalized output deep-clones STATIC arrays (caller mutation is safe)", () => {
      const out = normalizePrimaryModuleOrderPolicy(null);
      out.order.push("settlements");
      // Mutating `out.order` must not poison the STATIC seed.
      const fresh = normalizePrimaryModuleOrderPolicy(null);
      expect(fresh.order).toEqual([...HISTORICAL_PRIMARY_MODULE_HINT_ORDER]);
    });

    test("preserves a fully-valid policy body unchanged", () => {
      const input = {
        version: 2,
        order: ["tasks", "route", "scan", "more"],
        order_with_settlements: ["tasks", "route", "scan", "settlements", "more"],
      };
      const result = normalizePrimaryModuleOrderPolicy(input);
      expect(result.version).toBe(2);
      expect(result.order).toEqual(["tasks", "route", "scan", "more"]);
      expect(result.order_with_settlements).toEqual([
        "tasks",
        "route",
        "scan",
        "settlements",
        "more",
      ]);
    });

    test("drops unknown module keys (defensive against typos / future renames)", () => {
      const result = normalizePrimaryModuleOrderPolicy({
        version: 1,
        order: ["tasks", "moon-base", "route", "rocketship", "more"],
        order_with_settlements: ["tasks", "settlements", "more"],
      });
      expect(result.order).toEqual(["tasks", "route", "more"]);
      expect(result.order_with_settlements).toEqual(["tasks", "settlements", "more"]);
    });

    test("drops duplicate module keys (preserving first occurrence)", () => {
      const result = normalizePrimaryModuleOrderPolicy({
        version: 1,
        order: ["tasks", "route", "tasks", "more", "route"],
        order_with_settlements: ["tasks", "settlements", "tasks", "more"],
      });
      expect(result.order).toEqual(["tasks", "route", "more"]);
      expect(result.order_with_settlements).toEqual(["tasks", "settlements", "more"]);
    });

    test("trims whitespace around module keys before validation", () => {
      const result = normalizePrimaryModuleOrderPolicy({
        version: 1,
        order: ["  tasks  ", "route", " more "],
        order_with_settlements: ["tasks", "  settlements  ", "more"],
      });
      expect(result.order).toEqual(["tasks", "route", "more"]);
      expect(result.order_with_settlements).toEqual(["tasks", "settlements", "more"]);
    });

    test("drops non-string entries (numbers, nulls, objects)", () => {
      const result = normalizePrimaryModuleOrderPolicy({
        version: 1,
        order: ["tasks", 42, null, { key: "route" }, "more"],
        order_with_settlements: ["tasks", "settlements", undefined, "more"],
      });
      expect(result.order).toEqual(["tasks", "more"]);
      expect(result.order_with_settlements).toEqual(["tasks", "settlements", "more"]);
    });

    test("falls back to STATIC `order` when input order is not an array", () => {
      const result = normalizePrimaryModuleOrderPolicy({
        version: 1,
        order: "not-an-array",
        order_with_settlements: ["tasks", "settlements", "more"],
      });
      expect(result.order).toEqual([...HISTORICAL_PRIMARY_MODULE_HINT_ORDER]);
      expect(result.order_with_settlements).toEqual(["tasks", "settlements", "more"]);
    });

    test("falls back to STATIC `order` when input order has zero valid entries", () => {
      const result = normalizePrimaryModuleOrderPolicy({
        version: 1,
        order: ["typo-1", "typo-2", 42, null],
        order_with_settlements: ["tasks", "settlements", "more"],
      });
      expect(result.order).toEqual([...HISTORICAL_PRIMARY_MODULE_HINT_ORDER]);
    });

    test("falls back to STATIC `order_with_settlements` when input is malformed", () => {
      const result = normalizePrimaryModuleOrderPolicy({
        version: 1,
        order: ["tasks", "route", "more"],
        order_with_settlements: null,
      });
      expect(result.order).toEqual(["tasks", "route", "more"]);
      expect(result.order_with_settlements).toEqual([
        ...HISTORICAL_PRIMARY_MODULE_HINT_ORDER_WITH_SETTLEMENTS,
      ]);
    });

    test("uses default version=1 when version field is missing or invalid", () => {
      expect(
        normalizePrimaryModuleOrderPolicy({
          order: ["tasks", "more"],
          order_with_settlements: ["tasks", "settlements", "more"],
        }).version,
      ).toBe(1);
      expect(
        normalizePrimaryModuleOrderPolicy({
          version: "not-a-number",
          order: ["tasks", "more"],
          order_with_settlements: ["tasks", "settlements", "more"],
        }).version,
      ).toBe(1);
      expect(
        normalizePrimaryModuleOrderPolicy({
          version: NaN,
          order: ["tasks", "more"],
          order_with_settlements: ["tasks", "settlements", "more"],
        }).version,
      ).toBe(1);
    });

    test("normalized output is fully usable by resolvePrimaryModuleOrder", () => {
      const policy = normalizePrimaryModuleOrderPolicy({
        version: 1,
        order: ["settlements", "tasks", "route"],
        order_with_settlements: ["settlements", "tasks", "route", "outbox"],
      });
      expect(resolvePrimaryModuleOrder(false, policy)).toEqual([
        "settlements",
        "tasks",
        "route",
      ]);
      expect(resolvePrimaryModuleOrder(true, policy)).toEqual([
        "settlements",
        "tasks",
        "route",
        "outbox",
      ]);
    });
  });
});
