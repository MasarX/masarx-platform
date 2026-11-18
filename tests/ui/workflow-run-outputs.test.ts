import {
  extractWorkflowRunOutputs,
  extractWorkflowRunOutputUrlsByPaths,
} from "../../packages/ui/src/workflow-run-outputs";

test("workflow outputs retain untrusted urls as inert entries", () => {
  const detail = {
    context: {
      trusted: "https://storage.example.com/label.pdf",
      untrusted: "https://storage.example.com.evil.test/phish",
      relative: "/console/downloads/label.pdf",
      relativeAuthority: "/\\evil.test/phish",
      controlledAuthority: "/\tevil.test/phish",
    },
  };
  const outputs = extractWorkflowRunOutputs(
    detail,
    new Set(["https://storage.example.com"])
  );

  expect(outputs).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        url: "https://storage.example.com/label.pdf",
        trustedUrl: "https://storage.example.com/label.pdf",
      }),
      expect.objectContaining({
        url: "https://storage.example.com.evil.test/phish",
        trustedUrl: null,
      }),
      expect.objectContaining({
        url: "/console/downloads/label.pdf",
        trustedUrl: "/console/downloads/label.pdf",
      }),
      expect.objectContaining({
        url: "/\\evil.test/phish",
        trustedUrl: null,
      }),
      expect.objectContaining({
        url: "/\tevil.test/phish",
        trustedUrl: null,
      }),
    ])
  );
});

test("configured workflow output paths return only trusted urls", () => {
  const detail = {
    context: {
      trusted: "https://storage.example.com/label.pdf",
      untrusted: "https://evil.test/phish",
      relative: "/console/downloads/label.pdf",
      relativeAuthority: "/\\evil.test/phish",
      controlledAuthority: "/\tevil.test/phish",
    },
  };

  expect(
    extractWorkflowRunOutputUrlsByPaths(
      detail,
      [
        "context.trusted",
        "context.untrusted",
        "context.relative",
        "context.relativeAuthority",
        "context.controlledAuthority",
      ],
      new Set(["https://storage.example.com"])
    )
  ).toEqual([
    "https://storage.example.com/label.pdf",
    "/console/downloads/label.pdf",
  ]);
});
