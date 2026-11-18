// Mobile V2 incident-type registry parser unit coverage.
//
// Engineering audit B1 / I2: the incident sheet's type registry was a
// PREVIEW/DEV fixture only and `submit_fieldops_incident_v1` had no
// callers. The registry now resolves via `mobile_incident_policy`; this
// suite covers the defensive parser that shape-validates the resolver
// payload before it reaches the sheet.

import {
  parseMobileV2IncidentType,
  parseMobileV2IncidentTypeList,
} from "../../../apps/fieldops/src/mobile-v2-incident-types";

describe("parseMobileV2IncidentType", () => {
  test("parses a fully-specified incident type row", () => {
    const parsed = parseMobileV2IncidentType({
      id: "collision",
      label: "Vehicle collision",
      icon: "alert",
      severity: "high",
      needs: ["photo", "geo", "statement"],
    });
    expect(parsed).toEqual({
      id: "collision",
      label: "Vehicle collision",
      icon: "alert",
      severity: "high",
      needs: ["photo", "geo", "statement"],
    });
  });

  test("returns null when id or label is missing", () => {
    expect(parseMobileV2IncidentType({ label: "x", icon: "alert" })).toBeNull();
    expect(parseMobileV2IncidentType({ id: "x", icon: "alert" })).toBeNull();
  });

  test("returns null for non-object input", () => {
    expect(parseMobileV2IncidentType(null)).toBeNull();
    expect(parseMobileV2IncidentType("collision")).toBeNull();
    expect(parseMobileV2IncidentType(["collision"])).toBeNull();
  });

  test("falls back to the `alert` icon for an unknown glyph", () => {
    const parsed = parseMobileV2IncidentType({
      id: "x",
      label: "X",
      icon: "not-a-real-icon",
      severity: "low",
    });
    expect(parsed?.icon).toBe("alert");
  });

  test("falls back to `med` severity for an invalid severity", () => {
    const parsed = parseMobileV2IncidentType({
      id: "x",
      label: "X",
      icon: "alert",
      severity: "catastrophic",
    });
    expect(parsed?.severity).toBe("med");
  });

  test("drops unknown / duplicate needs entries", () => {
    const parsed = parseMobileV2IncidentType({
      id: "x",
      label: "X",
      icon: "alert",
      severity: "high",
      needs: ["photo", "photo", "call_111", "statement", 42],
    });
    expect(parsed?.needs).toEqual(["photo", "statement"]);
  });

  test("defaults needs to an empty array when absent or wrong-typed", () => {
    expect(
      parseMobileV2IncidentType({ id: "x", label: "X", icon: "alert" })?.needs,
    ).toEqual([]);
    expect(
      parseMobileV2IncidentType({
        id: "x",
        label: "X",
        icon: "alert",
        needs: "photo",
      })?.needs,
    ).toEqual([]);
  });
});

describe("parseMobileV2IncidentTypeList", () => {
  test("parses a bare array of rows", () => {
    const list = parseMobileV2IncidentTypeList([
      { id: "a", label: "A", icon: "alert", severity: "low", needs: [] },
      { id: "b", label: "B", icon: "shield", severity: "high", needs: ["statement"] },
    ]);
    expect(list.map((t) => t.id)).toEqual(["a", "b"]);
  });

  test("parses the `mobile_incident_policy` value envelope shape (types[])", () => {
    const list = parseMobileV2IncidentTypeList({
      version: 1,
      types: [
        { id: "collision", label: "Vehicle collision", icon: "alert", severity: "high", needs: ["photo"] },
      ],
    });
    expect(list).toHaveLength(1);
    expect(list[0]?.id).toBe("collision");
  });

  test("drops malformed rows but keeps valid ones", () => {
    const list = parseMobileV2IncidentTypeList([
      { id: "ok", label: "OK", icon: "alert", severity: "med", needs: [] },
      { label: "missing-id" },
      null,
      "garbage",
    ]);
    expect(list.map((t) => t.id)).toEqual(["ok"]);
  });

  test("returns a frozen empty array for a malformed payload", () => {
    const empty = parseMobileV2IncidentTypeList("nope");
    expect(empty).toEqual([]);
    expect(Object.isFrozen(empty)).toBe(true);
    expect(parseMobileV2IncidentTypeList(null)).toEqual([]);
    expect(parseMobileV2IncidentTypeList({ version: 1 })).toEqual([]);
  });
});
