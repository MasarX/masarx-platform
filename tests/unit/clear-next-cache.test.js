const assert = require("node:assert/strict");
const { execFileSync } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const script = path.resolve(__dirname, "../../scripts/tests/clear-next-cache.js");

test("clears the selected application cache and preserves its sibling", () => {
  const parent = fs.realpathSync(os.tmpdir());
  const root = fs.mkdtempSync(path.join(parent, "next-cache-test-"));
  assert.equal(path.dirname(fs.realpathSync(root)), parent);
  const selectedCache = path.join(root, "selected", ".next");
  const siblingCache = path.join(root, "sibling", ".next");
  try {
    fs.mkdirSync(selectedCache, { recursive: true });
    fs.mkdirSync(siblingCache, { recursive: true });
    fs.writeFileSync(path.join(selectedCache, "cache"), "fixture");
    fs.writeFileSync(path.join(siblingCache, "cache"), "fixture");

    execFileSync(process.execPath, [script, "selected"], {
      cwd: root,
      timeout: 5000,
      windowsHide: true,
    });

    expect(fs.existsSync(selectedCache)).toBe(false);
    expect(fs.readFileSync(path.join(siblingCache, "cache"), "utf8")).toBe("fixture");
  } finally {
    assert.equal(path.dirname(fs.realpathSync(root)), parent);
    fs.rmSync(root, { recursive: true, force: true });
  }
});
