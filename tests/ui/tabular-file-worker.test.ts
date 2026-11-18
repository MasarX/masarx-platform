import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import ts from "typescript";
import { parseTabularFile, parseTabularFileBuffer } from "../../packages/ui/src/tabular-file";

// Jest is CommonJS; replace only the bundler's worker URL base when exercising the real client.
const source = fs.readFileSync(path.join(process.cwd(), "packages/ui/src/resource-import/tabular-file-parser-worker-client.ts"), "utf8")
  .replace("import.meta.url", JSON.stringify("https://example.test/parser.js"));
const compiled = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;

function client(workerAvailable = true, creationFailure = false) {
  const fallback = jest.fn().mockResolvedValue({ rows: [] });
  const workers: Array<{ onmessage?: (event: unknown) => void; onerror?: () => void; postMessage: jest.Mock; terminate: jest.Mock }> = [];
  class WorkerMock {
    onmessage?: (event: unknown) => void;
    onerror?: () => void;
    postMessage = jest.fn();
    terminate = jest.fn();
    constructor() {
      if (creationFailure) throw new Error("CSP worker unavailable");
      workers.push(this);
    }
  }
  const exports: { parseTabularFileWithWorker?: (file: unknown, sheet?: string, signal?: AbortSignal) => Promise<unknown> } = {};
  vm.runInNewContext(compiled, {
    exports, require: () => ({ parseTabularFile: fallback }),
    Worker: workerAvailable ? WorkerMock : undefined,
    URL, DOMException, setTimeout, clearTimeout,
  });
  return { parse: exports.parseTabularFileWithWorker!, workers, fallback };
}

const file = () => ({ name: "orders.csv", arrayBuffer: jest.fn().mockResolvedValue(new ArrayBuffer(8)) });
async function settleBufferRead() {
  for (let turn = 0; turn < 8; turn += 1) await Promise.resolve();
}

test.each([false, true])("falls back only when workers cannot be created (%s)", async (creationFailure) => {
  const value = client(creationFailure, creationFailure);
  const input = file();
  await value.parse(input, "Sheet2");
  expect(value.fallback).toHaveBeenCalledWith(input, "Sheet2");
});

test("transfers exact bytes, preserves bounded preview and total, and terminates each independent worker", async () => {
  const value = client();
  const first = value.parse(file(), "Sheet2");
  const second = value.parse(file());
  await settleBufferRead();
  const parsed = { rows: Array.from({ length: 20 }, (_, index) => ({ index })), totalRows: 49 };
  expect(value.workers[0].postMessage.mock.calls[0][0]).toMatchObject({ fileName: "orders.csv", preferredSheet: "Sheet2" });
  expect(value.workers[0].postMessage.mock.calls[0][1][0]).toBe(value.workers[0].postMessage.mock.calls[0][0].buffer);
  value.workers[1].onmessage?.({ data: { ok: true, parsed } });
  value.workers[0].onmessage?.({ data: { ok: true, parsed } });
  await expect(first).resolves.toBe(parsed);
  await expect(second).resolves.toBe(parsed);
  value.workers.forEach((worker) => expect(worker.terminate).toHaveBeenCalledTimes(1));
});

test.each(["csv", "xlsx"])("the real worker and fallback produce the same bounded %s preview", async (format) => {
  const rows = [["External ID", "Status"], ...Array.from({ length: 49 }, (_, index) => [`ext-${index + 1}`, "active"])];
  let bytes = new TextEncoder().encode(rows.map((row) => row.join(",")).join("\n"));
  if (format === "xlsx") {
    const { Workbook } = jest.requireActual("exceljs");
    const workbook = new Workbook();
    workbook.addWorksheet("Orders").addRows(rows);
    bytes = new Uint8Array(await workbook.xlsx.writeBuffer());
  }
  const buffer = new ArrayBuffer(bytes.byteLength);
  new Uint8Array(buffer).set(bytes);
  const input = { name: `orders.${format}`, arrayBuffer: async () => buffer };
  const value = client(false);
  value.fallback.mockImplementation(parseTabularFile);
  const fallback = await value.parse(input);
  const scope = { onmessage: undefined as unknown as (event: unknown) => Promise<void>, postMessage: jest.fn() };
  const workerSource = fs.readFileSync(path.join(process.cwd(), "packages/ui/src/resource-import/tabular-file-parser.worker.ts"), "utf8");
  const workerCode = ts.transpileModule(workerSource, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
  vm.runInNewContext(workerCode, { self: scope, exports: {}, require: () => ({ parseTabularFileBuffer }), ArrayBuffer });
  await scope.onmessage({ data: { fileName: input.name, buffer: await input.arrayBuffer() } });
  expect(scope.postMessage).toHaveBeenCalledWith({ ok: true, parsed: fallback });
  expect(fallback).toMatchObject({ totalRows: 49, rows: expect.any(Array) });
  expect((fallback as { rows: unknown[] }).rows).toHaveLength(20);
});

test("cancellation before parsing never creates a worker or reads the file", async () => {
  const value = client();
  const input = file();
  const abort = new AbortController();
  abort.abort();
  await expect(value.parse(input, undefined, abort.signal)).rejects.toMatchObject({ name: "AbortError" });
  expect(input.arrayBuffer).not.toHaveBeenCalled();
  expect(value.workers).toHaveLength(0);
  expect(value.fallback).not.toHaveBeenCalled();
});

test("cancellation during a buffer read never posts stale bytes and releases the worker", async () => {
  const value = client();
  const input = file();
  let finish!: (buffer: ArrayBuffer) => void;
  input.arrayBuffer.mockReturnValue(new Promise<ArrayBuffer>((resolve) => { finish = resolve; }));
  const abort = new AbortController();
  const pending = value.parse(input, undefined, abort.signal);
  abort.abort();
  finish(new ArrayBuffer(8));
  await expect(pending).rejects.toMatchObject({ name: "AbortError" });
  expect(value.workers[0].postMessage).not.toHaveBeenCalled();
  expect(value.workers[0].terminate).toHaveBeenCalledTimes(1);
  expect(value.fallback).not.toHaveBeenCalled();
});

test("a genuine validation error never falls back to main-thread parsing", async () => {
  const value = client();
  const pending = value.parse(file());
  await settleBufferRead();
  value.workers[0].onmessage?.({ data: { ok: false, error: "Legacy .xls unsupported" } });
  await expect(pending).rejects.toThrow("Legacy .xls unsupported");
  expect(value.fallback).not.toHaveBeenCalled();
  expect(value.workers[0].terminate).toHaveBeenCalledTimes(1);
});

test("cancellation and worker failure settle and release their worker", async () => {
  const value = client();
  const abort = new AbortController();
  const cancelled = value.parse(file(), undefined, abort.signal);
  await settleBufferRead();
  abort.abort();
  await expect(cancelled).rejects.toMatchObject({ name: "AbortError" });
  const failed = value.parse(file());
  await settleBufferRead();
  value.workers[1].onerror?.();
  await expect(failed).rejects.toThrow("worker failed");
  value.workers.forEach((worker) => expect(worker.terminate).toHaveBeenCalledTimes(1));
  expect(value.fallback).not.toHaveBeenCalled();
});

test("hung workers time out without a main-thread retry", async () => {
  jest.useFakeTimers();
  try {
    const value = client();
    const pending = value.parse(file());
    await settleBufferRead();
    jest.advanceTimersByTime(120_000);
    await expect(pending).rejects.toThrow("timed out");
    expect(value.workers[0].terminate).toHaveBeenCalledTimes(1);
    expect(value.fallback).not.toHaveBeenCalled();
  } finally {
    jest.useRealTimers();
  }
});

test("an unavailable-worker fallback discards a result cancelled while parsing", async () => {
  const value = client(false);
  let resolve!: (value: unknown) => void;
  value.fallback.mockReturnValue(new Promise((done) => { resolve = done; }));
  const abort = new AbortController();
  const pending = value.parse(file(), undefined, abort.signal);
  abort.abort();
  resolve({ rows: [{ private: "stale" }] });
  await expect(pending).rejects.toMatchObject({ name: "AbortError" });
  expect(value.workers).toHaveLength(0);
});
