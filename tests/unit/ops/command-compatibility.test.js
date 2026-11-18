const fs = require("fs");
const path = require("path");

const repoRoot = path.resolve(__dirname, "..", "..", "..");

describe("command compatibility", () => {
  test("package scripts expose frontend compatibility aliases", () => {
    const pkg = JSON.parse(
      fs.readFileSync(path.join(repoRoot, "package.json"), "utf8")
    );
    expect(pkg.scripts["typecheck:frontend"]).toBe(
      "npm --prefix apps/console run typecheck && npm --prefix apps/portal run typecheck"
    );
    expect(pkg.scripts["check:bundle-budgets"]).toBe(
      "node scripts/frontend/check-bundle-budgets.js"
    );
    expect(pkg.scripts["check:bundle-budgets:write"]).toBe(
      "node scripts/frontend/check-bundle-budgets.js --write"
    );
    expect(pkg.scripts["analyze:frontend"]).toBe(
      "npm --prefix apps/console run build && npm --prefix apps/portal run build && npm run check:bundle-budgets"
    );
  });

  test("bundle budget script reports concise failure messages", () => {
    const body = fs.readFileSync(
      path.join(repoRoot, "scripts", "frontend", "check-bundle-budgets.js"),
      "utf8"
    );
    expect(body).toContain("Bundle budget check failed:");
    expect(body).toContain("process.exitCode = 1;");
  });

});
