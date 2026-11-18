import { resolveSafeAppBasePath } from "../../packages/ui/src/url-guard";
import { resolveWorkflowRunDestination } from "../../packages/ui/src/workflow-run-navigation";

describe("resolveWorkflowRunDestination", () => {
  it.each([
    {
      result: { workflow_run_id: "run/1?x#" },
      expected: "/workflows/runs/run%2F1%3Fx%23",
    },
    {
      result: { workflow_run_id: "run-1", correlation_id: "corr/abc?x#" },
      expected: "/observability/trace/corr%2Fabc%3Fx%23",
    },
  ])("composes normalized root base with encoded destination $expected", ({ result, expected }) => {
    const appBasePath = resolveSafeAppBasePath("/");
    expect(appBasePath).toBe("");
    if (appBasePath === null) throw new Error("Root base must normalize safely");
    expect(resolveWorkflowRunDestination({ appBasePath, result })).toBe(expected);
  });


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

  it("supports root-mounted apps when correlation is missing", () => {
    expect(
      resolveWorkflowRunDestination({
        appBasePath: "/",
        result: { workflow_run_id: "run-1" },
      })
    ).toBe("/workflows/runs/run-1");
  });

  it("supports root-mounted apps when correlation id exists", () => {
    expect(
      resolveWorkflowRunDestination({
        appBasePath: "/",
        result: {
          workflow_run_id: "run-1",
          correlation_id: "corr-abc",
        },
      })
    ).toBe("/observability/trace/corr-abc");
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

  it("returns null when app base is whitespace-only", () => {
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
