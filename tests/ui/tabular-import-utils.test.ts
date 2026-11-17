import {
  buildTabularHeaderFingerprint,
  detectWorkbookVisibleSheets,
  inferTabularFieldRules,
  matrixToTabularData,
  matrixToTabularPreview,
  parseCsvTextMatrix,
  prepareTabularRows,
  resolveImportAcceptedFormats,
  resolveWorkbookWorksheet,
  resolveTabularRuleMode,
  worksheetToMatrix,
  worksheetToTabularPreview,
} from "../../packages/api/src/tabular-import";

describe("tabular import utils", () => {
  const resource = {
    key: "recipients",
    relation: "public.recipients",
    import: {
      enabled: true,
      default_write_mode: "create",
      allow_upsert: true,
      identity_columns: ["external_id"],
      accepted_formats: ["csv", "xlsx"],
    },
    columns: [
      {
        key: "external_id",
        label: "External ID",
        edit_type: "text",
        import: {
          enabled: true,
          required: true,
          identity: true,
          aliases: ["Recipient External ID"],
        },
      },
      {
        key: "status",
        label: "Status",
        edit_type: "text",
        import: {
          enabled: true,
          aliases: ["Recipient Status"],
          enum_values: ["active", "inactive"],
        },
      },
      {
        key: "is_active",
        label: "Is Active",
        edit_type: "boolean",
        import: {
          enabled: true,
        },
      },
      {
        key: "tags",
        label: "Tags",
        edit_type: "array",
        import: {
          enabled: true,
        },
      },
    ],
  } as const;

  test("buildTabularHeaderFingerprint is order-insensitive", () => {
    expect(buildTabularHeaderFingerprint(["Status", "External ID"])).toBe(
      buildTabularHeaderFingerprint(["External ID", "Status"]),
    );
  });

  test("resolveImportAcceptedFormats defaults to CSV and XLSX only", () => {
    expect(resolveImportAcceptedFormats(null as any)).toEqual(["csv", "xlsx"]);
  });

  test("parseCsvTextMatrix preserves quoted cells and matrixToTabularData maps rows", () => {
    const matrix = parseCsvTextMatrix("External ID,Status\r\n\"ext,1\",active\r\n");

    expect(matrixToTabularData(matrix)).toEqual({
      headers: ["External ID", "Status"],
      rows: [{ "External ID": "ext,1", Status: "active" }],
    });
  });

  test("detectWorkbookVisibleSheets supports ExcelJS-style workbooks", () => {
    const visibleSheet = {
      name: "Visible",
      state: "visible",
      rowCount: 2,
      columnCount: 2,
      getRow: (index: number) => {
        const values = index === 1 ? ["External ID", "Status"] : ["ext-1", "active"];
        return {
          cellCount: values.length,
          actualCellCount: values.length,
          getCell: (columnIndex: number) => ({
            text: String(values[columnIndex - 1] ?? ""),
            value: values[columnIndex - 1] ?? "",
          }),
        };
      },
    };
    const workbook = {
      worksheets: [
        visibleSheet,
        {
          name: "Hidden",
          state: "hidden",
        },
      ],
      getWorksheet: (name: string) =>
        name === "Visible"
          ? visibleSheet
          : null,
    };

    expect(detectWorkbookVisibleSheets(workbook as any)).toEqual(["Visible"]);
    expect(resolveWorkbookWorksheet(workbook as any, "Visible")).toBe(visibleSheet);
    expect(matrixToTabularData(worksheetToMatrix(visibleSheet as any))).toEqual({
      headers: ["External ID", "Status"],
      rows: [{ "External ID": "ext-1", Status: "active" }],
    });
  });

  test("bounds worksheet preview extraction to 20 records while counting all 49 rows", () => {
    const reads: Array<[number, number]> = [];
    const sheet = {
      rowCount: 50,
      columnCount: 3,
      getRow: (row: number) => ({
        cellCount: 3,
        getCell: (column: number) => {
          reads.push([row, column]);
          if (row > 21 && column > 1) throw new Error("A count-only row was fully converted");
          return { text: row === 1 ? ["External ID", "Status", "Tags"][column - 1] : `${row - 1}-${column}` };
        },
      }),
    };
    const preview = worksheetToTabularPreview(sheet, 20);
    expect(preview.totalRows).toBe(49);
    expect(preview.rows).toHaveLength(20);
    expect(preview.rows[19]).toEqual({ "External ID": "20-1", Status: "20-2", Tags: "20-3" });
    expect(reads).toHaveLength(3 + 49 + 20 * 3);
    expect(reads.filter(([row]) => row > 21)).toEqual(Array.from({ length: 29 }, (_, index) => [index + 22, 1]));
  });

  test("preview totals match full parsing across blank, unnamed, formatted and typed cells", () => {
    const matrix = [
      [],
      ["External ID", "", "Status"],
      ["one", "ignored", "active"],
      [" ", "not an import row", "\t"],
      [false, "", ""],
      [0, "", ""],
      ["", "", "inactive"],
      [],
      [],
    ];
    const sheet = {
      rowCount: matrix.length,
      columnCount: 3,
      getRow: (index: number) => ({
        getCell: (column: number) => ({ value: matrix[index - 1]?.[column - 1] }),
      }),
    };
    const full = matrixToTabularData(worksheetToMatrix(sheet));
    expect(worksheetToTabularPreview(sheet, 2)).toEqual({
      headers: full.headers,
      rows: full.rows.slice(0, 2),
      totalRows: 4,
    });
    const csv = parseCsvTextMatrix('\uFEFFExternal ID,,Status\r\n"one,two",ignored,active\r\n ,ignored, \r\n0,,inactive\r\n');
    expect(matrixToTabularPreview(csv, 1)).toEqual({
      headers: ["External ID", "Status"],
      rows: [{ "External ID": "one,two", Status: "active" }],
      totalRows: 2,
    });
    expect(worksheetToTabularPreview(null, 20)).toEqual({ headers: [], rows: [], totalRows: 0 });
    expect(worksheetToTabularPreview({ ...sheet, getRow: () => ({ getCell: () => ({ text: " " }) }) }, 20))
      .toEqual({ headers: [], rows: [], totalRows: 0 });
  });

  test("full import conversion still includes records beyond the preview", () => {
    const matrix = [["External ID", "Status"], ...Array.from({ length: 49 }, (_, index) => [`ext-${index + 1}`, "active"])];
    const full = matrixToTabularData(matrix);
    expect(matrixToTabularPreview(matrix, 20).rows).toHaveLength(20);
    expect(full.rows).toHaveLength(49);
    const prepared = prepareTabularRows({
      rows: full.rows,
      rules: [
        { source_column: "External ID", target_field: "external_id" },
        { source_column: "Status", target_field: "status" },
      ],
      resource: resource as unknown as Parameters<typeof prepareTabularRows>[0]["resource"],
    });
    expect(prepared).toHaveLength(49);
    expect(prepared[34]).toMatchObject({ row_number: 35, mapped_row: { external_id: "ext-35", status: "active" } });
    expect(prepared[48]).toMatchObject({ row_number: 49, mapped_row: { external_id: "ext-49" } });
  });

  test("inferTabularFieldRules matches labels and aliases and reports missing required targets", () => {
    const result = inferTabularFieldRules(
      ["Recipient External ID", "Recipient Status"],
      resource as any,
    );

    expect(result.rules).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          source_column: "Recipient External ID",
          target_field: "external_id",
        }),
        expect.objectContaining({
          source_column: "Recipient Status",
          target_field: "status",
        }),
      ]),
    );
    expect(result.unmatched_headers).toEqual([]);
    expect(result.unresolved_targets).toEqual([]);
  });

  test("inferTabularFieldRules auto-maps related-node columns from registry inline-node contracts", () => {
    const registry = {
      resources: [
        {
          key: "recipients",
          label: "Recipients",
          relation: "public.recipients",
          import: {
            enabled: true,
            default_write_mode: "create",
            allow_upsert: true,
            identity_columns: ["external_id"],
          },
          columns: [
            {
              key: "name",
              label: "Name",
              edit_type: "text",
              import: { enabled: true, required: true },
            },
            {
              key: "phone_number",
              label: "Phone number",
              edit_type: "text",
              import: { enabled: true, required: true, aliases: ["phone"] },
            },
          ],
        },
        {
          key: "shipments",
          label: "Shipments",
          relation: "public.shipments",
          import: {
            enabled: true,
            default_write_mode: "create",
            allow_upsert: false,
          },
          columns: [
            {
              key: "tracking_number",
              label: "Tracking Number",
              edit_type: "text",
              import: { enabled: true, required: true, aliases: ["Tracking Number"] },
            },
            {
              key: "recipient_id",
              label: "Recipient",
              edit_type: "uuid",
              import: {
                enabled: true,
                reference: {
                  resource: "recipients",
                  allow_inline_node: true,
                  inline_node_key: "recipient",
                  inline_node_label: "Recipient",
                  mapping_prefixes: ["recipient"],
                  match_fields: ["phone_number"],
                  create_mode: "match_or_create",
                },
              },
            },
          ],
        },
      ],
    } as any;

    const result = inferTabularFieldRules(
      ["Tracking Number", "Recipient Name", "Recipient Phone"],
      registry.resources[1],
      registry,
    );

    expect(result.rules).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          source_column: "Tracking Number",
          target_field: "tracking_number",
        }),
        expect.objectContaining({
          source_column: "Recipient Name",
          target_field: "recipient.name",
        }),
        expect.objectContaining({
          source_column: "Recipient Phone",
          target_field: "recipient.phone_number",
        }),
      ]),
    );
    expect(result.unresolved_targets).toEqual([]);
  });

  test("inferTabularFieldRules activates related nodes from node-specific aliases without duplicating prefixes", () => {
    const registry = {
      resources: [
        {
          key: "addresses",
          label: "Addresses",
          relation: "public.addresses",
          import: {
            enabled: true,
            default_write_mode: "create",
          },
          columns: [
            {
              key: "normalized_line1",
              label: "Normalized line 1",
              edit_type: "text",
              import: { enabled: true, required: false, aliases: ["address_line_1", "street"] },
            },
            {
              key: "raw_input",
              label: "Raw input",
              edit_type: "text",
              import: { enabled: true, required: true, aliases: ["address", "address_line_1", "street"] },
            },
            {
              key: "city",
              label: "City",
              edit_type: "text",
              import: { enabled: true, required: false },
            },
          ],
        },
        {
          key: "shipments",
          label: "Shipments",
          relation: "public.shipments",
          import: {
            enabled: true,
            default_write_mode: "create",
            allow_upsert: false,
          },
          columns: [
            {
              key: "tracking_number",
              label: "Tracking Number",
              edit_type: "text",
              import: { enabled: true, required: true, aliases: ["Tracking Number"] },
            },
            {
              key: "destination_address_id",
              label: "Destination address",
              edit_type: "uuid",
              import: {
                enabled: true,
                reference: {
                  resource: "addresses",
                  allow_inline_node: true,
                  inline_node_key: "destination_address",
                  inline_node_label: "Destination address",
                  mapping_prefixes: ["destination_address", "destination", "address"],
                  create_mode: "match_or_create",
                },
              },
            },
          ],
        },
      ],
    } as any;

    const result = inferTabularFieldRules(
      ["Tracking Number", "Address Line 1", "City"],
      registry.resources[1],
      registry,
    );

    expect(result.rules).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          source_column: "Tracking Number",
          target_field: "tracking_number",
        }),
        expect.objectContaining({
          source_column: "Address Line 1",
          target_field: "destination_address.raw_input",
        }),
        expect.objectContaining({
          source_column: "City",
          target_field: "destination_address.city",
        }),
      ]),
    );
  });

  test("prepareTabularRows applies safe coercions and row diagnostics", () => {
    const result = prepareTabularRows({
      resource: resource as any,
      writeMode: "create",
      rules: [
        { source_column: "External ID", target_field: "external_id", enabled: true },
        { source_column: "Status", target_field: "status", enabled: true },
        { source_column: "Enabled", target_field: "is_active", enabled: true },
        { source_column: "Tag", target_field: "tags", enabled: true },
      ],
      rows: [
        {
          "External ID": " ext-1 ",
          Status: "Active",
          Enabled: "true",
          Tag: "priority",
        },
        {
          Status: "inactive",
          Enabled: "false",
          Tag: "follow-up",
        },
      ],
    });

    expect(result[0]).toEqual(
      expect.objectContaining({
        row_number: 1,
        action: "create",
        mapped_row: expect.objectContaining({
          external_id: "ext-1",
          status: "active",
          is_active: true,
          tags: ["priority"],
        }),
      }),
    );
    expect(result[0].coercions).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ target_field: "external_id" }),
        expect.objectContaining({ target_field: "status" }),
        expect.objectContaining({ target_field: "is_active" }),
        expect.objectContaining({ target_field: "tags" }),
      ]),
    );

    expect(result[1].action).toBe("block");
    expect(result[1].diagnostics).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: "required_field_missing",
          fieldPath: "external_id",
          blocking: true,
        }),
      ]),
    );
  });

  test("prepareTabularRows blocks invalid enum values with a clear diagnostic", () => {
    const result = prepareTabularRows({
      resource: resource as any,
      writeMode: "create",
      rules: [
        { source_column: "External ID", target_field: "external_id", enabled: true },
        { source_column: "Status", target_field: "status", enabled: true },
      ],
      rows: [
        {
          "External ID": "ext-invalid-status",
          Status: "archived",
        },
      ],
    });

    expect(result[0].action).toBe("block");
    expect(result[0].diagnostics).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: "enum_value_invalid",
          fieldPath: "status",
          blocking: true,
        }),
      ]),
    );
  });

  test("prepareTabularRows normalizes lookup labels into canonical values", () => {
    const result = prepareTabularRows({
      resource: {
        ...resource,
        columns: [
          {
            key: "external_id",
            label: "External ID",
            edit_type: "text",
            import: {
              enabled: true,
              required: true,
              identity: true,
              aliases: ["Recipient External ID"],
            },
          },
          {
            key: "status",
            label: "Status",
            edit_type: "text",
            import: {
              enabled: true,
              lookup: {
                category: "shipment_status",
                options: [
                  { value: "pending", label: "Pending" },
                  { value: "out_for_delivery", label: "Out for Delivery" },
                ],
              },
            },
          },
        ],
      } as any,
      writeMode: "create",
      rules: [
        { source_column: "External ID", target_field: "external_id", enabled: true },
        { source_column: "Status", target_field: "status", enabled: true },
      ],
      rows: [
        {
          "External ID": "ext-lookup-1",
          Status: "Out for delivery",
        },
      ],
    });

    expect(result[0]).toEqual(
      expect.objectContaining({
        action: "create",
        mapped_row: expect.objectContaining({
          external_id: "ext-lookup-1",
          status: "out_for_delivery",
        }),
      }),
    );
    expect(result[0].coercions).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          target_field: "status",
          converted_value: "out_for_delivery",
        }),
      ]),
    );
  });

  test("resolveTabularRuleMode respects an explicit source mode without a selected column yet", () => {
    expect(
      resolveTabularRuleMode({
        target_field: "status",
        value_mode: "source",
        source_column: "",
      }),
    ).toBe("source");
  });

  test("prepareTabularRows supports one shared value for all rows", () => {
    const result = prepareTabularRows({
      resource: resource as any,
      writeMode: "create",
      rules: [
        { source_column: "External ID", target_field: "external_id", enabled: true },
        { target_field: "status", value_mode: "fixed", fixed_value: "active", enabled: true },
      ],
      rows: [
        {
          "External ID": "ext-fixed-1",
        },
      ],
    });

    expect(result[0]).toEqual(
      expect.objectContaining({
        action: "create",
        mapped_row: expect.objectContaining({
          external_id: "ext-fixed-1",
          status: "active",
        }),
      }),
    );
    expect(result[0].coercions).toEqual([]);
  });
});
