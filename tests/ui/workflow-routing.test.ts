import { resolveNextOperationRoute } from "../../packages/ui/src/workflow-routing";

test("resolveNextOperationRoute resolves unique targets", () => {
  const result = resolveNextOperationRoute({
    currentStepId: "step-1",
    nextOperationName: "second_op",
    matches: [{ index: 1, stepId: "step-2" }],
  });

  expect(result).toEqual({
    status: "target",
    match: { index: 1, stepId: "step-2" },
    indexes: [1],
  });
});

test("resolveNextOperationRoute flags self loops", () => {
  const result = resolveNextOperationRoute({
    currentStepId: "step-1",
    nextOperationName: "first_op",
    matches: [{ index: 0, stepId: "step-1" }],
  });

  expect(result.status).toBe("self");
});

test("resolveNextOperationRoute flags ambiguous routes", () => {
  const result = resolveNextOperationRoute({
    currentStepId: "step-1",
    nextOperationName: "second_op",
    matches: [
      { index: 1, stepId: "step-2" },
      { index: 2, stepId: "step-3" },
    ],
  });

  expect(result).toEqual({
    status: "ambiguous",
    match: null,
    indexes: [1, 2],
  });
});

test("resolveNextOperationRoute flags missing routes", () => {
  const result = resolveNextOperationRoute({
    currentStepId: "step-1",
    nextOperationName: "missing_op",
    matches: [],
  });

  expect(result).toEqual({
    status: "missing",
    match: null,
    indexes: [],
  });
});

test("resolveNextOperationRoute returns none when no next operation is configured", () => {
  const result = resolveNextOperationRoute({
    currentStepId: "step-1",
    nextOperationName: "",
    matches: [{ index: 1, stepId: "step-2" }],
  });

  expect(result).toEqual({
    status: "none",
    match: null,
    indexes: [],
  });
});
