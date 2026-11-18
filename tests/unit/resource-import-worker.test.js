const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { EventEmitter } = require('node:events');
const ts = require('typescript');
const { Workbook } = require('exceljs');

const root = path.resolve(__dirname, '../..');
function loadWorker(Worker) {
  const cache = new Map();
  function load(file) {
    const absolute = path.resolve(root, file);
    if (cache.has(absolute)) return cache.get(absolute);
    const module = { exports: {} }; cache.set(absolute, module.exports);
    const source = ts.transpileModule(fs.readFileSync(absolute, 'utf8'), {
      compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, esModuleInterop: true },
    }).outputText;
    vm.runInNewContext(source, { module, exports: module.exports, process, setTimeout, clearTimeout,
      require: (name) => name.includes('upload-limits') ? load('supabase/functions/resource-import-studio/upload-limits.ts')
        : name === 'node:worker_threads' && Worker ? { Worker } : require(name),
    });
    return module.exports;
  }
  return load('apps/shared/resource-import-worker.ts').parseUploadInWorker;
}
const arrayBuffer = (buffer) => buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength);
class FakeWorker extends EventEmitter {
  constructor(source, options) { super(); this.source = source; this.options = options; FakeWorker.current = this; }
  terminate = jest.fn(async () => 0);
}
afterEach(() => { jest.useRealTimers(); });

test('real worker preserves visible-sheet selection and parsed cell values', async () => {
  const workbook = new Workbook(); workbook.addWorksheet('Hidden', { state: 'hidden' }).addRow(['skip']);
  const sheet = workbook.addWorksheet('Visible'); sheet.addRow(['id', 'quantity']); sheet.addRow(['id-1', 7]);
  const result = await loadWorker()(arrayBuffer(await workbook.xlsx.writeBuffer()), 'xlsx', 'Hidden');
  expect(result).toEqual({ selectedSheet: 'Visible', visibleSheets: ['Visible'], headers: ['id', 'quantity'], rows: [{ id: 'id-1', quantity: '7' }] });
});

test('real worker matrix backstop rejects sparse dimensions before conversion', async () => {
  const workbook = new Workbook(); workbook.addWorksheet('Data').getCell('A10001').value = 'far';
  await expect(loadWorker()(arrayBuffer(await workbook.xlsx.writeBuffer()), 'xlsx')).rejects.toMatchObject({ status: 422, code: 'import_dimensions' });
});

test('worker has a fixed heap limit, data-only transfer and is terminated after success', async () => {
  const parse = loadWorker(FakeWorker); const bytes = new ArrayBuffer(1); const result = parse(bytes, 'xlsx', 'Data');
  const worker = FakeWorker.current;
  expect(worker.options.resourceLimits).toEqual({ maxOldGenerationSizeMb: 256, maxYoungGenerationSizeMb: 16 });
  expect(worker.options.execArgv).toEqual([]);
  expect(worker.options.env.NODE_OPTIONS).toBe('');
  expect(worker.options.transferList).toEqual([bytes]);
  expect(worker.options.workerData.bytes).toBe(bytes);
  expect(worker.source).not.toContain('untrusted-marker');
  const value = { headers: ['id'], rows: [], selectedSheet: 'Data', visibleSheets: ['Data'] };
  worker.emit('message', value); await expect(result).resolves.toEqual(value);
  expect(worker.terminate).toHaveBeenCalledTimes(1);
});

test('10-second timeout terminates the worker and returns a localized safe error', async () => {
  jest.useFakeTimers(); const result = loadWorker(FakeWorker) (new ArrayBuffer(1), 'xlsx');
  const rejection = expect(result).rejects.toMatchObject({ status: 422, code: 'import_resource_limit', message: expect.stringMatching(/[\u0600-\u06ff]/) });
  await jest.advanceTimersByTimeAsync(10_000); await rejection;
  expect(FakeWorker.current.terminate).toHaveBeenCalledTimes(1);
  expect(jest.getTimerCount()).toBe(0);
});

test.each(['error', 'exit'])('worker %s including heap exhaustion fails closed and cleans up', async (event) => {
  const result = loadWorker(FakeWorker) (new ArrayBuffer(1), 'xlsx');
  FakeWorker.current.emit(event, event === 'error' ? new Error('ERR_WORKER_OUT_OF_MEMORY: private-stack') : 1);
  await expect(result).rejects.toMatchObject({ status: 422, code: 'import_resource_limit' });
  expect(FakeWorker.current.terminate).toHaveBeenCalledTimes(1);
});

test('host V8 heap overrides fail closed before parsing a valid workbook', async () => {
  const { execFileSync } = require('node:child_process');
  const workbook = new Workbook(); workbook.addWorksheet('Data').addRow(['id']);
  const encoded = Buffer.from(await workbook.xlsx.writeBuffer()).toString('base64');
  const script = `const fs=require('node:fs'),path=require('node:path'),vm=require('node:vm'),ts=require('typescript');
    const root=${JSON.stringify(root)};
    ${loadWorker.toString()}
    const buffer=Buffer.from(${JSON.stringify(encoded)},'base64');
    loadWorker()(buffer.buffer.slice(buffer.byteOffset,buffer.byteOffset+buffer.byteLength), 'xlsx')
      .then(()=>{console.log('unexpected-success')},error=>{console.log(error.code)});`;
  expect(execFileSync(process.execPath, ['--max-old-space-size=512', '-e', script], {
    cwd: root, encoding: 'utf8', timeout: 15000,
  }).trim()).toBe('import_resource_limit');
});

test('real CSV worker uses the canonical streaming parser for quotes and values', async () => {
  const buffer = Buffer.from('id,note\r\n1,"one\nline"\r\n2,"a""b"\r\n');
  await expect(loadWorker()(arrayBuffer(buffer), 'csv')).resolves.toEqual({
    selectedSheet: 'Sheet1', visibleSheets: ['Sheet1'], headers: ['id', 'note'], rows: [{ id: '1', note: 'one\nline' }, { id: '2', note: 'a"b' }],
  });
});

test('shared strings cannot amplify the worker output beyond its bounded message', async () => {
  const workbook = new Workbook(); const sheet = workbook.addWorksheet('Data'); sheet.addRow(['id']);
  const value = 'x'.repeat(32767);
  for (let row = 0; row < 256; row++) sheet.addRow([value]);
  await expect(loadWorker()(arrayBuffer(await workbook.xlsx.writeBuffer()), 'xlsx'))
    .rejects.toMatchObject({ status: 422, code: 'import_resource_limit' });
});
