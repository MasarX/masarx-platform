import {
  extractCapabilityDeniedKey,
  isCapabilityDeniedMessage,
} from "../../packages/ui/src/utils";

describe("capability denied utils", () => {
  it("detects capability denied marker", () => {
    expect(isCapabilityDeniedMessage("Capability denied: access_policy.request")).toBe(
      true
    );
    expect(
      isCapabilityDeniedMessage("Missing required capability: settings.request.write")
    ).toBe(true);
    expect(
      isCapabilityDeniedMessage("Permission denied for capability labels.print")
    ).toBe(true);
    expect(isCapabilityDeniedMessage("Other error")).toBe(false);
  });

  it("extracts capability key from supported denied formats", () => {
    expect(
      extractCapabilityDeniedKey("Capability denied: access_policy.request")
    ).toBe("access_policy.request");
    expect(
      extractCapabilityDeniedKey(
        "Missing required capability: settings.request.write"
      )
    ).toBe("settings.request.write");
    expect(
      extractCapabilityDeniedKey("Requires workflow_runs.write capability.")
    ).toBe("workflow_runs.write");
    expect(
      extractCapabilityDeniedKey("Permission denied for capability labels.print")
    ).toBe("labels.print");
  });

  it("returns null when denied message does not include a capability key", () => {
    expect(extractCapabilityDeniedKey("Capability denied")).toBeNull();
    expect(extractCapabilityDeniedKey("Access denied for this scope")).toBeNull();
  });
});
