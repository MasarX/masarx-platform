const { spawnSync } = require('node:child_process');
const { mkdtempSync, readFileSync, rmSync } = require('node:fs');
const { tmpdir } = require('node:os');
const { join, resolve } = require('node:path');
const { parse } = require('yaml');
const { checkPreview, renderPreview, EXIT } = require('../../../scripts/deploy/dev-label-render-probe.cjs');

const unavailableShape = ' renderer_shape=unavailable';
const unavailablePlatform = ' renderer_platform_code=unavailable renderer_platform_header_code=unavailable';
const unavailableMediaAndHandler = ' renderer_content_type=unavailable renderer_handler=unavailable';

test('DEV label renderer verification runs after Edge deploy independently of the app deploys', () => {
  const { jobs } = parse(readFileSync(resolve(__dirname, '../../../.github/workflows/deploy.yml'), 'utf8'));
  const probe = jobs['label-render-probe'];
  const command = 'node scripts/deploy/dev-label-render-probe.cjs';
  expect(probe.needs).toBe('database');
  expect(probe.environment.name).toBe('dev');
  expect(probe.if).toContain("github.ref == 'refs/heads/main'");
  expect(probe.if).toContain("needs.database.result == 'success'");
  expect(probe.if).toContain("needs.database.outputs.edge_deployed == 'true'");
  expect(probe['continue-on-error']).toBeUndefined();
  expect(probe.steps).toContainEqual(expect.objectContaining({ run: command }));
  expect(jobs.database.outputs.edge_deployed).toBe("${{ steps.deploy.outcome == 'success' }}");
  expect(jobs.database.steps).not.toContainEqual(expect.objectContaining({ run: command }));
  for (const name of ['console', 'portal', 'landing', 'ingress']) expect(jobs[name].needs).toBe('database');
  expect(jobs.summary.needs).toContain('label-render-probe');
});

test('DEV label probe reports a sanitized configuration failure in the job summary', () => {
  const dir = mkdtempSync(join(tmpdir(), 'label-probe-'));
  const summary = join(dir, 'summary');
  try {
    const script = resolve(__dirname, '../../../scripts/deploy/dev-label-render-probe.cjs');
    const result = spawnSync(process.execPath, [script], {
      encoding: 'utf8',
      env: { GITHUB_ACTIONS: 'false', GITHUB_STEP_SUMMARY: summary },
    });
    const line = `LABEL_PROBE_ERROR code=${EXIT.configuration}\n`;
    expect(result.status).toBe(EXIT.configuration);
    expect(result.stderr).toBe(line);
    expect(readFileSync(summary, 'utf8')).toBe(line);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('the DEV label probe requires HTTP 200, ok true and canonical base64 PDF bytes', () => {
  const pdf = Buffer.from('%PDF-1.7\n\n');
  const body = { ok: true, pdf_base64: pdf.toString('base64') };
  expect(checkPreview(200, body)).toEqual({ code: 0, pdfBytes: pdf.length });
  expect(checkPreview(201, body)).toEqual({ code: 17 });
  expect(checkPreview(503, body)).toEqual({ code: 17 });
  expect(checkPreview(200, null)).toEqual({ code: 18 });
  expect(checkPreview(200, { ...body, ok: 'true' })).toEqual({ code: 18 });
  for (const encoded of [null, '', body.pdf_base64 + '!', body.pdf_base64.replace(/=+$/, ''),
    Buffer.from('PDF-1.7').toString('base64'),
    Buffer.from([0xa5, 0xd0, 0xc4, 0xc6, 0xad]).toString('base64')]) {
    expect(checkPreview(200, { ...body, pdf_base64: encoded })).toEqual({ code: 19 });
  }
  expect(new Set(Object.values(EXIT)).size).toBe(Object.keys(EXIT).length);
});

test.each([
  [[null, 503, 200], 0, [1000, 2000], null],
  [[503, 502, 500], EXIT.renderStatus, [1000, 2000],
    'LABEL_PROBE_RENDER_ERROR status=500 renderer_code=unavailable renderer_class=unavailable'
      + unavailableShape + unavailablePlatform + unavailableMediaAndHandler],
  [[null, null, null], EXIT.renderNetwork, [1000, 2000], null],
  [[403], EXIT.renderStatus, [],
    'LABEL_PROBE_RENDER_ERROR status=403 renderer_code=auth_required renderer_class=unavailable'
      + ' renderer_shape=error' + unavailablePlatform + unavailableMediaAndHandler],
])('DEV label probe handles renderer results %j with code %i and waits %j', async (statuses, code, waits, diagnostic) => {
  const pdf = Buffer.from('%PDF-1.7\n\n');
  const send = jest.fn();
  const readError = jest.fn().mockResolvedValue({ error: { code: 'auth_required', message: 'fixture detail' } });
  for (const status of statuses) {
    if (status === null) send.mockRejectedValueOnce(new Error('fixture network failure'));
    else send.mockResolvedValueOnce({
      status,
      headers: new Headers(),
      json: status === 500 ? async () => { throw new SyntaxError('fixture response is not JSON'); } : readError,
      text: async () => JSON.stringify({ ok: true, pdf_base64: pdf.toString('base64') }),
    });
  }
  const wait = jest.fn().mockResolvedValue(undefined);
  const expected = code === 0 ? { code, pdfBytes: pdf.length } : { code };
  if (diagnostic) expected.diagnostic = diagnostic;
  await expect(renderPreview(send, wait)).resolves.toEqual(expected);
  expect(send).toHaveBeenCalledTimes(statuses.length);
  expect(wait.mock.calls).toEqual(waits.map(ms => [ms]));
  expect(readError).toHaveBeenCalledTimes(statuses.includes(403) ? 1 : 0);
});

test('DEV label probe reports only allowlisted renderer errors', async () => {
  const result = await renderPreview(async () => ({
    status: 400,
    headers: new Headers(),
    json: async () => ({ code: 'unknown_platform_code', error: { code: 'unknown_code', class: '42501', message: 'fixture detail' } }),
  }));
  expect(result).toEqual({
    code: EXIT.renderStatus,
    diagnostic: 'LABEL_PROBE_RENDER_ERROR status=400 renderer_code=unavailable renderer_class=unavailable'
      + ' renderer_shape=code,error' + unavailablePlatform + unavailableMediaAndHandler,
  });
});

test.each([
  ['config_missing', 'config_missing'],
  ['unknown', 'unknown'],
  ['42501', '42501'],
  ['42501\n', 'unavailable'],
  ['fixture detail', 'unavailable'],
  [42501, 'unavailable'],
  [undefined, 'unavailable'],
])('DEV label probe reports the safe class for %j', async (received, reported) => {
  const result = await renderPreview(async () => Response.json({
    error: { code: 'renderer_internal', class: received, message: 'fixture detail' },
  }, {
    status: 500,
    headers: {
      'sb-error-code': 'EDGE_FUNCTION_ERROR',
      'x-masarx-edge-function': 'label-renderer',
      'x-masarx-renderer-transport': '1',
    },
  }), async () => {});
  expect(result).toEqual({
    code: EXIT.renderStatus,
    diagnostic: `LABEL_PROBE_RENDER_ERROR status=500 renderer_code=renderer_internal renderer_class=${reported}`
      + ' renderer_shape=error renderer_platform_code=unavailable'
      + ' renderer_platform_header_code=EDGE_FUNCTION_ERROR renderer_content_type=application/json'
      + ' renderer_handler=present',
  });
});

test('DEV label probe reports the allowlisted class of a classified preview error', async () => {
  const result = await renderPreview(async () => Response.json({
    ok: false,
    error: { code: 'draft_not_found', class: '42501' },
  }, { status: 404 }));
  expect(result).toEqual({
    code: EXIT.renderStatus,
    diagnostic: 'LABEL_PROBE_RENDER_ERROR status=404 renderer_code=draft_not_found renderer_class=42501'
      + ' renderer_shape=error,ok' + unavailablePlatform
      + ' renderer_content_type=application/json renderer_handler=unavailable',
  });
});

test('DEV label probe distinguishes a platform JSON error from an application error', async () => {
  const result = await renderPreview(async () => new Response(JSON.stringify({
    message: 'fixture private detail', code: 'BOOT_ERROR',
  }), {
    status: 500,
    headers: {
      'content-type': 'Application/JSON; charset=utf-8',
      'sb-error-code': 'LOAD_FUNCTION_ERROR',
    },
  }), async () => {});
  expect(result).toEqual({
    code: EXIT.renderStatus,
    diagnostic: 'LABEL_PROBE_RENDER_ERROR status=500 renderer_code=unavailable renderer_class=unavailable'
      + ' renderer_shape=code,message renderer_platform_code=BOOT_ERROR'
      + ' renderer_platform_header_code=LOAD_FUNCTION_ERROR renderer_content_type=application/json'
      + ' renderer_handler=unavailable',
  });
});

test('DEV label probe retains platform header evidence when the body is not JSON', async () => {
  const result = await renderPreview(async () => new Response('<p>fixture private detail</p>', {
    status: 500,
    headers: { 'content-type': 'text/html; charset=utf-8', 'sb-error-code': 'LOAD_FUNCTION_ERROR' },
  }), async () => {});
  expect(result).toEqual({
    code: EXIT.renderStatus,
    diagnostic: 'LABEL_PROBE_RENDER_ERROR status=500 renderer_code=unavailable renderer_class=unavailable'
      + ' renderer_shape=unavailable renderer_platform_code=unavailable'
      + ' renderer_platform_header_code=LOAD_FUNCTION_ERROR renderer_content_type=text/html'
      + ' renderer_handler=unavailable',
  });
});

test.each([
  [null],
  ['fixture private detail'],
  [['fixture private detail']],
  [{}],
  [{ '': 'fixture private detail' }],
  [{ 'bad-key': 'fixture private detail' }],
  [{ ['a'.repeat(33)]: 'fixture private detail' }],
  [{ 'message\n': 'fixture private detail' }],
])('DEV label probe omits unsafe or absent JSON shape for %j', async (body) => {
  const result = await renderPreview(async () => new Response(JSON.stringify(body), {
    status: 400,
    headers: {
      'content-type': 'application/x-fixture; fixture=private',
      'sb-error-code': 'fixture private detail',
      'x-masarx-edge-function': 'label-renderer',
      'x-masarx-renderer-transport': 'fixture private detail',
    },
  }));
  expect(result).toEqual({
    code: EXIT.renderStatus,
    diagnostic: 'LABEL_PROBE_RENDER_ERROR status=400 renderer_code=unavailable renderer_class=unavailable'
      + unavailableShape + unavailablePlatform + unavailableMediaAndHandler,
  });
});
