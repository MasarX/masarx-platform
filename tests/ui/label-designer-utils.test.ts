import {
  firstParam,
  asText,
  shortId,
  formatJson,
  parseJsonObject,
  safeObject,
  parseDraftRows,
  parseShipmentOptions,
  parseShipmentBoxOptions,
  parseScopeOptions,
  isDraftStatus,
  parseScopeKey,
} from "../../packages/ui/src/label-designer/utils";

describe("label-designer/utils", () => {
  describe("firstParam", () => {
    it("returns first element of array", () => {
      expect(firstParam(["a", "b"])).toBe("a");
    });
    it("returns string as-is", () => {
      expect(firstParam("hello")).toBe("hello");
    });
    it("returns empty string for undefined", () => {
      expect(firstParam(undefined)).toBe("");
    });
    it("returns empty string for empty array", () => {
      expect(firstParam([])).toBe("");
    });
  });

  describe("asText", () => {
    it("trims string", () => {
      expect(asText("  foo  ")).toBe("foo");
    });
    it("returns empty for non-string", () => {
      expect(asText(123)).toBe("");
      expect(asText(null)).toBe("");
      expect(asText(undefined)).toBe("");
    });
  });

  describe("shortId", () => {
    it("returns first 8 chars", () => {
      expect(shortId("abcdefghijklmnop")).toBe("abcdefgh");
    });
    it("handles shorter strings", () => {
      expect(shortId("abc")).toBe("abc");
    });
  });

  describe("formatJson", () => {
    it("formats object to JSON", () => {
      expect(formatJson({ a: 1 })).toBe('{\n  "a": 1\n}');
    });
    it("handles null/undefined", () => {
      expect(formatJson(null)).toBe("{}");
      expect(formatJson(undefined)).toBe("{}");
    });
  });

  describe("parseJsonObject", () => {
    it("parses valid JSON object", () => {
      expect(parseJsonObject('{"a": 1}')).toEqual({ a: 1 });
    });
    it("returns empty object for invalid JSON", () => {
      expect(parseJsonObject("not json")).toEqual({});
    });
    it("returns empty object for array JSON", () => {
      expect(parseJsonObject("[1,2]")).toEqual({});
    });
  });

  describe("safeObject", () => {
    it("returns object as-is", () => {
      const obj = { a: 1 };
      expect(safeObject(obj)).toBe(obj);
    });
    it("returns empty for non-objects", () => {
      expect(safeObject(null)).toEqual({});
      expect(safeObject(undefined)).toEqual({});
      expect(safeObject("string")).toEqual({});
      expect(safeObject([1, 2])).toEqual({});
    });
  });

  describe("parseDraftRows", () => {
    it("parses valid draft rows", () => {
      const rows = [
        {
          id: "draft-1",
          scope_type: "tenant",
          scope_id: "org-1",
          label_type: "shipping",
          draft_name: "My Draft",
          draft_value: { blocks: [] },
          status: "draft",
          updated_at: "2025-01-01",
          published_at: null,
        },
      ];
      const result = parseDraftRows(rows);
      expect(result).toHaveLength(1);
      expect(result[0]!.id).toBe("draft-1");
      expect(result[0]!.draft_name).toBe("My Draft");
    });
    it("filters out invalid rows", () => {
      expect(parseDraftRows([{ id: "", scope_type: "tenant", scope_id: "x" }])).toEqual([]);
      expect(parseDraftRows([{ id: "x", scope_type: "", scope_id: "x" }])).toEqual([]);
    });
    it("returns empty for non-array", () => {
      expect(parseDraftRows("not array")).toEqual([]);
      expect(parseDraftRows(null)).toEqual([]);
    });
  });

  describe("parseShipmentOptions", () => {
    it("parses shipments with tracking numbers", () => {
      const result = parseShipmentOptions([
        { id: "ship-1", tracking_number: "TRK123", status: "pending" },
      ]);
      expect(result).toHaveLength(1);
      expect(result[0]!.label).toContain("TRK123");
    });
    it("falls back to short ID when no tracking", () => {
      const result = parseShipmentOptions([
        { id: "abcdefghijklmnop" },
      ]);
      expect(result[0]!.label).toContain("abcdefgh");
    });
    it("handles non-array input", () => {
      expect(parseShipmentOptions(null)).toEqual([]);
    });
  });

  describe("parseShipmentBoxOptions", () => {
    it("parses boxes with number and barcode", () => {
      const result = parseShipmentBoxOptions([
        { id: "box-1", box_number: 1, barcode: "BC001" },
      ]);
      expect(result).toHaveLength(1);
      expect(result[0]!.label).toContain("Box 1");
      expect(result[0]!.label).toContain("BC001");
    });
    it("handles non-array input", () => {
      expect(parseShipmentBoxOptions("bad")).toEqual([]);
    });
  });

  describe("parseScopeOptions", () => {
    it("always includes tenant option", () => {
      const result = parseScopeOptions({
        organizationId: "org-123456789",
        clients: [],
        senders: [],
      });
      expect(result).toHaveLength(1);
      expect(result[0]!.scopeType).toBe("tenant");
    });
    it("includes clients and senders", () => {
      const result = parseScopeOptions({
        organizationId: "org-1",
        clients: [{ id: "cl-1", name: "Client A" }],
        senders: [{ id: "sn-1", name: "Sender B" }],
      });
      expect(result).toHaveLength(3);
      expect(result[1]!.scopeType).toBe("client");
      expect(result[2]!.scopeType).toBe("sender");
    });
  });

  describe("isDraftStatus", () => {
    it("returns true for draft", () => {
      expect(isDraftStatus("draft")).toBe(true);
      expect(isDraftStatus("  Draft  ")).toBe(true);
      expect(isDraftStatus("DRAFT")).toBe(true);
    });
    it("returns false for other statuses", () => {
      expect(isDraftStatus("published")).toBe(false);
      expect(isDraftStatus("validated")).toBe(false);
    });
  });

  describe("parseScopeKey", () => {
    it("parses valid scope keys", () => {
      expect(parseScopeKey("tenant:org-1")).toBe("tenant:org-1");
      expect(parseScopeKey("client:cl-1")).toBe("client:cl-1");
      expect(parseScopeKey("sender:sn-1")).toBe("sender:sn-1");
    });
    it("normalizes case", () => {
      expect(parseScopeKey("Tenant:ORG-1")).toBe("tenant:ORG-1");
    });
    it("returns null for invalid inputs", () => {
      expect(parseScopeKey(null)).toBeNull();
      expect(parseScopeKey("")).toBeNull();
      expect(parseScopeKey("unknown:x")).toBeNull();
      expect(parseScopeKey("tenant:")).toBeNull();
    });
  });
});
