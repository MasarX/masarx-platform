import {
  buildResourceSchema,
  buildRuntimeMappingConfig,
  inferTabularRules,
  normalizeRulesFromMappingConfig,
} from "../../packages/ui/src/mapping-studio/utils";

describe("mapping studio utils", () => {
  test("buildResourceSchema derives primitive types from resource columns", () => {
    const schema = buildResourceSchema({
      key: "orders",
      relation: "public.orders",
      columns: [
        { key: "status", render_type: "text" },
        { key: "enabled", edit_type: "boolean" },
        { key: "count", edit_type: "integer" },
        { key: "sent_at", edit_type: "datetime" },
      ],
    } as any);

    expect(schema).toEqual({
      type: "object",
      properties: {
        status: { type: "string" },
        enabled: { type: "boolean" },
        count: { type: "integer" },
        sent_at: { type: "string", format: "date-time" },
      },
      required: [],
    });
  });

  test("inferTabularRules matches normalized column names to target schema properties", () => {
    const rules = inferTabularRules(
      ["Order ID", "Customer Phone", "Status"],
      {
        type: "object",
        properties: {
          order_id: { type: "string" },
          customer_phone: { type: "string" },
          missing_field: { type: "string" },
        },
      },
    );

    expect(rules).toEqual([
      expect.objectContaining({
        target_field: "order_id",
        source_path: "column:Order ID",
      }),
      expect.objectContaining({
        target_field: "customer_phone",
        source_path: "column:Customer Phone",
      }),
    ]);
  });

  test("normalizeRulesFromMappingConfig supports runtime field_mappings shape", () => {
    expect(
      normalizeRulesFromMappingConfig({
        field_mappings: {
          status: "$.status",
          external_id: "column:Order ID",
        },
      }),
    ).toEqual([
      expect.objectContaining({ target_field: "status", source_path: "$.status" }),
      expect.objectContaining({ target_field: "external_id", source_path: "column:Order ID" }),
    ]);
  });

  test("buildRuntimeMappingConfig keeps tabular fields and serializes webhook rules into field_mappings", () => {
    const rules = [
      { target_field: "status", source_path: "$.status" },
      { target_field: "external_id", source_column: "Order ID" },
    ];

    expect(buildRuntimeMappingConfig("tabular_import", rules, { target_resource_key: "shipments" })).toEqual({
      version: 1,
      artifact: "tabular_import",
      fields: [
        { target_field: "status", source_path: "$.status" },
        { target_field: "external_id", source_path: "column:Order ID" },
      ],
      target_resource_key: "shipments",
    });

    expect(buildRuntimeMappingConfig("webhook_inbound", rules)).toEqual({
      version: 1,
      artifact: "webhook_inbound",
      field_mappings: {
        status: "$.status",
        external_id: "column:Order ID",
      },
    });
  });
});
