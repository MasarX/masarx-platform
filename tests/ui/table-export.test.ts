import {
  buildCsv,
  toCsvRow,
  resolveColumnLabel,
  type ResourceColumn,
} from "../../packages/ui/src/table/columns";

// ---------------------------------------------------------------------------
// toCsvRow
// ---------------------------------------------------------------------------

describe("toCsvRow", () => {
  it("joins simple values with commas", () => {
    expect(toCsvRow(["a", "b", "c"])).toBe("a,b,c");
  });

  it("wraps values containing commas in double quotes", () => {
    expect(toCsvRow(["hello, world"])).toBe('"hello, world"');
  });

  it("wraps values containing newlines in double quotes", () => {
    expect(toCsvRow(["line1\nline2"])).toBe('"line1\nline2"');
  });

  it("escapes double quotes by doubling them", () => {
    expect(toCsvRow(['say "hello"'])).toBe('"say ""hello"""');
  });

  it("handles empty values", () => {
    expect(toCsvRow(["", "a", ""])).toBe(",a,");
  });

  it("handles carriage return characters", () => {
    expect(toCsvRow(["a\rb"])).toBe('"a\rb"');
  });
});

// ---------------------------------------------------------------------------
// buildCsv
// ---------------------------------------------------------------------------

describe("buildCsv", () => {
  const columns: ResourceColumn[] = [
    { key: "name", label: "Name" },
    { key: "status", label: "Status" },
    { key: "weight", label: "Weight" },
  ];

  it("generates CSV with header row and data rows", () => {
    const rows = [
      { name: "SHP-001", status: "active", weight: 10 },
      { name: "SHP-002", status: "pending", weight: 25 },
    ];
    const csv = buildCsv(rows, columns);
    const lines = csv.split("\r\n");

    expect(lines).toHaveLength(3); // 1 header + 2 data rows
    expect(lines[0]).toBe("Name,Status,Weight");
    expect(lines[1]).toContain("SHP-001");
    expect(lines[2]).toContain("SHP-002");
  });

  it("produces correct number of rows matching input data length", () => {
    const rows = Array.from({ length: 50 }, (_, i) => ({
      name: `Item-${i}`,
      status: "active",
      weight: i * 10,
    }));
    const csv = buildCsv(rows, columns);
    const lines = csv.split("\r\n");

    // 1 header + 50 data rows
    expect(lines).toHaveLength(51);
  });

  it("handles empty rows array with header only", () => {
    const csv = buildCsv([], columns);
    const lines = csv.split("\r\n");

    expect(lines).toHaveLength(1);
    expect(lines[0]).toBe("Name,Status,Weight");
  });

  it("handles missing column values gracefully", () => {
    const rows = [{ name: "SHP-001" }];
    const csv = buildCsv(rows, columns);
    const lines = csv.split("\r\n");

    expect(lines).toHaveLength(2);
    // Missing values should not throw; the row should still have correct column count
    const dataValues = lines[1]!.split(",");
    expect(dataValues).toHaveLength(3);
  });

  it("escapes values containing commas in CSV output", () => {
    const rows = [{ name: "Doe, Jane", status: "active", weight: 5 }];
    const csv = buildCsv(rows, columns);
    const lines = csv.split("\r\n");

    expect(lines[1]).toContain('"Doe, Jane"');
  });

  it("uses column labels as headers, not keys", () => {
    const labeledColumns: ResourceColumn[] = [
      { key: "shipment_id", label: "Shipment Reference" },
      { key: "org_name", label: "Organization" },
    ];
    const rows = [{ shipment_id: "ABC", org_name: "Acme" }];
    const csv = buildCsv(rows, labeledColumns);
    const header = csv.split("\r\n")[0]!;

    expect(header).toBe("Shipment Reference,Organization");
  });

  it("falls back to key-derived label when label is missing", () => {
    const noLabelColumns: ResourceColumn[] = [
      { key: "created_at" },
    ];
    const rows = [{ created_at: "2025-01-01" }];
    const csv = buildCsv(rows, noLabelColumns);
    const header = csv.split("\r\n")[0]!;

    // resolveColumnLabel uses labelFromKey which converts snake_case to Title Case
    expect(header).toBeTruthy();
    expect(header.length).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// resolveColumnLabel
// ---------------------------------------------------------------------------

describe("resolveColumnLabel", () => {
  it("returns the label when provided", () => {
    expect(resolveColumnLabel({ key: "name", label: "Full Name" })).toBe(
      "Full Name"
    );
  });

  it("strips trailing Id suffix from FK columns", () => {
    expect(
      resolveColumnLabel({ key: "organization_id", label: "Organization Id" })
    ).toBe("Organization");
  });

  it("does not strip Id from standalone id column", () => {
    const label = resolveColumnLabel({ key: "id", label: "Id" });
    // standalone "id" key should not be stripped
    expect(label).toBe("Id");
  });

  it("derives label from key when label is null", () => {
    const label = resolveColumnLabel({ key: "shipment_status", label: null });
    expect(label).toBeTruthy();
    expect(typeof label).toBe("string");
  });

  it("derives label from key when label is empty string", () => {
    const label = resolveColumnLabel({ key: "total_weight", label: "" });
    expect(label).toBeTruthy();
  });
});
