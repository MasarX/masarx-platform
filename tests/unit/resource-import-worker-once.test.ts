jest.mock("child_process", () => ({ execFileSync: jest.fn() }));

import { execFileSync } from "child_process";
import {
  DEFAULT_TABULAR_IMPORT_WORKER_ONCE_TIMEOUT_MS,
  runTabularImportWorkerOnce,
} from "../e2e/utils/resource-import";

const spawn = jest.mocked(execFileSync);

beforeEach(() => {
  spawn.mockReset();
});

test("uses the receiving one-shot worker command with a bounded timeout", () => {
  runTabularImportWorkerOnce({ timeoutMs: 0 });
  expect(spawn).toHaveBeenCalledWith(
    process.execPath,
    ["scripts/workers/tabular-import-worker.js", "--once"],
    expect.objectContaining({
      stdio: "inherit",
      timeout: DEFAULT_TABULAR_IMPORT_WORKER_ONCE_TIMEOUT_MS,
    }),
  );
});

test("reports the configured timeout when the worker exceeds it", () => {
  spawn.mockImplementation(() => {
    throw Object.assign(new Error("Timed out"), { code: "ETIMEDOUT" });
  });
  expect(() => runTabularImportWorkerOnce({ timeoutMs: 4321 }))
    .toThrow("Tabular import worker --once exceeded its 4321ms timeout.");
});

test("passes the requested run ID to the bounded worker command", () => {
  const runId = "53e4a41b-06de-431b-8332-f0f3f7c14a26";
  runTabularImportWorkerOnce({ runId, timeoutMs: 4321 });
  expect(spawn).toHaveBeenCalledWith(
    process.execPath,
    ["scripts/workers/tabular-import-worker.js", "--once", "--run-id", runId],
    expect.objectContaining({ timeout: 4321 }),
  );
});

test("preserves a non-timeout worker failure", () => {
  const failure = new Error("Fixture worker failed");
  spawn.mockImplementation(() => { throw failure; });
  expect(() => runTabularImportWorkerOnce({ timeoutMs: 4321 })).toThrow(failure);
});
