import {
  formatDurationMs,
  formatJsonForUi,
  matchesWorkflowRunLogStep,
  normalizeWorkflowRunLogSteps,
  redactJsonForUi,
} from "../../packages/ui/src/workflow-run-logs-model";

describe("workflow run logs model", () => {
  it("formats durations for UI", () => {
    expect(formatDurationMs(null)).toBeNull();
    expect(formatDurationMs(-1)).toBeNull();
    expect(formatDurationMs(345)).toBe("345 ms");
    expect(formatDurationMs(1500)).toBe("1.5 s");
    expect(formatDurationMs(12_000)).toBe("12 s");
    expect(formatDurationMs(65_000)).toBe("1m 05s");
  });

  it("normalizes and sorts workflow run steps", () => {
    const steps = normalizeWorkflowRunLogSteps([
      { id: "step-b", sequence_order: 2, operation_name: "second_step", step_status: "failed" },
      { id: "step-a", sequence_order: 1, operation_name: "first_step", step_status: "completed" },
    ]);

    expect(steps.map((step) => step.id)).toEqual(["step-a", "step-b"]);
    expect(steps[0].status).toBe("completed");
    expect(steps[1].statusTone).toBe("danger");
  });

  it("redacts sensitive fields and token-like strings", () => {
    const jwtLike = "header.payload.signature";
    const longToken = "a".repeat(40);
    const input = {
      authorization: `Bearer ${longToken}`,
      nested: {
        api_key: "abc",
        token: jwtLike,
      },
      safe: "hello",
    };

    const redacted = redactJsonForUi(input);
    expect(redacted).toEqual({
      authorization: "[redacted]",
      nested: {
        api_key: "[redacted]",
        token: "[redacted]",
      },
      safe: "hello",
    });

    const formatted = formatJsonForUi(input);
    expect(formatted).toContain("[redacted]");
    expect(formatted).not.toContain(longToken);
  });

  it("matches run log step search queries", () => {
    const [step] = normalizeWorkflowRunLogSteps([
      {
        id: "step-1",
        sequence_order: 1,
        operation_name: "labels_print",
        step_status: "failed",
        last_error: "Something exploded",
        notes: "manual_review",
      },
    ]);

    expect(matchesWorkflowRunLogStep(step, "")).toBe(true);
    expect(matchesWorkflowRunLogStep(step, "labels")).toBe(true);
    expect(matchesWorkflowRunLogStep(step, "exploded")).toBe(true);
    expect(matchesWorkflowRunLogStep(step, "missing")).toBe(false);
  });
});

