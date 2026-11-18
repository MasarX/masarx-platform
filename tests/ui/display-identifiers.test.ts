import { resolveDisplayIdentifier } from "../../packages/ui/src/display-identifiers";

describe("resolveDisplayIdentifier", () => {
  it("returns business identifier and ignores UUID-like values", () => {
    const item = {
      id: "00000000-0000-4000-8000-000000000101",
      tracking_number: "TESTB-62836344",
      public_id: "121e5acf-103b-4e1d-9b4b-7326a4f3e25c",
    };
    const result = resolveDisplayIdentifier(item, {
      fallback: item.id,
    });
    expect(result).toEqual({
      key: "tracking_number",
      label: "Tracking Number",
      value: "TESTB-62836344",
    });
  });

  it("returns null when all identifiers collapse to fallback", () => {
    const item = {
      id: "TESTB-62836344",
      tracking_number: "TESTB-62836344",
    };
    const result = resolveDisplayIdentifier(item, {
      fallback: item.id,
    });
    expect(result).toBeNull();
  });

  describe("skipGlobalFallback", () => {
    it("does not fall back to global DISPLAY_IDENTIFIER_KEYS when skipGlobalFallback is true", () => {
      const item = {
        id: "00000000-0000-4000-8000-000000000101",
        tracking_number: "EXAMPLE-TRACKING-001",
        client_id: "00000000-0000-4000-8000-000000000102",
      };
      const result = resolveDisplayIdentifier(item, {
        fallback: String(item.client_id),
        preferredKeys: ["client_display_id", "client_name"],
        skipGlobalFallback: true,
      });
      // Should return null because preferred keys don't exist and global fallback is skipped
      expect(result).toBeNull();
    });

    it("still uses global fallback when skipGlobalFallback is false", () => {
      const item = {
        id: "00000000-0000-4000-8000-000000000101",
        tracking_number: "EXAMPLE-TRACKING-001",
        client_id: "00000000-0000-4000-8000-000000000102",
      };
      const result = resolveDisplayIdentifier(item, {
        fallback: String(item.client_id),
        preferredKeys: ["client_display_id", "client_name"],
        skipGlobalFallback: false,
      });
      // Without skipGlobalFallback, it falls through to tracking_number
      expect(result).toEqual({
        key: "tracking_number",
        label: "Tracking Number",
        value: "EXAMPLE-TRACKING-001",
      });
    });

    it("returns preferred key value when it exists even with skipGlobalFallback", () => {
      const item = {
        id: "00000000-0000-4000-8000-000000000101",
        tracking_number: "EXAMPLE-TRACKING-001",
        client_id: "00000000-0000-4000-8000-000000000102",
        client_name: "Example Client",
      };
      const result = resolveDisplayIdentifier(item, {
        fallback: String(item.client_id),
        preferredKeys: ["client_display_id", "client_name"],
        skipGlobalFallback: true,
      });
      expect(result).toEqual({
        key: "client_name",
        label: "Client Name",
        value: "Example Client",
      });
    });

    it("defaults skipGlobalFallback to false when not provided", () => {
      const item = {
        tracking_number: "EXAMPLE-TRACKING-001",
        client_id: "00000000-0000-4000-8000-000000000102",
      };
      const result = resolveDisplayIdentifier(item, {
        fallback: String(item.client_id),
        preferredKeys: ["client_display_id", "client_name"],
      });
      // Default behavior includes global fallback
      expect(result).toEqual({
        key: "tracking_number",
        label: "Tracking Number",
        value: "EXAMPLE-TRACKING-001",
      });
    });
  });
});
