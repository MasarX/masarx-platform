const path = require('path');
const { build } = require('esbuild');

describe('tabular parser worker lifecycle', () => {
  let parseTabularFileWithWorker;
  const originalWorker = global.Worker;
  const workers = [];
  class WorkerDouble {
    constructor(url, options) { this.url = url; this.options = options; this.terminate = jest.fn();
      this.postMessage = jest.fn(); workers.push(this); }
  }
  beforeAll(async () => {
    const result = await build({
      entryPoints: [path.join(__dirname, '../../packages/ui/src/resource-import/tabular-file-parser-worker-client.ts')],
      bundle: true, write: false, platform: 'neutral', format: 'esm', target: 'es2022',
      define: { 'import.meta.url': JSON.stringify('https://console.example.test/parser-client.js') },
      // The main-thread parser (exceljs/jszip) is bundled by Next; stub it so this bundle stays browser-neutral.
      plugins: [{ name: 'main-thread-parser-stub', setup(stub) {
        stub.onResolve({ filter: /\/tabular-file$/ }, () => ({ path: 'main-thread-parser', namespace: 'stub' }));
        stub.onLoad({ filter: /.*/, namespace: 'stub' }, () => ({
          contents: 'export const parseTabularFile = (...args) => globalThis.__mainThreadParse(...args);', loader: 'js' }));
      } }],
    });
    ({ parseTabularFileWithWorker } = await import(
      `data:text/javascript;base64,${Buffer.from(result.outputFiles[0].text).toString('base64')}`));
  });
  beforeEach(() => { workers.length = 0; global.Worker = WorkerDouble; global.__mainThreadParse = jest.fn(); });
  afterEach(() => { global.Worker = originalWorker; delete global.__mainThreadParse; jest.useRealTimers(); });
  const settleBufferRead = async () => {
    for (let turn = 0; turn < 8; turn += 1) await Promise.resolve();
  };
  test('parses the chosen file and worksheet off-thread and terminates after success', async () => {
    const file = { name: 'import.xlsx', arrayBuffer: async () => new ArrayBuffer(0) };
    const promise = parseTabularFileWithWorker(file, 'Deliveries');
    await settleBufferRead();
    const worker = workers[0];
    expect(worker.url.href).toBe('https://console.example.test/tabular-file-parser.worker.ts');
    expect(worker.options).toEqual({ type: 'module' });
    expect(worker.postMessage).toHaveBeenCalledWith({ buffer: expect.any(ArrayBuffer), fileName: 'import.xlsx', preferredSheet: 'Deliveries' }, [expect.any(ArrayBuffer)]);
    const parsed = { format: 'xlsx', headers: ['tracking_number'], rows: [{ tracking_number: 'T1' }] };
    worker.onmessage({ data: { ok: true, parsed } });
    await expect(promise).resolves.toEqual(parsed);
    expect(worker.terminate).toHaveBeenCalledTimes(1);
  });
  test.each(['parse', 'crash', 'message'])('terminates and rejects on %s error', async (kind) => {
    const promise = parseTabularFileWithWorker({ name: 'bad.xlsx', arrayBuffer: async () => new ArrayBuffer(0) });
    const expected = expect(promise).rejects.toThrow(kind === 'parse' ? 'Unreadable worksheet' : /Unable to read|worker failed|unreadable/);
    await settleBufferRead();
    const worker = workers[0];
    if (kind === 'parse') worker.onmessage({ data: { ok: false, error: 'Unreadable worksheet' } });
    else if (kind === 'crash') worker.onerror({});
    else worker.onmessageerror({});
    await expected;
    expect(worker.terminate).toHaveBeenCalledTimes(1);
  });
  test('terminates if posting the file fails', async () => {
    global.Worker = class extends WorkerDouble {
      constructor(...args) { super(...args); this.postMessage.mockImplementation(() => { throw new Error('clone failed'); }); }
    };
    await expect(parseTabularFileWithWorker({ name: 'import.csv', arrayBuffer: async () => new ArrayBuffer(0) })).rejects.toThrow('clone failed');
    expect(workers[0].terminate).toHaveBeenCalledTimes(1);
  });
  test('bounds a hung parse and terminates its worker', async () => {
    jest.useFakeTimers();
    const promise = parseTabularFileWithWorker({ name: 'large.xlsx', arrayBuffer: async () => new ArrayBuffer(0) });
    const expected = expect(promise).rejects.toThrow('timed out');
    await settleBufferRead();
    await jest.advanceTimersByTimeAsync(120_000);
    await expected;
    expect(workers[0].terminate).toHaveBeenCalledTimes(1);
  });
  test('parses on the main thread only when workers are unavailable', async () => {
    global.Worker = undefined;
    const parsed = { format: 'csv', headers: [], rows: [] };
    global.__mainThreadParse.mockResolvedValue(parsed);
    const file = { name: 'import.csv', arrayBuffer: async () => new ArrayBuffer(0) };
    await expect(parseTabularFileWithWorker(file, 'Sheet1')).resolves.toBe(parsed);
    expect(global.__mainThreadParse).toHaveBeenCalledWith(file, 'Sheet1');
    expect(workers).toHaveLength(0);
  });
});
