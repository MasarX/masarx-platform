const fs = require("fs");
const path = require("path");
const { spawnSync } = require("child_process");

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
    expect(pkg.scripts["plans:review:auto"]).toBe(
      "node scripts/ops/plans/review-auto-compat.js"
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

  test("plans review compatibility wrapper forwards args to summarize", () => {
    const script = path.join(
      repoRoot,
      "scripts",
      "ops",
      "plans",
      "review-auto-compat.js"
    );
    const res = spawnSync(process.execPath, [script, "--help"], {
      cwd: repoRoot,
      encoding: "utf8",
    });
    const output = `${res.stdout || ""}\n${res.stderr || ""}`;

    expect(res.status).toBe(1);
    expect(output).toContain("delegating to plans:summarize");
    expect(output).toContain("Usage: plans:summarize");
  });
});
