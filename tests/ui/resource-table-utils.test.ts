import { resolveCellDisplay } from "../../packages/ui/src/table/resource-table-utils";
import type { ResourceColumn } from "../../packages/ui/src/table/columns";

describe("resolveCellDisplay", () => {
  it("prefers label candidates for id columns", () => {
    const column: ResourceColumn = { key: "sender_id" };
    const item = {
      sender_id: "1234567890abcdef",
      sender_name: "Acme Logistics",
    };
    const result = resolveCellDisplay(item, column, 140, ["name"]);
    expect(result.primary).toBe("Acme Logistics");
    expect(result.secondary).toBeNull();
  });

  it("uses global label keys for primary id column", () => {
    const column: ResourceColumn = { key: "id" };
    const item = {
      id: "abcdef1234567890",
      label: "Shipment A",
    };
    const result = resolveCellDisplay(item, column, 140, ["label"]);
    expect(result.primary).toBe("Shipment A");
    expect(result.secondary).toBeNull();
  });

  it("prefers business identifiers over UUIDs for primary id columns", () => {
    const column: ResourceColumn = { key: "id" };
    const item = {
      id: "e5e9f2ab-303a-4e1d-9b4b-7326a4f3e25c",
      tracking_number: "TESTB-62836344",
    };
    const result = resolveCellDisplay(item, column, 140, ["name"]);
    expect(result.primary).toBe("TESTB-62836344");
    expect(result.primaryTitle).toBe("TESTB-62836344");
    expect(result.secondary).toBeNull();
  });

  it("shows readable fallback references when no business identifier exists", () => {
    const column: ResourceColumn = { key: "id" };
    const item = {
      id: "e5e9f2ab-303a-4e1d-9b4b-7326a4f3e25c",
    };
    const result = resolveCellDisplay(item, column, 140, ["name"]);
    expect(result.primary).toBe("REF-E5E9E25C");
    expect(result.primaryTitle).toBeUndefined();
    expect(result.secondary).toBeNull();
  });

  it("shows descriptor text as secondary context for business identifiers", () => {
    const column: ResourceColumn = { key: "id" };
    const item = {
      id: "e5e9f2ab-303a-4e1d-9b4b-7326a4f3e25c",
      tracking_number: "TESTB-62836344",
      description: "Priority delivery lane",
    };
    const result = resolveCellDisplay(item, column, 140, ["name"], ["description"]);
    expect(result.primary).toBe("TESTB-62836344");
    expect(result.secondary).toBe("Priority delivery lane");
  });

  it("compacts long business identifiers while preserving full title", () => {
    const column: ResourceColumn = { key: "id" };
    const item = {
      id: "e5e9f2ab-303a-4e1d-9b4b-7326a4f3e25c",
      tracking_number: "LOAD-2-61-1770496616829",
    };
    const result = resolveCellDisplay(item, column, 140, ["name"]);
    expect(result.primary).toBe("LOAD-2-61-...616829");
    expect(result.primaryTitle).toBe("LOAD-2-61-1770496616829");
    expect(result.secondary).toBeNull();
  });

  it("shows internal UUID hints when enabled by config", () => {
    const column: ResourceColumn = { key: "id" };
    const item = {
      id: "e5e9f2ab-303a-4e1d-9b4b-7326a4f3e25c",
      tracking_number: "TESTB-62836344",
    };
    const result = resolveCellDisplay(item, column, 140, ["name"], [], true);
    expect(result.primary).toBe("TESTB-62836344");
    expect(result.secondary).toBe("e5e9...e25c");
  });

  it("formats UUID literals in non-id columns for operator readability", () => {
    const column: ResourceColumn = { key: "correlation_token" };
    const item = {
      correlation_token: "e5e9f2ab-303a-4e1d-9b4b-7326a4f3e25c",
    };
    const result = resolveCellDisplay(item, column, 140, ["name"]);
    expect(result.primary).toBe("REF-E5E9E25C");
    expect(result.primaryTitle).toBeUndefined();
    expect(result.secondary).toBeNull();
  });

  it("formats nested UUID values inside object cells before rendering", () => {
    const column: ResourceColumn = { key: "metadata" };
    const item = {
      metadata: {
        marketplace_contract_id: "e5e9f2ab-303a-4e1d-9b4b-7326a4f3e25c",
      },
    };
    const result = resolveCellDisplay(item, column, 140, ["name"]);
    expect(result.primary).toContain("REF-E5E9E25C");
    expect(result.primary).not.toContain("e5e9f2ab-303a-4e1d-9b4b-7326a4f3e25c");
    expect(String(result.primaryTitle ?? "")).not.toContain(
      "e5e9f2ab-303a-4e1d-9b4b-7326a4f3e25c",
    );
  });

  it("shows internal hints for UUID literals in non-id columns when enabled", () => {
    const column: ResourceColumn = { key: "correlation_token" };
    const item = {
      correlation_token: "e5e9f2ab-303a-4e1d-9b4b-7326a4f3e25c",
    };
    const result = resolveCellDisplay(item, column, 140, ["name"], [], true);
    expect(result.primary).toBe("REF-E5E9E25C");
    expect(result.secondary).toBe("e5e9...e25c");
  });
});
