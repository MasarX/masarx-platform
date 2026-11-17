import { resolveWorkflowRunDestination } from "../../packages/ui/src/workflow-run-navigation";

describe("resolveWorkflowRunDestination", () => {
  it("returns workflow run route when correlation is missing", () => {
    expect(
      resolveWorkflowRunDestination({
        appBasePath: "/portal",
        result: { workflow_run_id: "run-1" },
      })
    ).toBe("/portal/workflows/runs/run-1");
  });

  it("prefers observability trace route when correlation id exists", () => {
    expect(
      resolveWorkflowRunDestination({
        appBasePath: "/console",
        result: {
          workflow_run_id: "run-1",
          correlation_id: "corr-abc",
        },
      })
    ).toBe("/console/observability/trace/corr-abc");
  });

  it("reads correlation from nested context and run details", () => {
    expect(
      resolveWorkflowRunDestination({
        appBasePath: "/portal/",
        result: {
          workflow_run: {
            id: "run-2",
            context: {
              correlation_id: "corr-xyz",
            },
          },
        },
      })
    ).toBe("/portal/observability/trace/corr-xyz");
  });

  it("returns null when app base is empty", () => {
    expect(
      resolveWorkflowRunDestination({
        appBasePath: "   ",
        result: { workflow_run_id: "run-1" },
      })
    ).toBeNull();
  });

  it("returns null when app base is unsafe", () => {
    expect(
      resolveWorkflowRunDestination({
        appBasePath: "//portal",
        result: { workflow_run_id: "run-1" },
      })
    ).toBeNull();
  });

  it("returns null when run id cannot be resolved", () => {
    expect(
      resolveWorkflowRunDestination({
        appBasePath: "/portal",
        result: { status: "workflow_started" },
      })
    ).toBeNull();
  });
});
