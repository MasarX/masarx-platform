import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { withExclusiveE2EResourceLocks } from "../e2e/utils/e2e-resource-lock";

describe("e2e resource lock", () => {
  test("serializes access to the same lock key and releases the lock directory", async () => {
    const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), "masarx-e2e-lock-"));
    const order: string[] = [];
    let signalFirstLocked!: () => void;
    const firstLocked = new Promise<void>((resolve) => {
      signalFirstLocked = resolve;
    });
    let releaseFirst!: () => void;
    const firstCanFinish = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });

    const first = withExclusiveE2EResourceLocks({
      keys: ["shared-demo-operator"],
      rootDir,
      pollMs: 10,
      timeoutMs: 1_000,
      fn: async () => {
        order.push("first:start");
        signalFirstLocked();
        await firstCanFinish;
        order.push("first:end");
      },
    });

    await Promise.race([firstLocked, first]);
    const stat = fs.promises.stat;
    // The second caller checks for a stale lock only after its acquire hits the held lock.
    const checkHeldLock = jest.spyOn(fs.promises, "stat").mockImplementationOnce((...args) =>
      stat(...args).finally(releaseFirst),
    );
    const second = withExclusiveE2EResourceLocks({
      keys: ["shared-demo-operator"],
      rootDir,
      pollMs: 10,
      timeoutMs: 1_000,
      fn: async () => {
        order.push("second:start");
      },
    }).finally(releaseFirst);

    await Promise.all([first, second]).finally(() => checkHeldLock.mockRestore());

    expect(order).toEqual(["first:start", "first:end", "second:start"]);
    expect(fs.readdirSync(rootDir)).toEqual([]);

    fs.rmSync(rootDir, { recursive: true, force: true });
  });
});
