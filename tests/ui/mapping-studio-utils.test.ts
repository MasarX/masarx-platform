import {
  buildResourceSchema,
  buildReviewMappingConfig,
  buildRuntimeMappingConfig,
  inferTabularRules,
  normalizeRulesFromMappingConfig,
} from "../../packages/ui/src/mapping-studio/utils";

describe("mapping studio utils", () => {
  test("selected artifact overrides stale artifact metadata", () => {
    expect(buildRuntimeMappingConfig("webhook_inbound", [], null, { artifact: "api_outbound" }).artifact).toBe("webhook_inbound");
  });

  test("clearing primary uses remaining fallback paths without an empty JSONPath", () => {
    const rules = normalizeRulesFromMappingConfig({ field_mappings: { id: ["$.id", "$.legacy"] } });
    rules[0] = { ...rules[0], source_path: "" };
    expect(buildRuntimeMappingConfig("webhook_inbound", rules).field_mappings).toEqual({ id: ["$.legacy"] });
  });

  test("malformed fallback arrays fail explicitly instead of silently losing entries", () => {
    expect(() => normalizeRulesFromMappingConfig({ field_mappings: { id: ["$.id", 7] } })).toThrow("must all be strings");
  });

  test("roundtrips ordered fallback arrays and untouched mapping configuration without mutation", () => {
    const original = {
      version: 7,
      artifact: "webhook_inbound",
      field_mappings: { status: [" $.status ", "$.payload.status"], external_id: "$.id", empty: [] },
      transforms: { retained: { value: "$.value" } },
      metadata: { retained: true },
    };
    const before = JSON.stringify(original);
    const rules = normalizeRulesFromMappingConfig(original);
    const review = buildReviewMappingConfig("webhook_inbound", rules);
    expect(buildRuntimeMappingConfig("webhook_inbound", normalizeRulesFromMappingConfig(review), null, original)).toEqual(original);
    expect(JSON.stringify(original)).toBe(before);
  });

  test("editing a primary path preserves ordered fallbacks and unrelated configuration", () => {
    const original = { field_mappings: { status: ["$.status", "$.legacy", "$.backup"] }, metadata: { retained: true } };
    const rules = normalizeRulesFromMappingConfig(original);
    rules[0] = { ...rules[0], source_path: "$.new", target_field: "shipment_status" };
    expect(buildRuntimeMappingConfig("webhook_inbound", rules, null, original)).toEqual({
      version: 1, artifact: "webhook_inbound", metadata: { retained: true },
      field_mappings: { shipment_status: ["$.new", "$.legacy", "$.backup"] },
    });
    expect(original.field_mappings.status).toEqual(["$.status", "$.legacy", "$.backup"]);
  });

  test("removing an array rule does not resurrect it from the original mapping", () => {
    const original = { field_mappings: { status: ["$.status", "$.legacy"], id: "$.id" } };
    const rules = normalizeRulesFromMappingConfig(original).filter(rule => rule.target_field !== "status");
    expect(buildRuntimeMappingConfig("webhook_inbound", rules, null, original).field_mappings).toEqual({ id: "$.id" });
  });

  test("untouched transforms-only configuration does not gain an overriding empty field mapping", () => {
    const original = { version: 1, artifact: "webhook_inbound", transforms: { shipment: { id: "$.id" } } };
    expect(buildRuntimeMappingConfig("webhook_inbound", normalizeRulesFromMappingConfig(original), null, original)).toEqual(original);
  });

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
