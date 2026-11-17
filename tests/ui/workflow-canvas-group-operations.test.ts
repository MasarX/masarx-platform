import {
  groupOperationMatches,
  resolveOperationLabel,
  resolveOperationDescription,
  type OperationMatch,
} from "../../packages/ui/src/workflow-canvas/palette/group-operation-matches";

/* ---------------------------------------------------------------------------
 * Fixtures.
 * -------------------------------------------------------------------------*/

function createMatch(overrides: Partial<OperationMatch> = {}): OperationMatch {
  return {
    handlerKey: "handler_default",
    notes: null,
    docUrl: null,
    handlerSchema: null,
    handlerName: null,
    handlerVersion: null,
    uiLabel: null,
    uiCategory: null,
    uiDescription: null,
    configSchemaCategory: null,
    ...overrides,
  };
}

/* ---------------------------------------------------------------------------
 * Tests.
 * -------------------------------------------------------------------------*/

test("returns flat (no groups) for single schema", () => {
  const matches = [
    createMatch({ handlerKey: "a", handlerSchema: "same" }),
    createMatch({ handlerKey: "b", handlerSchema: "same" }),
  ];
  const result = groupOperationMatches(matches);
  expect(result.showGroups).toBe(false);
});

test("groups by schema when multiple schemas exist", () => {
  const matches = [
    createMatch({ handlerKey: "a", handlerSchema: "schema_1" }),
    createMatch({ handlerKey: "b", handlerSchema: "schema_2" }),
  ];
  const result = groupOperationMatches(matches);
  expect(result.showGroups).toBe(true);
  expect(result.groups).toHaveLength(2);
  expect(result.groups.map((g) => g.id).sort()).toEqual([
    "schema:schema_1",
    "schema:schema_2",
  ]);
});

test("groups by ui_category when categories are present", () => {
  const matches = [
    createMatch({ handlerKey: "a", uiCategory: "Messaging" }),
    createMatch({ handlerKey: "b", uiCategory: "Data" }),
    createMatch({ handlerKey: "c", uiCategory: "Messaging" }),
  ];
  const result = groupOperationMatches(matches);
  expect(result.showGroups).toBe(true);
  expect(result.groups).toHaveLength(2);
  const messagingGroup = result.groups.find((g) => g.label === "Messaging");
  expect(messagingGroup?.matches).toHaveLength(2);
});

test("ungrouped items are separate from groups", () => {
  const matches = [
    createMatch({ handlerKey: "a", uiCategory: "Cat" }),
    createMatch({ handlerKey: "b" }), // no category
  ];
  const result = groupOperationMatches(matches);
  expect(result.showGroups).toBe(true);
  expect(result.ungrouped).toHaveLength(1);
  expect(result.ungrouped[0]!.handlerKey).toBe("b");
});

test("resolveOperationLabel uses uiLabel when available", () => {
  const match = createMatch({ handlerKey: "my_handler", uiLabel: "My Handler" });
  expect(resolveOperationLabel(match)).toBe("My Handler");
});

test("resolveOperationLabel falls back to labelFromKey", () => {
  const match = createMatch({ handlerKey: "my_handler" });
  const label = resolveOperationLabel(match);
  // labelFromKey converts snake_case to Title Case
  expect(label).toBeTruthy();
  expect(typeof label).toBe("string");
});

test("resolveOperationDescription uses uiDescription when available", () => {
  const match = createMatch({ uiDescription: "My desc" });
  expect(resolveOperationDescription(match)).toBe("My desc");
});

test("resolveOperationDescription falls back to notes", () => {
  const match = createMatch({ notes: "Some notes" });
  expect(resolveOperationDescription(match)).toBe("Some notes");
});

test("resolveOperationDescription returns null when no description", () => {
  const match = createMatch({});
  expect(resolveOperationDescription(match)).toBeNull();
});

test("empty matches returns no groups", () => {
  const result = groupOperationMatches([]);
  expect(result.showGroups).toBe(false);
  expect(result.groups).toEqual([]);
  expect(result.ungrouped).toEqual([]);
});
