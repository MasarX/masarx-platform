import * as fs from "fs";
import * as path from "path";

describe("pickup operations contract", () => {
  it("keeps pickup server reads on the canonical API RPC loaders", () => {
    const sourcePath = path.join(
      process.cwd(),
      "packages",
      "ui",
      "src",
      "pickup-page-shared.tsx",
    );
    const source = fs.readFileSync(sourcePath, "utf8");

    expect(source).toContain('rpc("pickup_requests_list_v1"');
    expect(source).toContain('rpc("pickup_waves_list_v1"');
    expect(source).toContain('rpc("pickup_failures_list_v1"');
    expect(source).not.toContain(".from(");
    expect(source).not.toContain("loadPublicViewRows");
  });
});
