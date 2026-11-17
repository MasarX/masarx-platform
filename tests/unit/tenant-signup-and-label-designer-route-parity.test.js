const fs = require("fs");
const path = require("path");

const repoRoot = path.resolve(__dirname, "..", "..");

function readRepoFile(relativePath) {
  return fs.readFileSync(path.join(repoRoot, relativePath), "utf8");
}

describe("console/portal route parity and tenant signup queue route wiring", () => {
  test("console label designer route uses shared page with console test id prefix", () => {
    const body = readRepoFile("apps/console/app/labels/designer/page.tsx");
    expect(body).toContain("LabelDesignerPage");
    expect(body).toContain('testIdPrefix="console-label-designer"');
  });

  test("portal label designer route uses shared page with portal test id prefix", () => {
    const body = readRepoFile("apps/portal/app/labels/designer/page.tsx");
    expect(body).toContain("LabelDesignerPage");
    expect(body).toContain('testIdPrefix="portal-label-designer"');
  });

  test("console organizations requests route points to tenant signup queue page", () => {
    const body = readRepoFile("apps/console/app/organizations/requests/page.tsx");
    expect(body).toContain("TenantSignupRequestsPage");
    expect(body).toContain('baseHref={`${appBasePath}/organizations/requests`}');
    expect(body).toContain('testIdPrefix="console-organization-requests"');
  });
});
