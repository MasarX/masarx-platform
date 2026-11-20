import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { withExclusiveE2EResourceLocks } from "../e2e/utils/e2e-resource-lock";

describe("e2e resource lock", () => {
  test("serializes access to the same lock key and releases the lock directory", async () => {
    const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), "masarx-e2e-lock-"));
    const order: string[] = [];

    const first = withExclusiveE2EResourceLocks({
      keys: ["shared-demo-operator"],
      rootDir,
      pollMs: 10,
      timeoutMs: 1_000,
      fn: async () => {
        order.push("first:start");
        await new Promise((resolve) => setTimeout(resolve, 75));
        order.push("first:end");
      },
    });

    await new Promise((resolve) => setTimeout(resolve, 15));

    const second = withExclusiveE2EResourceLocks({
      keys: ["shared-demo-operator"],
      rootDir,
      pollMs: 10,
      timeoutMs: 1_000,
      fn: async () => {
        order.push("second:start");
      },
    });

    await Promise.all([first, second]);

    expect(order).toEqual(["first:start", "first:end", "second:start"]);
    expect(fs.readdirSync(rootDir)).toEqual([]);

    fs.rmSync(rootDir, { recursive: true, force: true });
  });
});
